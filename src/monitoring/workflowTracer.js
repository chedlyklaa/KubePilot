'use strict';

// ── WorkflowTracer ───────────────────────────────────────────────────────────────
// Request-scoped observability accumulator for one runWorkflow() invocation
// (src/orchestrator/graph.js). Passed through LangGraph's `config.configurable`, NOT
// a WorkflowState/Annotation channel — this keeps it out of the reducer-managed state
// a node might spread into a prompt (see e.g. investigator.js's HumanMessage built
// from raw issues/context), and gives every concurrent workflow its own instance:
// graph.js's runWorkflow() constructs a fresh WorkflowTracer per call, so the
// ISSUE_CONCURRENCY-bounded concurrent workflows (orchestratorAgent.js) never share
// mutable tracer state.
//
// Most of what this class records is already computed inside investigator.js's ring
// loop and planner.js's tool-calling loop as a side effect of their existing control
// flow (hypothesis/confidence history, ring/layer coverage, tool-call logs) — this
// class mostly HARVESTS and reshapes that via attachInvestigatorResult/
// attachPlannerResult, rather than re-instrumenting those loops from scratch.
//
// Never throws — a bug in tracing must not be able to break a remediation workflow.
// Every public method is defensive against missing/partial input for that reason.

class WorkflowTracer {
  constructor({
    workflowId, clusters = [], namespace = null, incidentType = null,
    complexity = 'UNKNOWN', issueKeys = [], pipeline = 'v5',
  } = {}) {
    this.workflowId   = workflowId ?? null;
    this.pipeline     = pipeline;
    this.clusters     = clusters;
    this.namespace    = namespace;
    this.incidentType = incidentType;
    this.complexity   = complexity;
    this.issueKeys    = issueKeys;

    this.startedAt = new Date();
    this.endedAt   = null;

    this.nodes        = {}; // nodeName -> { durationMs, llmCalls, toolCalls }
    this._nodeStarts  = {}; // nodeName -> Date.now() while in progress

    this.investigationTurns      = 0;
    this.ringsVisited            = [];
    this.layersInvestigated      = [];
    this.hypothesisHistory       = [];
    this.confidenceHistory       = [];
    this.reachedConfidenceTarget = null;

    // §Convergence (Phase 3)
    this.bestHypothesis        = null;
    this.nonImprovingRounds    = 0;
    this.stoppingOutcome       = null;
    this.informationGainHistory = [];

    this.plannerTurns                  = 0;
    this.plannerToInvestigatorRequests = 0; // gather_more_evidence tool calls
    this.plannerDryRunCalls            = 0; // dry_run_step tool calls

    this.fastPathUsed      = false;
    this.fastPathEscalated = null; // null = fast path never ran this workflow

    this.guardianRejections    = 0;
    this.policyRejections      = 0;
    this.humanApprovalRequests = 0;
    this.humanEscalations      = 0;

    this.finalOutcome = null;
  }

  _ensureNode(name) {
    if (!this.nodes[name]) this.nodes[name] = { durationMs: 0, llmCalls: 0, toolCalls: 0 };
    return this.nodes[name];
  }

  // ── Per-node timing ──────────────────────────────────────────────────────────
  // A node can legitimately run more than once per workflow (the investigator<->policy
  // re-diagnose loop, graph.js's routeAfterPolicy) — durationMs accumulates across
  // every visit rather than being overwritten, so latency_per_node reflects total time
  // spent in that node across the whole workflow, not just its last visit.
  startNode(name) { this._nodeStarts[name] = Date.now(); }

  endNode(name) {
    const start = this._nodeStarts[name];
    if (start == null) return;
    this._ensureNode(name).durationMs += Date.now() - start;
    delete this._nodeStarts[name];
  }

  // Harvests investigator.investigate()'s return value (src/agents/investigator.js) —
  // investigationTurns/ringsVisited/layersInvestigated/ringAssessmentLog are already
  // computed there; this just reshapes them for persistence.
  attachInvestigatorResult(rca) {
    if (!rca) return;
    const node = this._ensureNode('investigator');
    node.llmCalls  += rca.investigationTurns ?? 0;
    node.toolCalls += (rca.commandsExecuted ?? []).length;

    this.investigationTurns      = rca.investigationTurns ?? 0;
    this.ringsVisited            = rca.ringsVisited ?? [];
    this.layersInvestigated      = rca.layersInvestigated ?? [];
    this.reachedConfidenceTarget = rca.reachedConfidenceTarget ?? null;

    const log = rca.ringAssessmentLog ?? [];
    this.hypothesisHistory = log.map(a => ({
      ring: a.ring, iteration: a.iteration, hypothesis: a.rootCauseHypothesis,
      layer: a.rootCauseLayer, confidence: a.confidence, evidence: a.supportingEvidence,
    }));
    this.confidenceHistory = log.map(a => a.confidence);

    // §Convergence (Phase 3) — bestHypothesis/nonImprovingRounds/stoppingOutcome are
    // already computed inside investigator.js's loop; informationGainHistory is
    // reshaped from the same ringAssessmentLog entries this method already reads.
    this.bestHypothesis     = rca.bestHypothesis ?? null;
    this.nonImprovingRounds = rca.nonImprovingRounds ?? 0;
    this.stoppingOutcome    = rca.stoppingOutcome ?? null;
    this.informationGainHistory = log.map(a => a.informationGain ?? 'NONE');
  }

  // Harvests planner.plan()'s return value — see the `_meta` field added in
  // src/agents/planner.js's _runPlanningLoop.
  attachPlannerResult(plan) {
    if (!plan?._meta) return;
    const node = this._ensureNode('planner');
    const { turnsUsed = 0, toolCallLog = [] } = plan._meta;
    node.llmCalls  += turnsUsed;
    node.toolCalls += toolCallLog.length;

    this.plannerTurns                  = turnsUsed;
    this.plannerToInvestigatorRequests = toolCallLog.filter(c => c.name === 'gather_more_evidence').length;
    this.plannerDryRunCalls            = toolCallLog.filter(c => c.name === 'dry_run_step').length;
  }

  // Harvests fastPath.diagnose()'s return value (src/agents/fastPath.js). A "1 LLM
  // call" only actually happened if a diagnosis was produced — a gather-phase or
  // unknown-cluster failure escalates without ever reaching the diagnosis call.
  attachFastPathResult(result) {
    if (!result) return;
    this.fastPathUsed = true;
    this.fastPathEscalated = !!result.escalate;
    const node = this._ensureNode('fastPath');
    node.llmCalls  += result.diagnosis ? 1 : 0;
    node.toolCalls += result.toolCallCount ?? 0;
  }

  recordGuardianVerdict(verdict) {
    this._ensureNode('guardian').llmCalls += 1;
    if (verdict === 'REJECT') this.guardianRejections += 1;
  }

  recordPolicyResult(status) {
    if (status === 'rejected') this.policyRejections += 1;
  }

  recordApprovalRequest(count = 1) { this.humanApprovalRequests += count; }
  recordEscalation(count = 1)      { this.humanEscalations += count; }

  finalize(outcome) {
    this.endedAt = new Date();
    this.finalOutcome = outcome ?? null;
  }

  // Plain object matching WorkflowTraceSchema (src/db/models/history.js) — the only
  // place this shape needs to line up with the Mongoose schema.
  toDocument() {
    const totalLlmCalls  = Object.values(this.nodes).reduce((s, n) => s + n.llmCalls, 0);
    const totalToolCalls = Object.values(this.nodes).reduce((s, n) => s + n.toolCalls, 0);
    return {
      workflowId: this.workflowId,
      pipeline:   this.pipeline,
      issueKeys:  this.issueKeys,
      cluster:    this.clusters.join(','),
      namespace:  this.namespace,
      incidentType: this.incidentType,
      complexity: this.complexity,
      startedAt:  this.startedAt,
      endedAt:    this.endedAt,
      totalLatencyMs: this.endedAt ? this.endedAt.getTime() - this.startedAt.getTime() : null,
      nodes: this.nodes,
      totalLlmCalls,
      totalToolCalls,
      investigationTurns:      this.investigationTurns,
      ringsVisited:            this.ringsVisited,
      layersInvestigated:      this.layersInvestigated,
      hypothesisHistory:       this.hypothesisHistory,
      confidenceHistory:       this.confidenceHistory,
      reachedConfidenceTarget: this.reachedConfidenceTarget,
      bestHypothesis:          this.bestHypothesis,
      nonImprovingRounds:      this.nonImprovingRounds,
      stoppingOutcome:         this.stoppingOutcome,
      informationGainHistory:  this.informationGainHistory,
      plannerTurns:                  this.plannerTurns,
      plannerToInvestigatorRequests: this.plannerToInvestigatorRequests,
      plannerDryRunCalls:            this.plannerDryRunCalls,
      fastPathUsed:      this.fastPathUsed,
      fastPathEscalated: this.fastPathEscalated,
      guardianRejections:    this.guardianRejections,
      policyRejections:      this.policyRejections,
      humanApprovalRequests: this.humanApprovalRequests,
      humanEscalations:      this.humanEscalations,
      finalOutcome: this.finalOutcome,
    };
  }
}

module.exports = WorkflowTracer;

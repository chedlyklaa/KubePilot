'use strict';

// Collects metrics for one workflow run
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

    this.nodes        = {};
    this._nodeStarts  = {};

    this.investigationTurns      = 0;
    this.ringsVisited            = [];
    this.layersInvestigated      = [];
    this.hypothesisHistory       = [];
    this.confidenceHistory       = [];
    this.reachedConfidenceTarget = null;

    this.bestHypothesis        = null;
    this.nonImprovingRounds    = 0;
    this.stoppingOutcome       = null;
    this.informationGainHistory = [];

    this.plannerTurns                  = 0;
    this.plannerToInvestigatorRequests = 0;
    this.plannerDryRunCalls            = 0;

    this.fastPathUsed      = false;
    this.fastPathEscalated = null;

    this.guardianRejections    = 0;
    this.policyRejections      = 0;
    this.humanApprovalRequests = 0;
    this.humanEscalations      = 0;

    this.finalOutcome = null;

    this.tokenUsage = null;
  }

  attachTokenUsage(usage) { this.tokenUsage = usage ?? null; }

  _ensureNode(name) {
    if (!this.nodes[name]) this.nodes[name] = { durationMs: 0, llmCalls: 0, toolCalls: 0 };
    return this.nodes[name];
  }

  // Start timing a node
  startNode(name) { this._nodeStarts[name] = Date.now(); }

  endNode(name) {
    const start = this._nodeStarts[name];
    if (start == null) return;
    this._ensureNode(name).durationMs += Date.now() - start;
    delete this._nodeStarts[name];
  }

  // Save the investigator result
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

    this.bestHypothesis     = rca.bestHypothesis ?? null;
    this.nonImprovingRounds = rca.nonImprovingRounds ?? 0;
    this.stoppingOutcome    = rca.stoppingOutcome ?? null;
    this.informationGainHistory = log.map(a => a.informationGain ?? 'NONE');
  }

  // Save the planner result
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

  // Save the fast path result
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

  // Convert the trace to a document
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
      tokenUsage:            this.tokenUsage,
      finalOutcome: this.finalOutcome,
    };
  }
}

module.exports = WorkflowTracer;

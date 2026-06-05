'use strict';
require('dotenv').config({ override: true });

const kubectl          = require('../tools/kubectl');
const PodAnalyzer      = require('./podAnalyzer');
const GuardianAgent    = require('./guardianAgent');
const PlannerAgent     = require('./plannerAgent');
const ReflectionAgent  = require('./reflectionAgent');
const approvalStore    = require('../api/approvalStore');
const escalationStore  = require('../api/escalationStore');
const episodicMemory   = require('../memory/episodicMemory');
const vectorStore      = require('../memory/vectorStore');
const ruleEngine       = require('../memory/ruleEngine');
const temporal         = require('../memory/temporal');
const audit            = require('../audit/logger');
const RiskEngine       = require('../risk/engine');
const PolicyEngine     = require('../policy/policyEngine');
const metricsCollector = require('../monitoring/metricsCollector');

const riskEngine = new RiskEngine();

// Parse a Kubernetes memory quantity string (e.g. "128Mi", "1Gi", "512M") into MiB.
function _parseMiB(str) {
  if (!str) return 128;
  const num = parseFloat(str);
  if (isNaN(num)) return 128;
  if (/Gi$/i.test(str)) return Math.round(num * 1024);
  if (/G$/i.test(str))  return Math.round(num * 1000);
  if (/Mi$/i.test(str) || /M$/i.test(str)) return Math.round(num);
  if (/Ki$/i.test(str)) return Math.round(num / 1024);
  if (/k$/i.test(str))  return Math.round(num / 1000);
  return Math.round(num / (1024 * 1024)); // assume raw bytes
}

const HIGH_RISK_ACTIONS = new Set(['increase_memory']);

const ACTION_RISK_PARAMS = {
  restart:         { engineAction: 'restart_deployment', blastRadius: 2, reversibility: 0.9, costImpact: 0   },
  rollback:        { engineAction: 'apply_manifest',     blastRadius: 3, reversibility: 0.8, costImpact: 0   },
  delete_pod:      { engineAction: 'delete_pod',         blastRadius: 1, reversibility: 0.7, costImpact: 0   },
  scale_down:      { engineAction: 'scale_small',        blastRadius: 4, reversibility: 0.6, costImpact: 50  },
  increase_memory: { engineAction: 'scale_large',        blastRadius: 2, reversibility: 0.5, costImpact: 100 },
};

class ClusterAgent {
  constructor(clusterConfig) {
    this.name       = clusterConfig.name;
    this.context    = clusterConfig.context;
    this.tier       = clusterConfig.tier ?? 'dev';
    this.namespaces = clusterConfig.namespaces ?? ['default'];

    this.guardian     = new GuardianAgent(this.name, this.tier);
    this.policyEngine = new PolicyEngine();

    this.cooldowns        = new Map();  // issueKey → last attempt timestamp
    this.attemptCounts    = new Map();  // issueKey → number of failed attempts
    this.episodeTimelines = new Map();  // issueKey → { fingerprint, context, timeline[] }

    this.COOLDOWN_MS      = 45_000;
    this.VALIDATE_WAIT_MS = 30_000;
    this.MAX_FIX_ATTEMPTS = 3;
  }

  // ── Called once per cycle by orchestrator ─────────────────────────────────
  async run() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[${this.name}] Cycle started`);
    console.log(`${'='.repeat(50)}`);

    const allIssues = [];

    if (this.namespaces.includes('*')) {
      // Single call — discovers every namespace automatically
      try {
        const pods   = await kubectl.getPods('*', this.context, true);
        const issues = PodAnalyzer.extractIssues(pods).map(i => ({
          ...i,
          clusterName: this.name,
        }));
        allIssues.push(...issues);
      } catch (err) {
        console.error(`[${this.name}] kubectl failed (all-namespaces): ${err.message}`);
      }
    } else {
      for (const ns of this.namespaces) {
        let pods;
        try {
          pods = await kubectl.getPods(ns, this.context, true);
        } catch (err) {
          console.error(`[${this.name}] kubectl failed (${ns}): ${err.message}`);
          continue;
        }
        const issues = PodAnalyzer.extractIssues(pods).map(i => ({
          ...i,
          namespace:   i.namespace ?? ns,
          clusterName: this.name,
        }));
        allIssues.push(...issues);
      }
    }

    if (allIssues.length === 0) {
      console.log(`[${this.name}] All pods healthy`);
    } else {
      console.log(`[${this.name}] ${allIssues.length} issue(s) detected`);
      for (const issue of allIssues) {
        await this._handle(issue);
      }
    }

    console.log(`[${this.name}] Cycle complete\n`);
  }

  // ── 12-step self-improving pipeline ───────────────────────────────────────
  async _handle(issue) {
    const target = issue.deployment ?? issue.podName;
    const key    = `${issue.type}:${target}:${issue.namespace}`;

    const last = this.cooldowns.get(key);
    if (last && Date.now() - last < this.COOLDOWN_MS) {
      const wait = Math.round((this.COOLDOWN_MS - (Date.now() - last)) / 1000);
      console.log(`[${this.name}] [SKIP] ${key} — cooldown ${wait}s`);
      return;
    }

    const attempt = (this.attemptCounts.get(key) ?? 0) + 1;
    this.attemptCounts.set(key, attempt);

    // ── Build fingerprint (used by all memory layers) ─────────────────────────
    const fingerprint = {
      issueType:    issue.type,
      oomKilled:    issue.oomKilled    ?? false,
      exitCode:     issue.exitCode     ?? null,
      hasDeployment: !!issue.deployment,
      tier:         this.tier,
      imagePrefix:  '',
    };

    if (attempt > this.MAX_FIX_ATTEMPTS) {
      console.warn(`[${this.name}] [ESCALATE] ${key} — ${this.MAX_FIX_ATTEMPTS} attempts exhausted`);

      // Store the failed episode before escalating
      const epDraft = this.episodeTimelines.get(key);
      if (epDraft) {
        // Fetch fresh logs — stale logSnippet in epDraft.context is from attempt 1
        let escalationLogs = '';
        if (issue.podName) {
          try {
            escalationLogs = await kubectl.getLogs(issue.podName, issue.namespace ?? 'default', this.context);
          } catch { /* unavailable */ }
        }
        const reflection = await ReflectionAgent.reflect({
          issue,
          planAction:         epDraft.timeline.at(-1)?.action ?? 'unknown',
          rootCauseDiagnosis: epDraft.lastDiagnosis ?? 'unknown',
          timeline:           epDraft.timeline,
          resolved:           false,
          podLogs:            escalationLogs,
        });
        await episodicMemory.store({
          fingerprint,
          context:         epDraft.context,
          timeline:        epDraft.timeline,
          reflection,
          resolved:        false,
          resolvedAction:  null,
          totalAttempts:   attempt - 1,
          metricsSnapshot: epDraft.metricsSnapshot ?? null,
        });
        await ruleEngine.analyze(issue.type);
        this.episodeTimelines.delete(key);
      }

      const history = temporal.getClusterHistory(this.name)
        .filter(e => e.issue === issue.type)
        .slice(-this.MAX_FIX_ATTEMPTS);

      await escalationStore.escalate(key, issue, history);
      // Reset attempt counter so the agent keeps retrying next cycle.
      // Duplicate escalation records are suppressed by escalationStore.escalate().
      this.attemptCounts.delete(key);
      return;
    }

    console.log(`\n[${this.name}] ── ${key}  (attempt ${attempt}/${this.MAX_FIX_ATTEMPTS}) ──`);

    // ── Step 1: Fetch pod logs once — reused by planner, guardian, reflection ──
    let podLogs = '';
    if (issue.podName) {
      try {
        podLogs = await kubectl.getLogs(issue.podName, issue.namespace ?? 'default', this.context);
      } catch { /* logs unavailable — not critical */ }
    }

    // ── Step 1a: Collect Prometheus metrics (non-blocking, fails gracefully) ───
    let podMetrics = null;
    if (issue.podName && metricsCollector.isAvailable()) {
      try {
        podMetrics = await metricsCollector.collectPodMetrics(
          issue.namespace ?? 'default',
          issue.podName,
        );
      } catch { /* metrics unavailable */ }
    }

    // Pre-initialize the episode draft so metricsSnapshot is attached before the
    // first _recordTimelineEntry call (which may fire as early as policy rejection).
    if (!this.episodeTimelines.has(key)) {
      this.episodeTimelines.set(key, {
        fingerprint,
        context:         this._buildContext(issue, podLogs),
        timeline:        [],
        lastDiagnosis:   null,
        metricsSnapshot: podMetrics,
      });
    } else {
      // Refresh the snapshot every cycle so the stored episode has the latest reading.
      this.episodeTimelines.get(key).metricsSnapshot = podMetrics;
    }

    // ── Step 2: Retrieve similar past episodes from memory ────────────────────
    const structuralMatches = episodicMemory.findByFingerprint(fingerprint);
    const queryText         = vectorStore.issueToQueryText({ ...issue, tier: this.tier }, podLogs);
    const semanticMatches   = await episodicMemory.findSemantic(queryText);

    if (structuralMatches.length > 0) {
      console.log(`[${this.name}] [MEMORY] ${structuralMatches.length} structural match(es) retrieved`);
    }
    if (semanticMatches.length > 0) {
      console.log(`[${this.name}] [MEMORY] ${semanticMatches.length} semantic match(es) retrieved (top score: ${semanticMatches[0]?.score?.toFixed(3)})`);
    }

    // ── Step 3: Load learned rules for this issue type ────────────────────────
    const learnedRules = await ruleEngine.getRules(issue.type);
    if (learnedRules.length > 0) {
      console.log(`[${this.name}] [RULES] ${learnedRules.length} active rule(s) for ${issue.type}`);
    }

    // ── Step 4: Planner Agent generates an informed execution plan ────────────
    let diagnosis;
    try {
      diagnosis = await PlannerAgent.plan({
        issue,
        podLogs,
        structuralMatches,
        semanticMatches,
        learnedRules,
        attempt,
        metrics: podMetrics,
      });
    } catch (err) {
      console.error(`[${this.name}] [PLANNER] Error: ${err.message}`);
      this.cooldowns.set(key, Date.now());
      return;
    }

    // Normalize risk to uppercase so downstream === 'HIGH' comparisons are reliable
    // regardless of what case the LLM returned.
    if (diagnosis.risk) diagnosis.risk = diagnosis.risk.toUpperCase();

    console.log(`[${this.name}] [PLANNER] rootCause : ${diagnosis.rootCause}`);
    console.log(`[${this.name}] [PLANNER] action     : ${diagnosis.action}  risk=${diagnosis.risk}`);
    console.log(`[${this.name}] [PLANNER] rationale  : ${diagnosis.rationale}`);

    if (diagnosis.action === 'noop') {
      console.log(`[${this.name}] [PLANNER] No safe fix available`);
      temporal.add({ cluster: this.name, action: 'noop', status: 'skipped', issue: issue.type, riskScore: 0 });
      this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, null, 'skipped', 'planner returned noop — no safe fix available');
      this.cooldowns.set(key, Date.now());
      return;
    }

    // ── Step 5: PolicyEngine — deterministic non-bypassable safety gate ───────
    const policyPlan = {
      action: diagnosis.action,
      target: {
        kind:      issue.deployment ? 'deployment' : 'pod',
        name:      issue.deployment ?? issue.podName,
        namespace: issue.namespace ?? 'default',
      },
      reason: diagnosis.rootCause,
      risk:   diagnosis.risk,
    };
    const policyCtx = {
      cluster:          this.name,
      issueType:        issue.type,
      tier:             this.tier,
      deploymentExists: !!issue.deployment,
      exitCode:         issue.exitCode   ?? null,
      oomKilled:        issue.oomKilled  ?? false,
      attemptHistory:   this.episodeTimelines.get(key)?.timeline ?? [],
    };

    const policyResult = this.policyEngine.validate(policyPlan, policyCtx);
    console.log(`[${this.name}] [POLICY] status=${policyResult.status}  action=${policyResult.action}`);
    policyResult.warnings.forEach(w => console.warn(`[${this.name}] [POLICY] ⚠ ${w}`));

    if (policyResult.status === 'rejected') {
      // Don't count policy rejections as fix attempts — no remediation was ever applied.
      // Without this, a permanently-forbidden action exhausts MAX_FIX_ATTEMPTS and
      // fires a spurious escalation that looks like 3 failed fixes.
      this.attemptCounts.set(key, attempt - 1);
      console.error(`[${this.name}] [POLICY] BLOCKED — ${policyResult.reason}`);
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'blocked', issue: issue.type, riskScore: 0.9 });
      this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, null, 'blocked', `policy rejected: ${policyResult.reason}`);
      this.cooldowns.set(key, Date.now());
      return;
    }

    if (policyResult.status === 'modified') {
      console.warn(`[${this.name}] [POLICY] Action MODIFIED: ${diagnosis.action} → ${policyResult.action}`);
      diagnosis.action = policyResult.action;
      if (policyResult.action === 'noop') {
        // Policy reduced the action to noop (e.g. retry-protection, ImagePullBackOff, bare-pod
        // scale_down). Continuing would burn an attempt slot, run Guardian/risk engine, and
        // emit a spurious audit entry — all for an operation that does nothing.
        this.attemptCounts.set(key, attempt - 1);
        this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, null, 'skipped', `policy modified action to noop: ${policyResult.reason}`);
        this.cooldowns.set(key, Date.now());
        return;
      }
    }

    // Policy can escalate risk independently of LLM classification
    const riskOverride = this.policyEngine.evaluateRiskOverrides(
      { ...policyPlan, action: policyResult.action },
      policyCtx
    );
    if (riskOverride.forceApproval || riskOverride.risk !== (diagnosis.risk || '').toUpperCase()) {
      console.warn(`[${this.name}] [POLICY] Risk escalated: ${diagnosis.risk} → ${riskOverride.risk}  (${riskOverride.reason})`);
      diagnosis.risk = riskOverride.risk;
    }

    // ── Step 6: Guardian Agent reviews the plan ───────────────────────────────
    const guardian = await this.guardian.review({ issue, diagnosis, podLogs, attempt });

    console.log(`[${this.name}] [GUARDIAN] verdict=${guardian.verdict}  class=${guardian.classification}  confidence=${guardian.confidence?.toFixed(2)}`);
    console.log(`[${this.name}] [GUARDIAN] reason: ${guardian.reason}`);

    if (guardian.verdict === 'REJECT') {
      console.warn(`[${this.name}] [GUARDIAN] Action REJECTED — ${guardian.reason}`);
      audit.blocked({
        cluster:  this.name,
        agent:    this.name,
        action:   diagnosis.action,
        reason:   `Guardian rejected: ${guardian.reason}`,
        metadata: { issueKey: key, guardianClass: guardian.classification },
      });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'blocked', issue: issue.type, riskScore: 0.8 });
      this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, guardian, 'blocked', 'guardian rejected');
      this.cooldowns.set(key, Date.now());
      return;
    }

    if (guardian.verdict === 'MODIFY') {
      console.warn(`[${this.name}] [GUARDIAN] Action MODIFIED: ${diagnosis.action} → ${guardian.suggestedAction}`);
      diagnosis.action = guardian.suggestedAction;
    }

    if (guardian.classification === 'DANGEROUS') {
      console.warn(`[${this.name}] [GUARDIAN] DANGEROUS — forcing human approval gate`);
      diagnosis.risk = 'HIGH';
    }

    // ── Step 7: Risk engine — tier-aware score ────────────────────────────────
    const riskParams = ACTION_RISK_PARAMS[diagnosis.action];
    if (riskParams) {
      const engineResult = riskEngine.calculateRisk({
        action:        riskParams.engineAction,
        clusterTier:   this.tier,
        blastRadius:   riskParams.blastRadius,
        reversibility: riskParams.reversibility,
        llmConfidence: diagnosis.risk === 'LOW' ? 0.9 : diagnosis.risk === 'MEDIUM' ? 0.7 : 0.5,
        costImpact:    riskParams.costImpact,
      });
      console.log(`[${this.name}] [RISK] score=${engineResult.score}  engine=${engineResult.decision}  tier=${this.tier}`);

      if (engineResult.decision === 'BLOCK' && diagnosis.risk !== 'HIGH') {
        console.warn(`[${this.name}] [RISK] Engine overrides to HIGH`);
        diagnosis.risk = 'HIGH';
      }
    }

    // ── Step 8: Approval gate for high-risk actions ───────────────────────────
    if (HIGH_RISK_ACTIONS.has(diagnosis.action) || diagnosis.risk === 'HIGH') {
      console.log(`[${this.name}] [APPROVAL] High-risk — waiting for human decision…`);
      const approved = await approvalStore.requestApproval({ issue, diagnosis, issueKey: key, guardianNote: guardian.reason });
      if (!approved) {
        console.log(`[${this.name}] [APPROVAL] Denied — skipping`);
        audit.blocked({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: 'approval denied or timed out', metadata: { issueKey: key } });
        temporal.add({ cluster: this.name, action: diagnosis.action, status: 'blocked', issue: issue.type, riskScore: 1 });
        this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, guardian, 'blocked', 'approval denied');
        this.cooldowns.set(key, Date.now());
        return;
      }
      console.log(`[${this.name}] [APPROVAL] Approved — proceeding`);
    }

    // ── Step 9: Executor applies the fix ─────────────────────────────────────
    try {
      await this._applyFix(issue, diagnosis.action);
      console.log(`[${this.name}] [FIX] Applied: ${diagnosis.action} on ${target}`);
    } catch (err) {
      console.error(`[${this.name}] [FIX] Failed: ${err.message}`);
      audit.failure({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: err.message, metadata: { issueKey: key } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'failed', issue: issue.type, riskScore: 0.5 });
      this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, guardian, 'failed', err.message);
      this.cooldowns.set(key, Date.now());
      return;
    }

    // ── Step 10: Validate — did the fix work? ─────────────────────────────────
    console.log(`[${this.name}] [VALIDATE] Waiting ${this.VALIDATE_WAIT_MS / 1000}s…`);
    await new Promise(r => setTimeout(r, this.VALIDATE_WAIT_MS));

    const resolved = await this._validateFix(issue);

    if (resolved) {
      console.log(`[${this.name}] [RESOLVED] ${key} fixed after ${attempt} attempt(s)`);
      audit.success({ cluster: this.name, agent: this.name, action: diagnosis.action, metadata: { issueKey: key, attempt } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'success', issue: issue.type, riskScore: 0.2 });
    } else {
      console.log(`[${this.name}] [UNRESOLVED] Fix did not work — will retry next cycle`);
      audit.failure({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: 'validation failed — issue persists', metadata: { issueKey: key, attempt } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'failed', issue: issue.type, riskScore: 0.5 });
    }

    // Record this attempt in the episode timeline draft
    this._recordTimelineEntry(
      key, fingerprint, issue, podLogs, diagnosis, guardian,
      resolved ? 'success' : 'failed',
      resolved ? 'issue resolved' : 'issue persists after fix',
    );

    // ── Step 11: Reflection + episode persistence on resolution ──────────────
    if (resolved) {
      const epDraft = this.episodeTimelines.get(key);

      const reflection = await ReflectionAgent.reflect({
        issue,
        planAction:         diagnosis.action,
        rootCauseDiagnosis: diagnosis.rootCause,
        timeline:           epDraft?.timeline ?? [],
        resolved:           true,
        podLogs,
      });

      // ── Step 12: Store episode in MongoDB + Qdrant + extract rules ───────
      await episodicMemory.store({
        fingerprint,
        context:         epDraft?.context         ?? this._buildContext(issue, podLogs),
        timeline:        epDraft?.timeline         ?? [],
        reflection,
        resolved:        true,
        resolvedAction:  diagnosis.action,
        totalAttempts:   attempt,
        metricsSnapshot: epDraft?.metricsSnapshot  ?? null,
      });

      await ruleEngine.analyze(issue.type);

      const stats = episodicMemory.stats();
      console.log(`[${this.name}] [MEMORY] Index: ${stats.buckets} buckets, ${stats.episodes} episodes`);

      this.episodeTimelines.delete(key);
      this.attemptCounts.delete(key);
    }

    this.cooldowns.set(key, Date.now());
  }

  // ── Accumulate timeline entries across attempts ────────────────────────────
  _recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, guardian, outcome, note) {
    if (!this.episodeTimelines.has(key)) {
      this.episodeTimelines.set(key, {
        fingerprint,
        context:       this._buildContext(issue, podLogs),
        timeline:      [],
        lastDiagnosis: null,
      });
    }
    const draft = this.episodeTimelines.get(key);
    draft.timeline.push({
      action:         diagnosis.action,
      outcome,
      guardianVerdict: guardian?.verdict ?? null,
      note,
      at:             new Date(),
    });
    draft.lastDiagnosis = diagnosis.rootCause;
  }

  // ── Snapshot execution context at incident start ───────────────────────────
  _buildContext(issue, podLogs) {
    return {
      cluster:     this.name,
      namespace:   issue.namespace ?? 'default',
      deployment:  issue.deployment ?? null,
      pod:         issue.podName,
      restartCount: issue.restartCount ?? 0,
      logSnippet:  podLogs ? podLogs.slice(-500) : '',
    };
  }

  // ── Execute a kubectl command after sanitization ──────────────────────────
  // All direct kubectl.runCommand() calls go through here so the PolicyEngine
  // sanitizer and the dryRunMode flag are always applied.
  async _runSafeCommand(cmd) {
    const { safe, command, reason } = this.policyEngine.sanitizeCommand(cmd);
    if (!safe) throw new Error(`Command blocked by policy sanitizer: ${reason}`);
    if (this.policyEngine.dryRunMode) {
      console.log(`[${this.name}] [DRY-RUN] would execute: ${command}`);
      return '(dry-run)';
    }
    return kubectl.runCommand(command);
  }

  // ── Apply the chosen fix ───────────────────────────────────────────────────
  async _applyFix(issue, action) {
    const ns  = issue.namespace ?? 'default';
    const dep = issue.deployment;
    const pod = issue.podName;

    // Dry-run mode: log intent but skip all kubectl calls
    if (this.policyEngine.dryRunMode) {
      console.log(`[${this.name}] [DRY-RUN] Simulating "${action}" on ${dep ?? pod} (ns: ${ns})`);
      return;
    }

    switch (action) {
      case 'restart':
        if (!dep) throw new Error('restart requires a deployment');
        console.log(`[${this.name}] kubectl rollout restart deployment/${dep} -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} rollout restart deployment/${dep} -n ${ns}`
        );
        break;

      case 'rollback':
        if (!dep) throw new Error('rollback requires a deployment');
        console.log(`[${this.name}] kubectl rollout undo deployment/${dep} -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} rollout undo deployment/${dep} -n ${ns}`
        );
        break;

      case 'increase_memory': {
        if (!dep) throw new Error('increase_memory requires a deployment');
        // Read current memory limit so we increase from the real baseline, not a hardcoded 256Mi.
        // The GET is read-only so it bypasses the write sanitizer intentionally.
        let currentLimitMi = 128;
        try {
          const raw = await kubectl.runCommand(
            `kubectl --context=${this.context} get deployment/${dep} -n ${ns}` +
            ` -o jsonpath={.spec.template.spec.containers[0].resources.limits.memory}`
          );
          if (raw.trim()) currentLimitMi = _parseMiB(raw.trim());
        } catch { /* use fallback 128Mi */ }

        const newLimitMi   = Math.max(256, Math.ceil(currentLimitMi * 1.5));
        const newRequestMi = Math.ceil(newLimitMi * 0.5);
        console.log(`[${this.name}] memory ${currentLimitMi}Mi → ${newLimitMi}Mi (×1.5) for deployment/${dep} -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} set resources deployment/${dep}` +
          ` -n ${ns} --limits=memory=${newLimitMi}Mi --requests=memory=${newRequestMi}Mi`
        );
        break;
      }

      case 'delete_pod':
        if (!pod) throw new Error('delete_pod requires a pod name');
        console.log(`[${this.name}] kubectl delete pod ${pod} -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} delete pod ${pod} -n ${ns}`
        );
        break;

      case 'scale_down':
        // Policy (Rule 3a) rejects scale_down when deploymentExists is false, so dep should
        // always be set here. Throw rather than silently falling back to delete_pod, which
        // would execute a different action than what the risk/approval gates evaluated.
        if (!dep) throw new Error('scale_down requires a Deployment — bare pod scale is not supported');
        console.log(`[${this.name}] kubectl scale deployment/${dep} --replicas=1 -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} scale deployment/${dep} --replicas=1 -n ${ns}`
        );
        break;

      default:
        console.warn(`[${this.name}] Unknown action: ${action}`);
    }
  }

  // ── Re-check if issue is gone after fix ────────────────────────────────────
  async _validateFix(issue) {
    try {
      const pods   = await kubectl.getPods(issue.namespace, this.context, true);
      const issues = PodAnalyzer.extractIssues(pods);
      const match  = i =>
        i.type === issue.type &&
        (issue.deployment ? i.deployment === issue.deployment : i.podName === issue.podName);
      return !issues.some(match);
    } catch (err) {
      console.warn(`[${this.name}] [VALIDATE] Could not re-check: ${err.message}`);
      return false;
    }
  }
}

module.exports = ClusterAgent;

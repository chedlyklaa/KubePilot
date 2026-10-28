'use strict';
require('dotenv').config({ override: true });

const kubectl             = require('../tools/kubectl');
const PodAnalyzer         = require('./podAnalyzer');
const NodeAnalyzer        = require('./nodeAnalyzer');
const EventAnalyzer       = require('./eventAnalyzer');
const NodeHotspotCorrelator = require('./nodeHotspotCorrelator');
const ClusterAnalyzer     = require('./clusterAnalyzer');
const GuardianAgent       = require('./guardianAgent');
const PlannerAgent        = require('./plannerAgent');
const ReflectionAgent     = require('./reflectionAgent');
const InvestigatorAgent          = require('./investigatorAgent');
const ChangeCorrelationEngine    = require('./changeCorrelationEngine');
const CapacityForecastEngine     = require('./capacityForecastEngine');
const RbacDriftEngine            = require('./rbacDriftEngine');
const ConnectivityAlertEngine    = require('./connectivityAlertEngine');
const RbacPostureEngine          = require('./rbacPostureEngine');
const WorkloadHardeningEngine    = require('./workloadHardeningEngine');
const NetworkExposureEngine      = require('./networkExposureEngine');
const SecretsHygieneEngine       = require('./secretsHygieneEngine');
const approvalStore       = require('../api/approvalStore');
const escalationStore     = require('../api/escalationStore');
const issueTrackerStore   = require('../api/issueTrackerStore');
const episodicMemory      = require('../memory/episodicMemory');
const vectorStore         = require('../memory/vectorStore');
const ruleEngine          = require('../memory/ruleEngine');
const temporal            = require('../memory/temporal');
const audit               = require('../audit/logger');
const RiskEngine          = require('../risk/engine');
const PolicyEngine        = require('../policy/policyEngine');
const metricsCollector    = require('../monitoring/metricsCollector');
const silenceStore        = require('../api/silenceStore');
const { parseMiB: _parseMiB } = require('../utils/k8sQuantity');
const { ACTION_RISK_PARAMS }  = require('../policy/actionRiskParams');

const riskEngine = new RiskEngine();

// Check memory headroom in a namespace quota
function _hasMemoryHeadroom(namespace, resourceQuotas) {
  if (!resourceQuotas) return null;
  const nsQuotas = resourceQuotas.filter(q => q.metadata?.namespace === namespace);
  if (!nsQuotas.length) return null;

  for (const q of nsQuotas) {
    const hard = q.status?.hard ?? {};
    const used = q.status?.used ?? {};
    for (const key of ['requests.memory', 'limits.memory', 'memory']) {
      if (hard[key] == null || used[key] == null) continue;
      const hardMiB = _parseMiB(hard[key]);
      const usedMiB = _parseMiB(used[key]);
      if (!hardMiB) continue;
      if (usedMiB / hardMiB >= 0.98) return false;
    }
  }
  return true;
}

// Find PDBs that allow no disruptions
function _findZeroDisruptionPDBs(namespaces, pdbs) {
  if (!pdbs || !namespaces?.length) return [];
  const nsSet = new Set(namespaces);
  return pdbs.filter(p => nsSet.has(p.metadata?.namespace) && (p.status?.disruptionsAllowed ?? 1) === 0);
}

const HIGH_RISK_ACTIONS = new Set(['increase_memory', 'drain_node']);

class ClusterAgent {
  constructor(clusterConfig) {
    this.name        = clusterConfig.name;
    this.context     = clusterConfig.context;
    this.tier        = clusterConfig.tier ?? 'dev';
    this.namespaces  = clusterConfig.namespaces ?? ['default'];
    this.criticality = clusterConfig.criticality ?? null;

    this.guardian     = new GuardianAgent(this.name, this.tier);
    this.policyEngine = new PolicyEngine();

    this.cooldowns        = new Map();
    this.attemptCounts    = new Map();
    this.episodeTimelines = new Map();

    this._running = false;
    this._resourceLocks = new Map();
    this.ISSUE_CONCURRENCY = parseInt(process.env.ISSUE_CONCURRENCY || '3', 10);

    this.nodeHistory      = {};
    this.nodeDrainAttempts = new Map();

    this.COOLDOWN_MS      = 45_000;
    this.MAX_FIX_ATTEMPTS = 3;
  }

  // Run one cycle
  async run() {
    if (this._running) {
      console.log(`[${this.name}] [SKIP] Previous cycle still running — skipping this tick`);
      return;
    }
    this._running = true;
    try {
      await this._runCycle();
    } finally {
      this._running = false;
    }
  }

  async _runCycle() {
    const cycleStartedAt = new Date();
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[${this.name}] Cycle started`);
    console.log(`${'='.repeat(50)}`);

    let podsJson          = null;
    let nodesJson         = null;
    let eventsJson        = null;
    let allNodeMetrics    = null;
    let allPodMetrics     = null;
    let resourceQuotas = null;
    let pdbs           = null;

    const policyAware = process.env.POLICY_AWARENESS_ENABLED === 'true';

    const fetches = [
      kubectl.getPods('*', this.context, true),
      kubectl.getNodes(this.context),
      kubectl.getEvents(this.context),
      metricsCollector.collectAllNodesMetrics(),
      metricsCollector.collectAllPodsMetrics(),
    ];
    if (policyAware) {
      fetches.push(kubectl.getResourceQuotas('*', this.context), kubectl.getPodDisruptionBudgets('*', this.context));
    }

    const [podsResult, nodesResult, eventsResult, nodeMetricsResult, podMetricsResult, quotasResult, pdbsResult] =
      await Promise.allSettled(fetches);

    if (podsResult.status  === 'fulfilled') podsJson       = podsResult.value;
    else console.error(`[${this.name}] kubectl get pods failed: ${podsResult.reason?.message}`);

    if (nodesResult.status === 'fulfilled') nodesJson      = nodesResult.value;
    else console.warn(`[${this.name}] kubectl get nodes failed: ${nodesResult.reason?.message}`);

    if (eventsResult.status === 'fulfilled') eventsJson    = eventsResult.value;
    else console.warn(`[${this.name}] kubectl get events failed: ${eventsResult.reason?.message}`);

    if (nodeMetricsResult.status === 'fulfilled') allNodeMetrics = nodeMetricsResult.value;
    if (podMetricsResult.status  === 'fulfilled') allPodMetrics  = podMetricsResult.value;

    if (policyAware) {
      if (quotasResult?.status === 'fulfilled') resourceQuotas = quotasResult.value;
      else if (quotasResult)   console.warn(`[${this.name}] kubectl get resourcequota failed: ${quotasResult.reason?.message}`);

      if (pdbsResult?.status === 'fulfilled') pdbs = pdbsResult.value;
      else if (pdbsResult)     console.warn(`[${this.name}] kubectl get pdb failed: ${pdbsResult.reason?.message}`);
    }

    if (process.env.CONNECTIVITY_ALERTS_ENABLED === 'true') {
      const unreachable = podsResult.status === 'rejected'
        && nodesResult.status === 'rejected'
        && eventsResult.status === 'rejected';
      ConnectivityAlertEngine.check(this.name, unreachable)
        .catch(err => console.warn(`[${this.name}] [CONNECTIVITY] Non-blocking error: ${err.message}`));
    }

    const allPodIssues = [];
    if (podsJson) {
      if (this.namespaces.includes('*')) {
        const issues = PodAnalyzer.extractIssues(podsJson).map(i => ({ ...i, clusterName: this.name }));
        allPodIssues.push(...issues);
      } else {
        const filtered = { ...podsJson, items: (podsJson.items ?? []).filter(p => this.namespaces.includes(p.metadata?.namespace)) };
        const issues   = PodAnalyzer.extractIssues(filtered).map(i => ({ ...i, clusterName: this.name }));
        allPodIssues.push(...issues);
      }
    }

    const allNodeIssues = [];
    if (nodesJson) {
      const nodeIssues = NodeAnalyzer.extractIssues(nodesJson, this.nodeHistory, allNodeMetrics ?? {});
      allNodeIssues.push(...nodeIssues.map(n => ({ ...n, clusterName: this.name })));
      if (allNodeIssues.length) console.log(`[${this.name}] ${allNodeIssues.length} node issue(s) detected`);
    }

    const events = eventsJson ? EventAnalyzer.extractEvents(eventsJson) : [];
    if (events.length) console.log(`[${this.name}] ${events.length} warning event(s)`);

    const correlation = NodeHotspotCorrelator.correlate(allPodIssues, allNodeIssues, podsJson ?? { items: [] }, events);
    if (correlation.hotNodes.length) {
      console.log(`[${this.name}] [CORRELATION] ${correlation.hotNodes.length} hot node(s): ${correlation.hotNodes.map(h => h.nodeName).join(', ')}`);
    }

    const annotatedPodIssues = podsJson
      ? NodeHotspotCorrelator.annotatePodIssues(allPodIssues, podsJson)
      : allPodIssues;

    const { clusterIssues, summary } = ClusterAnalyzer.analyze({
      podIssues:   annotatedPodIssues,
      nodeIssues:  allNodeIssues,
      correlation,
      events,
      clusterName: this.name,
    });
    if (clusterIssues.length) {
      console.log(`[${this.name}] [CLUSTER] ${summary}`);
    }

    const nodeMap = nodesJson ? NodeAnalyzer.buildNodeMap(nodesJson) : {};

    await temporal.initialize();
    const riskPattern = temporal.detectRiskPattern();
    if (riskPattern.requiresHumanAttention) {
      console.warn(`[${this.name}] [TEMPORAL] ${riskPattern.highRiskCount} high-risk events in session — human attention recommended`);
    }

    for (const nodeIssue of allNodeIssues) {
      await this._handleNodeIssue(nodeIssue, {
        allNodeMetrics, correlation, events, nodeMap, pdbs,
        affectedPods: correlation.issuesByNode[nodeIssue.nodeName] ?? [],
      });
    }

    if (annotatedPodIssues.length === 0) {
      console.log(`[${this.name}] All pods healthy`);
    } else {
      console.log(`[${this.name}] ${annotatedPodIssues.length} pod issue(s) detected`);

      const issueQueue = annotatedPodIssues.map(issue => {
        const podNodeIssues  = issue.nodeName
          ? allNodeIssues.filter(n => n.nodeName === issue.nodeName)
          : [];
        const podNodeMetrics = issue.nodeName && allNodeMetrics
          ? allNodeMetrics[issue.nodeName] ?? null
          : null;
        const corrFindings   = correlation.findings.filter(f =>
          f.nodeName === issue.nodeName || f.level === 'cluster'
        );
        return { issue, ctx: {
          nodeIssues: podNodeIssues, nodeMetrics: podNodeMetrics, events,
          correlationFindings: corrFindings, clusterFindings: clusterIssues,
          eventsJson: eventsJson ?? { items: [] }, cycleStartedAt, resourceQuotas,
        }};
      });

      await this._processIssuePool(issueQueue);
    }

    if (process.env.CAPACITY_FORECAST_ENABLED === 'true') {
      const hpas = await kubectl.getHPAs('*', this.context)
        .then(items => items.map(h => ({
          namespace:       h.metadata?.namespace,
          currentReplicas: h.status?.currentReplicas ?? 0,
          maxReplicas:     h.spec?.maxReplicas ?? 0,
        })))
        .catch(() => null);

      CapacityForecastEngine.snapshotAndForecast({
        cluster:        this.name,
        allNodeMetrics: allNodeMetrics ?? {},
        allPodMetrics:  allPodMetrics  ?? {},
        hpas,
      }).catch(err => console.warn(`[${this.name}] [CAPACITY] Non-blocking error: ${err.message}`));
    }

    if (process.env.RBAC_DRIFT_ENABLED === 'true') {
      RbacDriftEngine.checkDrift({ cluster: this.name, context: this.context })
        .catch(err => console.warn(`[${this.name}] [RBAC-DRIFT] Non-blocking error: ${err.message}`));
    }

    if (process.env.RBAC_POSTURE_ENABLED === 'true') {
      RbacPostureEngine.check({ cluster: this.name, context: this.context })
        .catch(err => console.warn(`[${this.name}] [RBAC-POSTURE] Non-blocking error: ${err.message}`));
    }

    if (process.env.WORKLOAD_HARDENING_ENABLED === 'true') {
      WorkloadHardeningEngine.check({ cluster: this.name, context: this.context })
        .catch(err => console.warn(`[${this.name}] [WORKLOAD-HARDENING] Non-blocking error: ${err.message}`));
    }

    if (process.env.NETWORK_EXPOSURE_ENABLED === 'true') {
      NetworkExposureEngine.check({ cluster: this.name, context: this.context })
        .catch(err => console.warn(`[${this.name}] [NETWORK-EXPOSURE] Non-blocking error: ${err.message}`));
    }

    if (process.env.SECRETS_HYGIENE_ENABLED === 'true') {
      SecretsHygieneEngine.check({ cluster: this.name, context: this.context })
        .catch(err => console.warn(`[${this.name}] [SECRETS-HYGIENE] Non-blocking error: ${err.message}`));
    }

    console.log(`[${this.name}] Cycle complete\n`);
  }

  // Process issues with a concurrency limit
  async _processIssuePool(items) {
    const queue = [...items];
    const running = new Set();
    const self = this;

    return new Promise(resolve => {
      function next() {
        if (queue.length === 0 && running.size === 0) return resolve();
        while (queue.length > 0 && running.size < self.ISSUE_CONCURRENCY) {
          const { issue, ctx } = queue.shift();
          const resourceKey = `${issue.namespace}/${issue.deployment ?? issue.podName}`;

          if (self._resourceLocks.has(resourceKey)) {
            console.log(`[${self.name}] [POOL] Skipping ${resourceKey} — already being handled`);
            next();
            continue;
          }

          self._resourceLocks.set(resourceKey, true);
          const p = self._handle(issue, ctx)
            .catch(err => console.error(`[${self.name}] [POOL] ${resourceKey} failed: ${err.message}`))
            .finally(() => {
              self._resourceLocks.delete(resourceKey);
              running.delete(p);
              next();
            });
          running.add(p);
        }
      }
      next();
    });
  }

  // Handle one pod issue
  async _handle(issue, nodeCtx = {}) {
    const target = issue.controllerName ?? issue.deployment ?? issue.podName;
    const key    = `${issue.type}:${target}:${issue.namespace}`;

    const last = this.cooldowns.get(key);
    if (last && Date.now() - last < this.COOLDOWN_MS) {
      const wait = Math.round((this.COOLDOWN_MS - (Date.now() - last)) / 1000);
      console.log(`[${this.name}] [SKIP] ${key} — cooldown ${wait}s`);
      return;
    }

    if (silenceStore.isSilenced(key)) {
      const active  = silenceStore.getAll().find(s => s.key === key);
      const remaining = active ? Math.ceil((active.until - Date.now()) / 60000) : '?';
      console.log(`[${this.name}] [SILENCED] ${key} — suppressed for ~${remaining}m more`);
      return;
    }

    const attempt = (this.attemptCounts.get(key) ?? 0) + 1;
    this.attemptCounts.set(key, attempt);

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

      const epDraft = this.episodeTimelines.get(key);
      if (epDraft) {
        let escalationLogs = '';
        if (issue.podName) {
          try {
            escalationLogs = await kubectl.getLogs(issue.podName, issue.namespace ?? 'default', this.context);
          } catch { }
        }
        const reflection = await ReflectionAgent.reflect({
          issue,
          planAction:         epDraft.timeline.at(-1)?.action ?? 'unknown',
          rootCauseDiagnosis: epDraft.lastDiagnosis ?? 'unknown',
          timeline:           epDraft.timeline,
          resolved:           false,
          podLogs:            escalationLogs,
          rca:                epDraft.rca ?? null,
        });
        await episodicMemory.store({
          fingerprint,
          context:               epDraft.context,
          timeline:              epDraft.timeline,
          reflection,
          resolved:              false,
          resolvedAction:        null,
          totalAttempts:         attempt - 1,
          metricsSnapshot:       epDraft.metricsSnapshot ?? null,
          rca:                   epDraft.rca ?? undefined,
          guardianClassification: epDraft.guardianClassification ?? null,
        });
        await ruleEngine.analyze(issue.type);
        this.episodeTimelines.delete(key);
      }

      const history = temporal.getClusterHistory(this.name)
        .filter(e => e.issue === issue.type)
        .slice(-this.MAX_FIX_ATTEMPTS);

      await escalationStore.escalate(key, issue, history, epDraft?.rca ?? null);
      issueTrackerStore.track(key, {
        stage: 'escalated', cluster: this.name, tier: this.tier, issue,
        note: `escalated after ${this.MAX_FIX_ATTEMPTS} failed attempt(s)`,
      });
      this.attemptCounts.delete(key);
      return;
    }

    console.log(`\n[${this.name}] ── ${key}  (attempt ${attempt}/${this.MAX_FIX_ATTEMPTS}) ──`);

    if (temporal.detectRepeatedFailures(issue.type)) {
      console.warn(`[${this.name}] [TEMPORAL] Repeated failures for ${issue.type} detected in session — exercising extra caution`);
    }

    let podLogs = '';
    if (issue.podName) {
      try {
        podLogs = await kubectl.getLogs(issue.podName, issue.namespace ?? 'default', this.context);
      } catch { }
    }

    let podMetrics = null;
    if (issue.podName && metricsCollector.isAvailable()) {
      try {
        podMetrics = await metricsCollector.collectPodMetrics(
          issue.namespace ?? 'default',
          issue.podName,
        );
      } catch { }
    }

    const evidenceAssessment = this._assessEvidenceSufficiency(
      issue, podLogs, podMetrics, nodeCtx.events ?? [], attempt
    );
    let investigationArtifacts = null;
    if (evidenceAssessment.needsInvestigation) {
      const t0inv = Date.now();
      console.log(
        `[${this.name}] [INVESTIGATE] mode=${evidenceAssessment.mode}` +
        `  reasons=[${evidenceAssessment.reasons.join(',')}]` +
        `  confidence=${evidenceAssessment.confidence}`
      );
      investigationArtifacts = await this._enrichEvidence(issue, podLogs);
      const inv = investigationArtifacts;
      if (inv.previousLogs)   console.log(`[${this.name}] [INVESTIGATE] previous-logs:    ${inv.previousLogs.length}c`);
      if (inv.describeEvents) console.log(`[${this.name}] [INVESTIGATE] describe-events:  ${inv.describeEvents.length}c`);
      if (inv.rolloutHistory) console.log(`[${this.name}] [INVESTIGATE] rollout-history:  ${inv.rolloutHistory.length}c`);
      console.log(`[${this.name}] [INVESTIGATE] enrichment complete  ${Date.now() - t0inv}ms`);
    }

    if (!this.episodeTimelines.has(key)) {
      this.episodeTimelines.set(key, {
        fingerprint,
        context:         this._buildContext(issue, podLogs),
        timeline:        [],
        lastDiagnosis:   null,
        metricsSnapshot: podMetrics,
      });
      issueTrackerStore.track(key, {
        stage: 'detected', cluster: this.name, tier: this.tier, issue, fingerprint,
        note: `${issue.type} detected on ${target}`,
      });
    } else {
      this.episodeTimelines.get(key).metricsSnapshot = podMetrics;
    }
    if (investigationArtifacts) {
      this.episodeTimelines.get(key).context.investigationArtifacts = investigationArtifacts;
    }

    const structuralMatches = episodicMemory.findByFingerprint(fingerprint);
    const queryText         = vectorStore.issueToQueryText({ ...issue, tier: this.tier }, podLogs);
    const semanticMatches   = await episodicMemory.findSemantic(queryText);

    if (structuralMatches.length > 0) {
      console.log(`[${this.name}] [MEMORY] ${structuralMatches.length} structural match(es) retrieved`);
    }
    if (semanticMatches.length > 0) {
      console.log(`[${this.name}] [MEMORY] ${semanticMatches.length} semantic match(es) retrieved (top score: ${semanticMatches[0]?.score?.toFixed(3)})`);
    }

    const learnedRules = await ruleEngine.getRules(issue.type);
    if (learnedRules.length > 0) {
      console.log(`[${this.name}] [RULES] ${learnedRules.length} active rule(s) for ${issue.type}`);
    }

    const [rca, changeCorrelation] = await Promise.all([
      InvestigatorAgent.investigate(issue, this.name, this.context),
      ChangeCorrelationEngine.correlate({
        issue,
        detectedAt:     nodeCtx.cycleStartedAt ?? new Date(),
        eventsJson:     nodeCtx.eventsJson     ?? { items: [] },
        podMetrics,
        semanticMatches,
        nodeIssues:     nodeCtx.nodeIssues     ?? [],
        rolloutHistory: investigationArtifacts?.rolloutHistory ?? null,
      }),
    ]);
    if (rca) {
      this.episodeTimelines.get(key).rca = rca;
      issueTrackerStore.track(key, {
        stage: 'investigated', cluster: this.name, tier: this.tier, issue, rca,
        note: rca.suspected_cause ? `suspected cause: ${rca.suspected_cause}` : 'investigation complete',
      });
    }
    if (changeCorrelation) {
      console.log(`[${this.name}] [CHANGE] ${changeCorrelation.triggerType} "${changeCorrelation.triggerResource}" conf=${changeCorrelation.confidence.toFixed(2)}`);
    }

    let diagnosis;
    try {
      diagnosis = await PlannerAgent.plan({
        issue,
        podLogs,
        structuralMatches,
        semanticMatches,
        learnedRules,
        attempt,
        metrics:             podMetrics,
        nodeMetrics:         nodeCtx.nodeMetrics         ?? null,
        nodeIssues:          nodeCtx.nodeIssues          ?? [],
        events:              nodeCtx.events              ?? [],
        correlationFindings: nodeCtx.correlationFindings ?? [],
        clusterFindings:     nodeCtx.clusterFindings     ?? [],
        investigationContext: evidenceAssessment.needsInvestigation
          ? { mode: evidenceAssessment.mode, reasons: evidenceAssessment.reasons,
              confidence: evidenceAssessment.confidence, ...investigationArtifacts }
          : null,
        rca,
        changeCorrelation,
        capacityForecast:    await CapacityForecastEngine.getPodForecast(this.name, issue.podName).catch(() => null),
      });
    } catch (err) {
      console.error(`[${this.name}] [PLANNER] Error: ${err.message}`);
      this.cooldowns.set(key, Date.now());
      return;
    }

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
      cluster:           this.name,
      issueType:         issue.type,
      tier:              this.tier,
      criticality:       this.criticality ?? null,
      deploymentExists:  !!issue.deployment,
      hasController:     !!issue.controllerName,
      ownerKind:         issue.ownerKind ?? null,
      exitCode:          issue.exitCode   ?? null,
      oomKilled:         issue.oomKilled  ?? false,
      attemptHistory:    this.episodeTimelines.get(key)?.timeline ?? [],
      recentDeployment:  !!changeCorrelation,
      hasMemoryHeadroom: _hasMemoryHeadroom(issue.namespace ?? 'default', nodeCtx.resourceQuotas),
    };

    const policyResult = this.policyEngine.validate(policyPlan, policyCtx);
    console.log(`[${this.name}] [POLICY] status=${policyResult.status}  action=${policyResult.action}`);
    policyResult.warnings.forEach(w => console.warn(`[${this.name}] [POLICY] ⚠ ${w}`));

    if (policyResult.status === 'rejected') {
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
        this.attemptCounts.set(key, attempt - 1);
        this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, null, 'skipped', `policy modified action to noop: ${policyResult.reason}`);
        this.cooldowns.set(key, Date.now());
        return;
      }
    }

    const riskOverride = this.policyEngine.evaluateRiskOverrides(
      { ...policyPlan, action: policyResult.action },
      policyCtx
    );
    if (riskOverride.forceApproval || riskOverride.risk !== (diagnosis.risk || '').toUpperCase()) {
      console.warn(`[${this.name}] [POLICY] Risk escalated: ${diagnosis.risk} → ${riskOverride.risk}  (${riskOverride.reason})`);
      diagnosis.risk = riskOverride.risk;
    }

    const guardian = await this.guardian.review({ issue, diagnosis, podLogs, attempt, rca });

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

    if (guardian.verdict === 'DELEGATE_HUMAN') {
      console.warn(`[${this.name}] [GUARDIAN] DELEGATE_HUMAN — ${guardian.reason}`);
      audit.blocked({
        cluster:  this.name,
        agent:    this.name,
        action:   diagnosis.action,
        reason:   `Guardian delegated to human: ${guardian.reason}`,
        metadata: { issueKey: key, guardianClass: guardian.classification },
      });
      await escalationStore.escalate(key, issue, [], rca ?? null);
      issueTrackerStore.track(key, { stage: 'escalated', cluster: this.name, tier: this.tier, issue, note: `Guardian delegated to human: ${guardian.reason}` });
      this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, guardian, 'escalated', 'guardian delegated to human');
      this.cooldowns.set(key, Date.now());
      return;
    }

    if (guardian.verdict === 'MODIFY') {
      console.warn(`[${this.name}] [GUARDIAN] Action MODIFIED: ${diagnosis.action} → ${guardian.suggestedCommand}`);
      diagnosis.action = guardian.suggestedCommand;
    }

    if (guardian.classification === 'DANGEROUS') {
      console.warn(`[${this.name}] [GUARDIAN] DANGEROUS — forcing human approval gate`);
      diagnosis.risk = 'HIGH';
    }

    if (this.episodeTimelines.has(key)) {
      this.episodeTimelines.get(key).guardianClassification = guardian.classification;
    }

    if (
      evidenceAssessment.confidence === 'low' &&
      guardian.classification === 'RISKY' &&
      diagnosis.risk !== 'HIGH'
    ) {
      console.warn(`[${this.name}] [UNCERTAIN] Evidence confidence is low and guardian is RISKY — marking UNCERTAIN`);
      diagnosis.risk = 'UNCERTAIN';
    }

    const riskParams = ACTION_RISK_PARAMS[diagnosis.action];
    if (riskParams) {
      const engineResult = riskEngine.calculateRisk({
        action:        riskParams.engineAction,
        clusterTier:   this.tier,
        blastRadius:   riskParams.blastRadius,
        reversibility: riskParams.reversibility,
        llmConfidence: diagnosis.confidence ?? (diagnosis.risk === 'LOW' ? 0.9 : diagnosis.risk === 'MEDIUM' ? 0.7 : 0.5),
        costImpact:    riskParams.costImpact,
      });
      console.log(`[${this.name}] [RISK] score=${engineResult.score}  engine=${engineResult.decision}  tier=${this.tier}`);

      if (engineResult.decision === 'BLOCK' && diagnosis.risk !== 'HIGH' && diagnosis.risk !== 'UNCERTAIN') {
        console.warn(`[${this.name}] [RISK] Engine overrides to HIGH`);
        diagnosis.risk = 'HIGH';
      }
    }

    if (HIGH_RISK_ACTIONS.has(diagnosis.action) || diagnosis.risk === 'HIGH' || diagnosis.risk === 'UNCERTAIN') {
      const gateReason = diagnosis.risk === 'UNCERTAIN'
        ? 'Uncertain — evidence insufficient for confident automated decision'
        : 'High-risk action';
      console.log(`[${this.name}] [APPROVAL] ${gateReason} — waiting for human decision…`);
      issueTrackerStore.track(key, {
        stage: 'awaiting_approval', cluster: this.name, tier: this.tier, issue, diagnosis,
        note: gateReason,
      });
      const approved = await approvalStore.requestApproval({ issue, diagnosis, issueKey: key, guardianNote: guardian.reason, rca });
      if (!approved) {
        console.log(`[${this.name}] [APPROVAL] Denied — skipping`);
        audit.blocked({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: 'approval denied or timed out', metadata: { issueKey: key } });
        temporal.add({ cluster: this.name, action: diagnosis.action, status: 'blocked', issue: issue.type, riskScore: 1 });
        this._recordTimelineEntry(key, fingerprint, issue, podLogs, diagnosis, guardian, 'blocked', 'approval denied');
        this.cooldowns.set(key, Date.now());
        return;
      }
      console.log(`[${this.name}] [APPROVAL] Approved — proceeding`);
      issueTrackerStore.track(key, {
        stage: 'approved', cluster: this.name, tier: this.tier, issue, diagnosis,
        note: 'approved by human reviewer — applying fix',
      });
    }

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

    console.log(`[${this.name}] [VALIDATE] Waiting for fix to settle…`);
    try {
      await kubectl.waitForFix(issue, diagnosis.action, this.context);
    } catch {
      console.warn(`[${this.name}] [VALIDATE] kubectl wait timed out or errored — validating anyway`);
    }

    const resolved = await this._validateFix(issue, diagnosis.action);

    if (resolved) {
      console.log(`[${this.name}] [RESOLVED] ${key} fixed after ${attempt} attempt(s)`);
      audit.success({ cluster: this.name, agent: this.name, action: diagnosis.action, metadata: { issueKey: key, attempt } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'success', issue: issue.type, riskScore: 0.2 });
    } else {
      console.log(`[${this.name}] [UNRESOLVED] Fix did not work — will retry next cycle`);
      audit.failure({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: 'validation failed — issue persists', metadata: { issueKey: key, attempt } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'failed', issue: issue.type, riskScore: 0.5 });
    }

    this._recordTimelineEntry(
      key, fingerprint, issue, podLogs, diagnosis, guardian,
      resolved ? 'success' : 'failed',
      resolved ? 'issue resolved' : 'issue persists after fix',
    );

    if (resolved) {
      const epDraft = this.episodeTimelines.get(key);

      const reflection = await ReflectionAgent.reflect({
        issue,
        planAction:         diagnosis.action,
        rootCauseDiagnosis: diagnosis.rootCause,
        timeline:           epDraft?.timeline ?? [],
        resolved:           true,
        podLogs,
        rca:                epDraft?.rca ?? null,
      });

      await episodicMemory.store({
        fingerprint,
        context:               epDraft?.context         ?? this._buildContext(issue, podLogs),
        timeline:              epDraft?.timeline         ?? [],
        reflection,
        resolved:              true,
        resolvedAction:        diagnosis.action,
        totalAttempts:         attempt,
        metricsSnapshot:       epDraft?.metricsSnapshot  ?? null,
        rca:                   epDraft?.rca ?? undefined,
        guardianClassification: epDraft?.guardianClassification ?? null,
      });

      await ruleEngine.analyze(issue.type);

      const stats = episodicMemory.stats();
      console.log(`[${this.name}] [MEMORY] Index: ${stats.buckets} buckets, ${stats.episodes} episodes`);

      issueTrackerStore.resolve(key, 'fixed', `resolved after ${attempt} attempt(s) via ${diagnosis.action}`);

      this.episodeTimelines.delete(key);
      this.attemptCounts.delete(key);
    }

    this.cooldowns.set(key, Date.now());
  }

  // Check if the evidence is sufficient
  _assessEvidenceSufficiency(issue, podLogs, metrics, events, attempt) {
    if (issue.oomKilled === true || issue.exitCode === 137 || issue.type === 'OOMKilled') {
      return { needsInvestigation: false, reasons: [], mode: 'standard', confidence: 'high' };
    }
    if (issue.type === 'ImagePullBackOff') {
      return { needsInvestigation: false, reasons: [], mode: 'standard', confidence: 'high' };
    }

    const reasons = [];
    const logLen  = (podLogs ?? '').trim().length;

    if (issue.exitCode == null &&
        (issue.type === 'CrashLoopBackOff' || issue.type === 'ContainerError')) {
      reasons.push('MISSING_EXIT_CODE');
    }

    if (logLen < 80) {
      reasons.push('INSUFFICIENT_LOGS');
    }

    if (issue.type === 'CrashLoopBackOff') {
      reasons.push('CRASH_LOOP_DETECTED');
    }

    if ((issue.restartCount ?? 0) > 3) {
      reasons.push('HIGH_RESTART_COUNT');
    }

    if (attempt > 1) {
      reasons.push('REPEATED_ATTEMPT');
    }

    const AMBIGUOUS_CODES = new Set([1, 2, 126, 127]);
    if (issue.exitCode != null && AMBIGUOUS_CODES.has(issue.exitCode)) {
      reasons.push('AMBIGUOUS_EXIT_CODE');
    }

    const BACKOFF_SIGNALS = new Set(['BackOff', 'CrashLoopBackOff', 'OOMKilling', 'Killing', 'Unhealthy']);
    const hasBackoffEvent = (events ?? []).some(e =>
      BACKOFF_SIGNALS.has(e.reason) &&
      e.name === issue.podName && e.namespace === issue.namespace
    );
    if (hasBackoffEvent) {
      reasons.push('BACKOFF_EVENTS_DETECTED');
    }

    const needsInvestigation = reasons.length > 0;
    const confidence =
      !needsInvestigation   ? 'high'   :
      reasons.length <= 2   ? 'medium' : 'low';

    return {
      needsInvestigation,
      reasons,
      mode: needsInvestigation ? 'investigation_required' : 'standard',
      confidence,
    };
  }

  // Fetch extra evidence with kubectl
  async _enrichEvidence(issue, existingLogs) {
    const ns     = issue.namespace ?? 'default';
    const pod    = issue.podName;
    const dep    = issue.deployment;
    const result = { previousLogs: null, describeEvents: null, rolloutHistory: null };
    const tasks  = [];

    if (pod) {
      tasks.push(
        this._runSafeCommand(
          `kubectl --context=${this.context} logs --previous ${pod} -n ${ns} --tail=80`,
          { readOnly: true }
        )
        .then(out => { result.previousLogs = out.trim() || null; })
        .catch(() => {})
      );
    }

    const logLen = (existingLogs ?? '').trim().length;
    if (pod && logLen < 80) {
      tasks.push(
        this._runSafeCommand(
          `kubectl --context=${this.context} describe pod ${pod} -n ${ns}`,
          { readOnly: true }
        )
          .then(raw => {
            const idx = raw.indexOf('\nEvents:');
            result.describeEvents = idx !== -1
              ? raw.slice(idx, idx + 1500).trim()
              : null;
          })
          .catch(() => {})
      );
    }

    const ROLLBACK_CODES = new Set([126, 127]);
    if (dep && (issue.exitCode == null || ROLLBACK_CODES.has(issue.exitCode))) {
      tasks.push(
        this._runSafeCommand(
          `kubectl --context=${this.context} rollout history deployment/${dep} -n ${ns}`,
          { readOnly: true }
        )
        .then(out => { result.rolloutHistory = out.trim() || null; })
        .catch(() => {})
      );
    }

    await Promise.allSettled(tasks);
    return result;
  }

  // Add a timeline entry
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

    issueTrackerStore.track(key, {
      stage: 'progress', cluster: this.name, tier: this.tier, issue, diagnosis, guardian,
      outcome, note, fingerprint,
    });
  }

  // Build the execution context
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

  // Run a sanitized kubectl command
  async _runSafeCommand(cmd, { readOnly = false } = {}) {
    const { safe, command, reason } = this.policyEngine.sanitizeCommand(cmd);
    if (!safe) throw new Error(`Command blocked by policy sanitizer: ${reason}`);
    if (this.policyEngine.dryRunMode && !readOnly) {
      console.log(`[${this.name}] [DRY-RUN] would execute: ${command}`);
      return '(dry-run)';
    }
    return kubectl.runCommand(command);
  }

  // Apply the chosen fix
  async _applyFix(issue, action) {
    const ns  = issue.namespace ?? 'default';
    const dep = issue.deployment;
    const pod = issue.podName;

    if (this.policyEngine.dryRunMode) {
      console.log(`[${this.name}] [DRY-RUN] Simulating "${action}" on ${dep ?? pod} (ns: ${ns})`);
      return;
    }

    const ownerKind = issue.ownerKind ?? (dep ? 'Deployment' : null);
    const controller = issue.controllerName ?? dep;
    const resourceType = ownerKind === 'StatefulSet' ? 'statefulset'
                       : ownerKind === 'DaemonSet'   ? 'daemonset'
                       : 'deployment';

    switch (action) {
      case 'restart':
        if (!controller) throw new Error('restart requires a controller');
        console.log(`[${this.name}] kubectl rollout restart ${resourceType}/${controller} -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} rollout restart ${resourceType}/${controller} -n ${ns}`
        );
        break;

      case 'rollback':
        if (!controller || ownerKind === 'DaemonSet') throw new Error('rollback requires a Deployment or StatefulSet');
        console.log(`[${this.name}] kubectl rollout undo ${resourceType}/${controller} -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} rollout undo ${resourceType}/${controller} -n ${ns}`
        );
        break;

      case 'increase_memory': {
        if (!controller) throw new Error('increase_memory requires a controller');
        let currentLimitMi = 128;
        try {
          const raw = await this._runSafeCommand(
            `kubectl --context=${this.context} get ${resourceType}/${controller} -n ${ns}` +
            ` -o jsonpath={.spec.template.spec.containers[0].resources.limits.memory}`,
            { readOnly: true }
          );
          if (raw.trim()) currentLimitMi = _parseMiB(raw.trim());
        } catch { }

        const newLimitMi   = Math.max(256, Math.ceil(currentLimitMi * 1.5));
        const newRequestMi = Math.ceil(newLimitMi * 0.5);
        console.log(`[${this.name}] memory ${currentLimitMi}Mi → ${newLimitMi}Mi (×1.5) for ${resourceType}/${controller} -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} set resources ${resourceType}/${controller}` +
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
        if (!controller) throw new Error('scale_down requires a controller');
        console.log(`[${this.name}] kubectl scale ${resourceType}/${controller} --replicas=1 -n ${ns}`);
        await this._runSafeCommand(
          `kubectl --context=${this.context} scale ${resourceType}/${controller} --replicas=1 -n ${ns}`
        );
        break;

      default:
        console.warn(`[${this.name}] Unknown action: ${action}`);
    }
  }

  // Check if the pod issue is gone
  async _validateFix(issue, action) {
    try {
      const pods   = await kubectl.getPods(issue.namespace, this.context, true);
      const issues = PodAnalyzer.extractIssues(pods);

      if (action === 'delete_pod') {
        const originalGone = !(pods.items ?? []).some(p => p.metadata?.name === issue.podName);
        if (!originalGone) return false;

        if (issue.deployment) {
          const depIssues = issues.filter(i => i.deployment === issue.deployment);
          return depIssues.length === 0;
        }
        return true;
      }

      const match = i =>
        i.type === issue.type &&
        (issue.deployment ? i.deployment === issue.deployment : i.podName === issue.podName);
      return !issues.some(match);
    } catch (err) {
      console.warn(`[${this.name}] [VALIDATE] Could not re-check: ${err.message}`);
      return false;
    }
  }

  // Handle one node issue
  async _handleNodeIssue(nodeIssue, { allNodeMetrics, correlation, events, nodeMap, affectedPods, pdbs }) {
    const key  = `node:${nodeIssue.type}:${nodeIssue.nodeName}`;

    const last = this.cooldowns.get(key);
    if (last && Date.now() - last < this.COOLDOWN_MS) {
      const wait = Math.round((this.COOLDOWN_MS - (Date.now() - last)) / 1000);
      console.log(`[${this.name}] [SKIP-NODE] ${key} — cooldown ${wait}s`);
      return;
    }

    const attempt = (this.attemptCounts.get(key) ?? 0) + 1;
    this.attemptCounts.set(key, attempt);

    if (attempt > this.MAX_FIX_ATTEMPTS) {
      console.warn(`[${this.name}] [ESCALATE-NODE] ${key} — max attempts`);
      const history = [];
      await escalationStore.escalate(key, { ...nodeIssue, isNodeIssue: true }, history);
      this.attemptCounts.delete(key);
      return;
    }

    console.log(`\n[${this.name}] ── NODE ${key} (attempt ${attempt}) ──`);

    const nodeMetrics  = allNodeMetrics?.[nodeIssue.nodeName] ?? null;
    const drainAttempts = this.nodeDrainAttempts.get(nodeIssue.nodeName) ?? 0;

    let diagnosis;
    try {
      diagnosis = await PlannerAgent.planNodeAction({
        nodeIssue, nodeMetrics, affectedPods, events, attempt, pastEpisodes: [], learnedRules: [],
      });
    } catch (err) {
      console.error(`[${this.name}] [NODE-PLANNER] Error: ${err.message}`);
      this.cooldowns.set(key, Date.now());
      return;
    }
    if (diagnosis.risk) diagnosis.risk = diagnosis.risk.toUpperCase();
    console.log(`[${this.name}] [NODE-PLANNER] action=${diagnosis.action}  risk=${diagnosis.risk}  cause=${diagnosis.rootCause}`);

    const affectedNamespaces = [...new Set(affectedPods.map(p => p.namespace).filter(Boolean))];
    const policyResult = this.policyEngine.validateNodeAction(
      { action: diagnosis.action, target: { nodeName: nodeIssue.nodeName }, risk: diagnosis.risk },
      {
        cluster: this.name, tier: this.tier, isControlPlane: nodeIssue.isControlPlane,
        drainAttempts, affectedPods: affectedPods.length,
        blockingPDBs: _findZeroDisruptionPDBs(affectedNamespaces, pdbs),
      }
    );
    console.log(`[${this.name}] [NODE-POLICY] status=${policyResult.status}  action=${policyResult.action}`);
    policyResult.warnings.forEach(w => console.warn(`[${this.name}] [NODE-POLICY] ⚠ ${w}`));

    if (policyResult.status === 'rejected') {
      console.error(`[${this.name}] [NODE-POLICY] BLOCKED — ${policyResult.reason}`);
      this.cooldowns.set(key, Date.now());
      return;
    }
    if (policyResult.status === 'modified') diagnosis.action = policyResult.action;
    if (diagnosis.action === 'noop') { this.cooldowns.set(key, Date.now()); return; }

    const guardian = await this.guardian.review({
      issue:    { ...nodeIssue, podName: `node:${nodeIssue.nodeName}`, namespace: 'kube-system', deployment: null },
      diagnosis,
      podLogs:  '',
      attempt,
    });
    console.log(`[${this.name}] [NODE-GUARDIAN] verdict=${guardian.verdict}  class=${guardian.classification}`);

    if (guardian.verdict === 'REJECT') {
      console.warn(`[${this.name}] [NODE-GUARDIAN] REJECTED — ${guardian.reason}`);
      this.cooldowns.set(key, Date.now());
      return;
    }
    if (guardian.verdict === 'DELEGATE_HUMAN') {
      console.warn(`[${this.name}] [NODE-GUARDIAN] DELEGATE_HUMAN — ${guardian.reason}`);
      await escalationStore.escalate(key, { ...nodeIssue, isNodeIssue: true }, [], null);
      issueTrackerStore.track(key, { stage: 'escalated', cluster: this.name, tier: this.tier, issue: nodeIssue, note: `Guardian delegated to human: ${guardian.reason}` });
      this.cooldowns.set(key, Date.now());
      return;
    }
    if (guardian.verdict === 'MODIFY') diagnosis.action = guardian.suggestedCommand;

    const nodeRiskParams = ACTION_RISK_PARAMS[diagnosis.action];
    if (nodeRiskParams) {
      const dynamicBlastRadius = (diagnosis.action === 'drain_node' || diagnosis.action === 'cordon_node')
        ? Math.min(affectedPods.length, 10)
        : nodeRiskParams.blastRadius;
      const nodeEngineResult = riskEngine.calculateRisk({
        action:        nodeRiskParams.engineAction,
        clusterTier:   this.tier,
        blastRadius:   dynamicBlastRadius,
        reversibility: nodeRiskParams.reversibility,
        llmConfidence: diagnosis.confidence ?? (diagnosis.risk === 'LOW' ? 0.9 : diagnosis.risk === 'MEDIUM' ? 0.7 : 0.5),
        costImpact:    nodeRiskParams.costImpact,
      });
      console.log(`[${this.name}] [NODE-RISK] score=${nodeEngineResult.score.toFixed(3)}  engine=${nodeEngineResult.decision}  affectedPods=${affectedPods.length}  tier=${this.tier}`);
      if (nodeEngineResult.decision === 'BLOCK' && diagnosis.risk !== 'HIGH') {
        console.warn(`[${this.name}] [NODE-RISK] Engine overrides to HIGH`);
        diagnosis.risk = 'HIGH';
      }
    }

    if (HIGH_RISK_ACTIONS.has(diagnosis.action) || diagnosis.risk === 'HIGH') {
      console.log(`[${this.name}] [NODE-APPROVAL] High-risk node action — waiting for human decision…`);
      const approved = await approvalStore.requestApproval({
        issue: nodeIssue, diagnosis, issueKey: key, guardianNote: guardian.reason,
      });
      if (!approved) {
        console.log(`[${this.name}] [NODE-APPROVAL] Denied`);
        this.cooldowns.set(key, Date.now());
        return;
      }
    }

    try {
      await this._applyNodeFix(nodeIssue.nodeName, diagnosis.action);
      console.log(`[${this.name}] [NODE-FIX] Applied: ${diagnosis.action} on ${nodeIssue.nodeName}`);
      if (diagnosis.action === 'drain_node') {
        this.nodeDrainAttempts.set(nodeIssue.nodeName, drainAttempts + 1);
      }
    } catch (err) {
      console.error(`[${this.name}] [NODE-FIX] Failed: ${err.message}`);
      this.cooldowns.set(key, Date.now());
      return;
    }

    temporal.add({ cluster: this.name, action: diagnosis.action, status: 'success', issue: nodeIssue.type, riskScore: 0.5 });
    this.cooldowns.set(key, Date.now());
  }

  // Apply a node fix
  async _applyNodeFix(nodeName, action) {
    if (this.policyEngine.dryRunMode) {
      console.log(`[${this.name}] [DRY-RUN] Simulating "${action}" on node ${nodeName}`);
      return;
    }

    if (action === 'cordon_node' || action === 'drain_node') {
      try {
        const nodesJson = await kubectl.getNodes(this.context);
        const schedulableNodes = (nodesJson.items ?? []).filter(n => {
          const unschedulable = n.spec?.unschedulable === true;
          const name = n.metadata?.name;
          return !unschedulable && name !== nodeName;
        });
        if (schedulableNodes.length === 0) {
          console.warn(`[${this.name}] [NODE-FIX] BLOCKED: ${action} on "${nodeName}" — it is the only schedulable node. Cordoning would make all pods unschedulable.`);
          return;
        }
      } catch (err) {
        console.warn(`[${this.name}] [NODE-FIX] Cannot verify node count, blocking ${action} as safety precaution: ${err.message}`);
        return;
      }
    }

    switch (action) {
      case 'cordon_node':
        await this._runSafeCommand(`kubectl --context=${this.context} cordon ${nodeName}`);
        break;
      case 'uncordon_node':
        await this._runSafeCommand(`kubectl --context=${this.context} uncordon ${nodeName}`);
        break;
      case 'drain_node':
        await this._runSafeCommand(
          `kubectl --context=${this.context} drain ${nodeName} --ignore-daemonsets --timeout=60s`
        );
        break;
      default:
        console.warn(`[${this.name}] Unknown node action: ${action}`);
    }
  }
}

module.exports = ClusterAgent;

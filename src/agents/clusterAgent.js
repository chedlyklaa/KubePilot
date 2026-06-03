// src/agents/clusterAgent.js
require('dotenv').config({ override: true });
const OpenAI          = require('openai');
const kubectl         = require('../tools/kubectl');
const PodAnalyzer     = require('./podAnalyzer');
const GuardianAgent   = require('./guardianAgent');
const approvalStore   = require('../api/approvalStore');
const escalationStore = require('../api/escalationStore');
const temporal        = require('../memory/temporal');
const audit           = require('../audit/logger');
const RiskEngine      = require('../risk/engine');

const client = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const riskEngine = new RiskEngine();

// Actions that must pause and wait for human approval before executing
const HIGH_RISK_ACTIONS = new Set(['increase_memory']);

const VALID_ACTIONS = new Set([
  'restart', 'rollback', 'delete_pod', 'scale_down', 'increase_memory', 'noop',
]);

// Map agent actions → risk engine parameters
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

    this.guardian           = new GuardianAgent(this.name, this.tier);

    this.cooldowns          = new Map(); // issueKey → last attempt timestamp
    this.attemptCounts      = new Map(); // issueKey → number of failed attempts
    this.permanentlyIgnored = new Set(); // escalated issues — agent never retries

    this.COOLDOWN_MS      = 45_000;
    this.VALIDATE_WAIT_MS = 15_000;
    this.MAX_FIX_ATTEMPTS = 3;
  }

  // ── Called once per cycle by runAgent.js ──────────────────────────────────
  async run() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[${this.name}] Cycle started`);
    console.log(`${'='.repeat(50)}`);

    const allIssues = [];

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

  // ── Per-issue handler with retry loop + approval gate + escalation ─────────
  async _handle(issue) {
    const target = issue.deployment ?? issue.podName;
    const key    = `${issue.type}:${target}:${issue.namespace}`;

    if (this.permanentlyIgnored.has(key)) return;

    const last = this.cooldowns.get(key);
    if (last && Date.now() - last < this.COOLDOWN_MS) {
      const wait = Math.round((this.COOLDOWN_MS - (Date.now() - last)) / 1000);
      console.log(`[${this.name}] [SKIP] ${key} — cooldown ${wait}s`);
      return;
    }

    const attempt = (this.attemptCounts.get(key) ?? 0) + 1;
    this.attemptCounts.set(key, attempt);

    if (attempt > this.MAX_FIX_ATTEMPTS) {
      console.warn(`[${this.name}] [ESCALATE] ${key} — ${this.MAX_FIX_ATTEMPTS} attempts exhausted`);
      const history = temporal.getClusterHistory(this.name)
        .filter(e => e.issue === issue.type)
        .slice(-this.MAX_FIX_ATTEMPTS);
      await escalationStore.escalate(key, issue, history);
      this.permanentlyIgnored.add(key);
      return;
    }

    console.log(`\n[${this.name}] ── ${key}  (attempt ${attempt}/${this.MAX_FIX_ATTEMPTS}) ──`);

    // ── 1. Ask LLM (applicative agent) ───────────────────────────────────────
    let diagnosis;
    let podLogs = '';
    try {
      const result = await this._askLLM(issue);
      podLogs   = result._podLogs ?? '';
      diagnosis = result;
      delete diagnosis._podLogs;
    } catch (err) {
      console.error(`[${this.name}] [LLM] Error: ${err.message}`);
      this.cooldowns.set(key, Date.now());
      return;
    }

    console.log(`[${this.name}] [AI] Root cause : ${diagnosis.rootCause}`);
    console.log(`[${this.name}] [AI] Action      : ${diagnosis.action}  risk=${diagnosis.risk}`);

    if (diagnosis.action === 'noop') {
      console.log(`[${this.name}] [AI] No safe fix available`);
      temporal.add({ cluster: this.name, action: 'noop', status: 'skipped', issue: issue.type, riskScore: 0 });
      this.cooldowns.set(key, Date.now());
      return;
    }

    // ── 2. Guardian review (supervisor agent) ────────────────────────────────
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
      this.cooldowns.set(key, Date.now());
      return;
    }

    if (guardian.verdict === 'MODIFY') {
      console.warn(`[${this.name}] [GUARDIAN] Action MODIFIED: ${diagnosis.action} → ${guardian.suggestedAction}`);
      console.warn(`[${this.name}] [GUARDIAN] Reason: ${guardian.reason}`);
      diagnosis.action = guardian.suggestedAction;
    }

    // DANGEROUS classification forces the human approval gate regardless of risk engine
    if (guardian.classification === 'DANGEROUS') {
      console.warn(`[${this.name}] [GUARDIAN] Classification DANGEROUS — forcing human approval`);
      diagnosis.risk = 'HIGH';
    }

    // ── 3. Risk engine — tier-aware override ─────────────────────────────────
    const riskParams = ACTION_RISK_PARAMS[diagnosis.action];
    if (riskParams) {
      const engineResult = riskEngine.calculateRisk({
        action:         riskParams.engineAction,
        clusterTier:    this.tier,
        blastRadius:    riskParams.blastRadius,
        reversibility:  riskParams.reversibility,
        llmConfidence:  diagnosis.risk === 'LOW' ? 0.9 : diagnosis.risk === 'MEDIUM' ? 0.7 : 0.5,
        costImpact:     riskParams.costImpact,
      });
      console.log(`[${this.name}] [RISK] score=${engineResult.score}  engine=${engineResult.decision}  tier=${this.tier}`);

      if (engineResult.decision === 'BLOCK' && diagnosis.risk !== 'HIGH') {
        console.warn(`[${this.name}] [RISK] Engine overrides LLM risk → HIGH`);
        diagnosis.risk = 'HIGH';
      }
    }

    // ── 4. Approval gate for high-risk actions ────────────────────────────────
    if (HIGH_RISK_ACTIONS.has(diagnosis.action) || diagnosis.risk === 'HIGH') {
      console.log(`[${this.name}] [APPROVAL] High-risk action — waiting for human decision…`);
      const approved = await approvalStore.requestApproval({ issue, diagnosis, issueKey: key, guardianNote: guardian.reason });
      if (!approved) {
        console.log(`[${this.name}] [APPROVAL] Denied — skipping this attempt`);
        audit.blocked({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: 'approval denied or timed out', metadata: { issueKey: key, guardianClass: guardian.classification } });
        temporal.add({ cluster: this.name, action: diagnosis.action, status: 'blocked', issue: issue.type, riskScore: 1 });
        this.cooldowns.set(key, Date.now());
        return;
      }
      console.log(`[${this.name}] [APPROVAL] Approved — applying fix`);
    }

    // ── 5. Apply fix ──────────────────────────────────────────────────────────
    try {
      await this._applyFix(issue, diagnosis.action);
      console.log(`[${this.name}] [FIX] Applied: ${diagnosis.action} on ${target}`);
    } catch (err) {
      console.error(`[${this.name}] [FIX] Failed: ${err.message}`);
      audit.failure({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: err.message, metadata: { issueKey: key, guardianClass: guardian.classification } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'failed', issue: issue.type, riskScore: 0.5 });
      this.cooldowns.set(key, Date.now());
      return;
    }

    // ── 6. Validate ───────────────────────────────────────────────────────────
    console.log(`[${this.name}] [VALIDATE] Waiting ${this.VALIDATE_WAIT_MS / 1000}s…`);
    await new Promise(r => setTimeout(r, this.VALIDATE_WAIT_MS));

    const resolved = await this._validateFix(issue);
    if (resolved) {
      console.log(`[${this.name}] [RESOLVED] ${key} fixed after ${attempt} attempt(s)`);
      audit.success({ cluster: this.name, agent: this.name, action: diagnosis.action, metadata: { issueKey: key, attempt, guardianClass: guardian.classification } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'success', issue: issue.type, riskScore: 0.2 });
      this.attemptCounts.delete(key);
    } else {
      console.log(`[${this.name}] [UNRESOLVED] Fix did not work — will retry next cycle`);
      audit.failure({ cluster: this.name, agent: this.name, action: diagnosis.action, reason: 'validation failed — issue persists', metadata: { issueKey: key, attempt } });
      temporal.add({ cluster: this.name, action: diagnosis.action, status: 'failed', issue: issue.type, riskScore: 0.5 });
    }

    this.cooldowns.set(key, Date.now());
  }

  // ── LLM diagnosis ──────────────────────────────────────────────────────────
  async _askLLM(issue) {
    const { logs, env, secrets, ...safe } = issue;
    const hasDeployment = !!safe.deployment;

    // Fetch live pod logs for richer LLM context (best-effort)
    let podLogs = '';
    if (safe.podName) {
      try {
        podLogs = await kubectl.getLogs(safe.podName, safe.namespace ?? 'default', this.context);
      } catch { /* logs unavailable — not critical */ }
    }

    // Recent failure history for this issue type on this cluster
    const recentHistory = temporal.getClusterHistory(this.name)
      .filter(e => e.issue === safe.type)
      .slice(-3);

    const prompt = `Kubernetes issue detected:
${JSON.stringify(safe, null, 2)}
${podLogs ? `\nRecent pod logs (last 50 lines):\n${podLogs}\n` : ''}
${recentHistory.length > 0 ? `\nPrevious fix attempts on this issue type:\n${JSON.stringify(recentHistory, null, 2)}\n` : ''}
ACTION RULES — follow strictly:
- "increase_memory": use when oomKilled=true or exitCode=137. The container was killed because it exceeded its memory limit. ⚠ REQUIRES HUMAN APPROVAL.
- "rollback"       : use when a Deployment exists and the current version is broken (bad image, bad command). Undoes the last rollout.
- "restart"        : use when a Deployment exists and the crash is transient (not OOM, not bad image).
- "delete_pod"     : use ONLY for bare pods with NO deployment. Useless for deployment-managed pods — Kubernetes recreates them instantly.
- "scale_down"     : use when the deployment has too many replicas causing resource pressure.
- "noop"           : only when no automated fix is safe.

deployment present: ${hasDeployment}
oomKilled: ${safe.oomKilled ?? false}

Return ONLY valid JSON:
{
  "rootCause": "one-sentence diagnosis",
  "action": "increase_memory|restart|rollback|delete_pod|scale_down|noop",
  "risk": "LOW|MEDIUM|HIGH"
}`;

    const systemMsg   = 'You are a Kubernetes SRE. Output ONLY valid JSON. No markdown.';
    const model       = process.env.OPENAI_MODEL;
    const temperature = 0.1;

    const estimatedInputTokens = Math.ceil((systemMsg.length + prompt.length) / 4);

    console.log(`[${this.name}] [LLM] ── Request params ──────────────────`);
    console.log(`[${this.name}] [LLM]   model       : ${model}`);
    console.log(`[${this.name}] [LLM]   temperature : ${temperature}`);
    console.log(`[${this.name}] [LLM]   stream      : true`);
    console.log(`[${this.name}] [LLM]   pod logs    : ${podLogs ? `${podLogs.split('\n').length} lines` : 'unavailable'}`);
    console.log(`[${this.name}] [LLM]   history ctx : ${recentHistory.length} prior attempt(s)`);
    console.log(`[${this.name}] [LLM]   prompt chars: ${systemMsg.length + prompt.length} (system: ${systemMsg.length}, user: ${prompt.length})`);
    console.log(`[${this.name}] [LLM]   est. tokens : ~${estimatedInputTokens} input`);
    console.log(`[${this.name}] [LLM] ─────────────────────────────────────`);

    const t0 = Date.now();

    const stream = await client.chat.completions.create({
      model,
      temperature,
      stream:         true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: prompt },
      ],
    });

    let raw = '';
    let usage = null;
    for await (const chunk of stream) {
      raw   += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) usage = chunk.usage;
    }

    const elapsed = Date.now() - t0;

    if (usage) {
      console.log(`[${this.name}] [LLM] ── Token usage (real) ───────────────`);
      console.log(`[${this.name}] [LLM]   prompt tokens     : ${usage.prompt_tokens}`);
      console.log(`[${this.name}] [LLM]   completion tokens : ${usage.completion_tokens}`);
      console.log(`[${this.name}] [LLM]   total tokens      : ${usage.total_tokens}`);
    } else {
      console.log(`[${this.name}] [LLM] ── Token usage (estimated) ──────────`);
      console.log(`[${this.name}] [LLM]   input  tokens : ~${estimatedInputTokens}`);
      console.log(`[${this.name}] [LLM]   output tokens : ~${Math.ceil(raw.length / 4)}`);
    }
    console.log(`[${this.name}] [LLM]   response time : ${elapsed}ms`);
    console.log(`[${this.name}] [LLM] ─────────────────────────────────────`);

    console.log(`[${this.name}] [LLM] Raw response: ${raw}`);
    const parsed = JSON.parse(raw);
    if (!VALID_ACTIONS.has(parsed.action)) {
      console.warn(`[${this.name}] [GUARD] invalid LLM action '${parsed.action}' — defaulting to noop`);
      parsed.action = 'noop';
    }

    if (parsed.action === 'delete_pod' && hasDeployment) {
      console.warn(`[${this.name}] [GUARD] delete_pod overridden to rollback (deployment exists)`);
      parsed.action = 'rollback';
    }

    // Attach pod logs so the guardian can reuse them without a second kubectl call
    parsed._podLogs = podLogs;
    return parsed;
  }

  // ── Apply the chosen fix ───────────────────────────────────────────────────
  async _applyFix(issue, action) {
    const ns  = issue.namespace ?? 'default';
    const dep = issue.deployment;
    const pod = issue.podName;

    switch (action) {
      case 'restart':
        if (!dep) throw new Error('restart requires a deployment');
        console.log(`[${this.name}] kubectl rollout restart deployment/${dep} -n ${ns}`);
        await kubectl.restartDeployment(dep, ns, this.context);
        break;

      case 'rollback':
        if (!dep) throw new Error('rollback requires a deployment');
        console.log(`[${this.name}] kubectl rollout undo deployment/${dep} -n ${ns}`);
        await kubectl.runCommand(`kubectl --context=${this.context} rollout undo deployment/${dep} -n ${ns}`);
        break;

      case 'increase_memory': {
        if (!dep) throw new Error('increase_memory requires a deployment');
        console.log(`[${this.name}] kubectl set resources deployment/${dep} --limits=memory=256Mi -n ${ns}`);
        await kubectl.runCommand(
          `kubectl --context=${this.context} set resources deployment/${dep}` +
          ` -n ${ns} --limits=memory=256Mi --requests=memory=128Mi`
        );
        break;
      }

      case 'delete_pod':
        if (!pod) throw new Error('delete_pod requires a pod name');
        console.log(`[${this.name}] kubectl delete pod ${pod} -n ${ns}`);
        await kubectl.deletePod(pod, ns, this.context);
        break;

      case 'scale_down':
        if (!dep) {
          // Bare pod — no deployment to scale. Delete the pod instead so it
          // doesn't keep crashing without the agent being able to remediate.
          console.warn(`[${this.name}] [GUARD] scale_down on bare pod — falling back to delete_pod`);
          await kubectl.deletePod(pod, ns, this.context);
        } else {
          console.log(`[${this.name}] kubectl scale deployment/${dep} --replicas=1 -n ${ns}`);
          await kubectl.scaleDeployment(dep, 1, ns, this.context);
        }
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

'use strict';
require('dotenv').config({ override: true });
const OpenAI     = require('openai');
const tokenStore     = require('../api/tokenStore');
const { runLLMCall } = require('../resilience/llmCircuitBreaker');
const { loadConfig } = require('../config');

const _config = loadConfig();
const GUARDIAN_API_KEY  = _config.GUARDIAN_API_KEY  || _config.OPENAI_API_KEY;
const GUARDIAN_BASE_URL = _config.GUARDIAN_BASE_URL || _config.OPENAI_BASE_URL;
const GUARDIAN_MODEL    = _config.GUARDIAN_MODEL    || _config.OPENAI_MODEL;

const guardianLlm = new OpenAI({ apiKey: GUARDIAN_API_KEY, baseURL: GUARDIAN_BASE_URL });

const usingDedicated = !!(_config.GUARDIAN_API_KEY && _config.GUARDIAN_MODEL);
console.log(`[GUARDIAN] LLM: ${usingDedicated ? `dedicated (${GUARDIAN_MODEL})` : `shared fallback (${GUARDIAN_MODEL})`}`);

const SYSTEM = `You are a Kubernetes Guardian Agent — an independent safety reviewer.
Your job is to evaluate actions proposed by an autonomous remediation agent BEFORE they are executed on a cluster. You are the last automated checkpoint before human approval or execution.

Be rigorous but pragmatic. Your goal is to catch genuine mistakes and dangerous mismatches, not to block every action out of caution.

━━━ ALREADY HEALTHY OVERRIDES EVERYTHING ELSE ━━━
Before anything else: if the evidence you were shown (pod logs, current status/phase,
ready state) indicates the target is CURRENTLY healthy, completed, or ready, REJECT any
mutating command regardless of what the historical incident report claims happened
earlier — do not approve an action "to be safe" or "to reset state" against a target
that isn't actually broken right now. A stale incident signal is not a reason to act on
a target you can see is fine.

━━━ COMMAND JUDGMENT ━━━
There is no fixed action list anymore — the Planner writes the actual kubectl command
itself, and your job is to judge whether THIS SPECIFIC COMMAND is right for this issue:
correct approach, safe, and correctly scoped (right verb, right resource, right name,
right namespace — nothing broader than the target it's supposed to fix). Use this domain
knowledge, applied to whatever command you're actually shown, not a fixed name:
CrashLoopBackOff (oomKilled=false)  → a restart- or rollback-style command is reasonable. A command that deletes the pod directly or scales it away is wrong.
CrashLoopBackOff (oomKilled=true)   → the command MUST raise the memory limit/request. A plain restart will just recur — REJECT it.
OOMKilled                           → same as above — the command must increase memory. A restart alone is incorrect (OOM will recur immediately).
ImagePullBackOff / ErrImagePull     → kubectl cannot fix a bad image URL or missing pull credentials. Almost any command here is wrong — REJECT (or DELEGATE_HUMAN if nothing automated could ever fix it), don't approve a command that can't actually work. Exception: a "rollout undo" of the controller is acceptable when the evidence shows an earlier revision or ReplicaSet was running a working image. A command that substitutes a guessed image (set image / --image= to a tag not proven to work) is always DANGEROUS — REJECT it.
ContainerError (non-OOM exit code)  → a rollback- (bad image/config) or restart- (transient) style command are both acceptable.
Bare pod (deployment=null)          → a direct pod delete is real and permanent but is the only way to remove it — judge whether the investigation actually supports doing that.
Deployment-managed pod              → a command that deletes the POD directly is almost always wrong (the controller just recreates it) — REJECT unless there's a specific reason; target the controller instead (rollout restart/undo, patch, scale).
A command that scales a workload down → only reasonable when there IS a controller and reducing replicas plausibly relieves real resource pressure.

━━━ REPEAT ATTEMPT RULE ━━━
If the same COMMAND — not just the same general idea — has been tried 2+ times on this
issue without success → it's wrong. Use MODIFY to suggest a different command, or REJECT
if no alternative is safe.

━━━ CLUSTER TIER ━━━
dev tier        → be permissive, mistakes are easily reversed
staging tier    → moderate caution
production tier → maximum caution; when in doubt, REJECT and let the human gate handle it

━━━ NODE COMMANDS ━━━
A command that cordons a node   → acceptable when the node has active conditions (NotReady/Pressure) AND multiple pods are affected. REJECT if proposed for a single isolated pod failure with no node-level evidence.
A command that drains a node    → RISKY — evicts everything on the node. REJECT if the node is a control-plane node, if fewer than 3 pods are affected with no NodeNotReady evidence, or if draining this node was already attempted and failed. MODIFY to a cordon instead if drain is premature but isolating the node is still warranted.
A command that uncordons a node → only APPROVE if the original node condition is confirmed resolved.

━━━ CLASSIFICATION ━━━
SAFE      → Command is clearly correct, minimal blast radius (a scoped restart, no command at all, a cordon on a confirmed degraded node)
CAUTIOUS  → Command is likely correct but some uncertainty (a rollback, a bare-pod delete, a cordon with moderate confidence)
RISKY     → Command may not solve the problem or has significant side effects (a scale-down, a drain, a repeated rollback)
DANGEROUS → Command is wrong for this issue type, contradicts the context, or targets a control-plane node for a drain

━━━ VERDICT ━━━
APPROVE         → Proceed with the proposed command as-is
REJECT          → Block this command entirely, but a DIFFERENT command might still fix
                   it (no safe alternative right now, issue already likely resolved,
                   resource does not exist) — the workflow will re-investigate and try again.
MODIFY          → Approve a corrected command instead (you MUST provide suggestedCommand — the
                   subcommand and arguments ONLY, e.g. "rollout restart deployment/api -n backend".
                   Do NOT include the word "kubectl" itself or "--context" — both are added
                   automatically, same convention the Planner itself follows for "command".)
DELEGATE_HUMAN  → Do NOT use this as a stronger REJECT. Use it only when NO command could
                   fix the underlying problem at all — e.g. the root cause is outside
                   kubectl's reach entirely (bad application code, an external dependency,
                   a billing/quota wall, a decision only a human can make), or every
                   reasonable command has already been tried and failed. This skips
                   straight to human escalation instead of another investigate/plan cycle
                   — only choose it when another automated attempt would genuinely be
                   wasted effort, not just because you're uncertain.

━━━ REFLEXION HISTORY ━━━
When history/rules from past incidents are provided below, weigh them: a rule flags a
known-bad approach for this issue type; a past incident's outcome (fixed vs still-failing)
is evidence for or against repeating the same command now. Don't follow a rule blindly if
this incident's evidence clearly contradicts it — say so in "reason" if you override one.

━━━ DON'T ASSERT WHAT YOU WEREN'T TOLD ━━━
Never claim a condition has CHANGED (e.g. "the outage has been resolved", "the service is
back up", "this has since been fixed") unless the evidence you were given explicitly says
so with a status/timestamp newer than the original incident. Absence of new evidence means
the original condition still holds — do not invent a resolution to justify a convenient
verdict. Populate "evidenceCited" with the specific phrases from the input you're actually
basing your verdict on; if you can't point to anything, that's a sign your reasoning isn't
actually grounded.

Return ONLY valid JSON — no markdown, no explanation outside the JSON:
{
  "verdict": "APPROVE" | "REJECT" | "MODIFY" | "DELEGATE_HUMAN",
  "classification": "SAFE" | "CAUTIOUS" | "RISKY" | "DANGEROUS",
  "reason": "one or two sentences explaining your decision",
  "suggestedCommand": "a corrected command if verdict=MODIFY (NEVER starting with the word \"kubectl\"), null otherwise",
  "confidence": 0.85,
  "safetyConcerns": ["short bullet", "..."],
  "evidenceCited": ["short quote or fact from the input this verdict is actually based on", "..."],
  "impactSummary": "one sentence: what changes on the cluster if this executes",
  "estimatedBlastRadius": "single_pod" | "single_node" | "cluster" | "multi_cluster"
}
Note: confidence is a float from 0.0 (very uncertain) to 1.0 (very certain). Pick the value that reflects how sure you are about your verdict.`;

// Verdict used when Guardian fails
function _guardianFailureVerdict(reason) {
  return {
    verdict:         'DELEGATE_HUMAN',
    classification:  'DANGEROUS',
    reason,
    suggestedCommand: null,
    confidence:      0,
    safetyConcerns:  ['Guardian could not produce a trustworthy verdict — escalated to a human rather than auto-approved'],
    evidenceCited:   [],
    impactSummary:   null,
    estimatedBlastRadius: null,
  };
}

const VALID_VERDICTS  = new Set(['APPROVE', 'REJECT', 'MODIFY', 'DELEGATE_HUMAN']);
const VALID_BLAST_RADII = new Set(['single_pod', 'single_node', 'cluster', 'multi_cluster']);
const VALID_CLASSES   = new Set(['SAFE', 'CAUTIOUS', 'RISKY', 'DANGEROUS']);

class GuardianAgent {
  constructor(clusterName, tier = 'dev') {
    this.clusterName = clusterName;
    this.tier        = tier;
  }

  // Review a proposed action
  async review({ issue, diagnosis, podLogs = '', attempt = 1, rca = null, reflexionContext = null }) {
    const { action, command, rootCause, risk } = diagnosis;

    const repeatWarning = attempt > 1
      ? `\n⚠ This is attempt #${attempt}. The same issue persisted through ${attempt - 1} previous fix attempt(s).`
      : '';

    const rcaBlock = (rca && rca.confidence > 0)
      ? `\n━━━ SUPPORTING RCA ━━━\n${rca.suspected_cause} (confidence: ${rca.confidence}, risk: ${rca.risk_level}). Factor this into your safety assessment.`
      : '';

    const rules = reflexionContext?.rules ?? [];
    const pastEpisodes = [...(reflexionContext?.structuralMatches ?? []), ...(reflexionContext?.semanticMatches ?? [])];
    const reflexionBlock = (rules.length || pastEpisodes.length)
      ? `\n━━━ REFLEXION HISTORY (from past incidents) ━━━\n` +
        (rules.length ? `Learned rules:\n${rules.map(r => `  - [${r.issueType ?? issue.type}] ${r.rule ?? r.condition ?? JSON.stringify(r)}`).join('\n')}\n` : '') +
        (pastEpisodes.length ? `Similar past incidents (${pastEpisodes.length}):\n${pastEpisodes.slice(0, 5).map(e => {
          const ep = e.payload ?? e;
          return `  - action=${ep.resolvedAction ?? ep.timeline?.[0]?.action ?? 'unknown'} resolved=${ep.resolved} lesson="${ep.reflection?.lessonsLearned ?? ''}"`;
        }).join('\n')}` : '')
      : '';

    const ownerType = issue.deployment ? 'Deployment' :
                      issue.ownerKind  ? issue.ownerKind : 'none (bare pod)';
    const replicaInfo = issue.replicaCount != null
      ? `Replicas:      ${issue.replicaCount}`
      : issue.deployment
        ? 'Replicas:      unknown'
        : 'Replicas:      n/a (bare pod — single instance, no controller will recreate it)';

    const userPrompt = `CLUSTER: ${this.clusterName} (tier: ${this.tier})

━━━ DETECTED ISSUE ━━━
Type:          ${issue.type}
Pod:           ${issue.podName}
Namespace:     ${issue.namespace ?? 'default'}
Owner:         ${ownerType}
Deployment:    ${issue.deployment ?? 'none — this is a bare pod'}
${replicaInfo}
Container:     ${issue.containerName ?? 'unknown'}
Restart count: ${issue.restartCount ?? 0}
OOM killed:    ${issue.oomKilled ?? false}
Exit code:     ${issue.exitCode ?? 'N/A'}
${repeatWarning}

━━━ PLANNER PROPOSAL ━━━
Action:     ${action}
Command:    ${command || '(no command — legacy fixed-action diagnosis, judge from Action/Root cause alone)'}
Root cause: ${rootCause}
Risk level: ${risk}

━━━ RECENT POD LOGS ━━━
${podLogs ? podLogs.slice(-2000) : '(no logs available)'}${rcaBlock}${reflexionBlock}

Review this proposal and return your JSON verdict.`;

    const t0 = Date.now();
    console.log(`[${this.clusterName}] [GUARDIAN] Reviewing: action=${action}  issue=${issue.type}  attempt=${attempt}`);

    try {
      const { raw, usage } = await runLLMCall(
        () => guardianLlm.chat.completions.create({ model: GUARDIAN_MODEL, temperature: 0.1, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }] }),
        { requiredFields: ['verdict', 'classification'] }
      );

      tokenStore.record('guardian', usage);
      console.log(`[${this.clusterName}] [GUARDIAN] Response time: ${Date.now() - t0}ms${usage ? `  tokens=${usage.total_tokens}` : ''}`);

      let result;
      try {
        result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
      } catch {
        console.warn(`[${this.clusterName}] [GUARDIAN] Unparseable response — escalating instead of auto-approving`);
        return _guardianFailureVerdict('Guardian response was not valid JSON — escalated to a human rather than auto-approved (no verdict could be parsed).');
      }

      if (!VALID_VERDICTS.has(result.verdict)) {
        console.warn(`[${this.clusterName}] [GUARDIAN] Invalid verdict "${result.verdict}" — escalating instead of defaulting to APPROVE`);
        return _guardianFailureVerdict(`Guardian returned an unrecognized verdict ("${result.verdict}") — escalated to a human rather than auto-approved.`);
      }
      if (!VALID_CLASSES.has(result.classification)) result.classification = 'CAUTIOUS';

      if (typeof result.suggestedCommand === 'string') {
        result.suggestedCommand = result.suggestedCommand
          .replace(/^\s*kubectl\s+(--context=\S+\s+)?/i, '')
          .trim();
      }

      if (result.verdict === 'MODIFY') {
        if (!result.suggestedCommand || typeof result.suggestedCommand !== 'string' || !result.suggestedCommand.trim()) {
          console.warn(`[${this.clusterName}] [GUARDIAN] MODIFY without a usable suggestedCommand — rejecting instead of approving the original, unmodified command`);
          result.verdict = 'REJECT';
          result.classification = VALID_CLASSES.has(result.classification) ? result.classification : 'CAUTIOUS';
          result.reason = `${result.reason ?? ''} [Guardian requested MODIFY but did not provide a usable suggestedCommand — rejected rather than silently approving the original command]`.trim();
          result.suggestedCommand = null;
        }
      } else {
        result.suggestedCommand = null;
      }

      result.confidence = typeof result.confidence === 'number'
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.7;

      result.safetyConcerns = Array.isArray(result.safetyConcerns) ? result.safetyConcerns.filter(s => typeof s === 'string') : [];
      result.evidenceCited  = Array.isArray(result.evidenceCited) ? result.evidenceCited.filter(s => typeof s === 'string') : [];
      result.impactSummary  = typeof result.impactSummary === 'string' ? result.impactSummary : null;
      result.estimatedBlastRadius = VALID_BLAST_RADII.has(result.estimatedBlastRadius) ? result.estimatedBlastRadius : null;

      return result;

    } catch (err) {
      console.warn(`[${this.clusterName}] [GUARDIAN] LLM error: ${err.message} — escalating instead of auto-approving`);
      return _guardianFailureVerdict(`Guardian was unavailable (${err.message}) — escalated to a human rather than auto-approved.`);
    }
  }
}

module.exports = GuardianAgent;
module.exports._guardianFailureVerdict = _guardianFailureVerdict;

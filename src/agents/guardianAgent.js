'use strict';
require('dotenv').config({ override: true });
const OpenAI     = require('openai');
const tokenStore = require('../api/tokenStore');

// ── Build an independent LLM client for the guardian ─────────────────────────
// Uses GUARDIAN_* env vars when set, falls back to the main OPENAI_* credentials
// so the system stays operational even if only one API key is configured.
const GUARDIAN_API_KEY  = process.env.GUARDIAN_API_KEY  || process.env.OPENAI_API_KEY;
const GUARDIAN_BASE_URL = process.env.GUARDIAN_BASE_URL || process.env.OPENAI_BASE_URL;
const GUARDIAN_MODEL    = process.env.GUARDIAN_MODEL    || process.env.OPENAI_MODEL;

const guardianLlm = new OpenAI({ apiKey: GUARDIAN_API_KEY, baseURL: GUARDIAN_BASE_URL });

const usingDedicated = !!(process.env.GUARDIAN_API_KEY && process.env.GUARDIAN_MODEL);
console.log(`[GUARDIAN] LLM: ${usingDedicated ? `dedicated (${GUARDIAN_MODEL})` : `shared fallback (${GUARDIAN_MODEL})`}`);

// ── Guardian system prompt ────────────────────────────────────────────────────
const SYSTEM = `You are a Kubernetes Guardian Agent — an independent safety reviewer.
Your job is to evaluate actions proposed by an autonomous remediation agent BEFORE they are executed on a cluster. You are the last automated checkpoint before human approval or execution.

Be rigorous but pragmatic. Your goal is to catch genuine mistakes and dangerous mismatches, not to block every action out of caution.

━━━ CORRECTNESS RULES ━━━
CrashLoopBackOff (oomKilled=false)  → restart or rollback are correct. delete_pod or scale_down are wrong.
CrashLoopBackOff (oomKilled=true)   → increase_memory is the only correct fix. restart alone will keep failing.
OOMKilled                           → increase_memory is correct. restart is incorrect (OOM will recur immediately).
ImagePullBackOff / ErrImagePull     → noop is the only safe answer. kubectl cannot fix a bad image URL or missing credentials.
ContainerError (non-OOM exit code)  → rollback (bad image/config) or restart (transient) are both acceptable.
Bare pod (deployment=null)          → delete_pod is correct. restart/rollback/scale_down are wrong (no controller).
Deployment-managed pod              → NEVER delete_pod. Use restart, rollback, or scale_down.
scale_down                          → only valid when there is a deployment AND replicas > 1 causing resource pressure.

━━━ REPEAT ATTEMPT RULE ━━━
If the same action has been tried 2+ times on the same issue WITHOUT success → the action is WRONG.
In this case use MODIFY to suggest a different action, or REJECT if no alternative is safe.

━━━ CLUSTER TIER ━━━
dev tier        → be permissive, mistakes are easily reversed
staging tier    → moderate caution
production tier → maximum caution; when in doubt, REJECT and let the human gate handle it

━━━ NODE ACTION RULES ━━━
cordon_node   → Acceptable when node has active conditions (NotReady/Pressure) AND multiple pods are affected.
                REJECT if proposed for a single isolated pod failure with no node-level evidence.
drain_node    → RISKY — evicts all pods on the node.
                REJECT if: isControlPlane=true, affectedPods < 3 with no NodeNotReady, or same action attempted twice.
                MODIFY to cordon_node if drain is premature but node isolation is still warranted.
uncordon_node → Only APPROVE if original node condition is confirmed resolved.

━━━ CLASSIFICATION ━━━
SAFE      → Action is clearly correct, minimal blast radius (restart, noop, cordon on confirmed degraded node)
CAUTIOUS  → Action is likely correct but some uncertainty (rollback, delete_pod on bare pod, cordon moderate confidence)
RISKY     → Action may not solve the problem or has significant side effects (scale_down, drain_node, repeated rollback)
DANGEROUS → Action is wrong for this issue type, contradicts context, or targets a control-plane node for drain

━━━ VERDICT ━━━
APPROVE → Proceed with the proposed action as-is
REJECT  → Block this action entirely (no safe alternative, issue already likely resolved, resource does not exist)
MODIFY  → Approve a corrected action instead (you MUST provide suggestedAction)

Return ONLY valid JSON — no markdown, no explanation outside the JSON:
{
  "verdict": "APPROVE" | "REJECT" | "MODIFY",
  "classification": "SAFE" | "CAUTIOUS" | "RISKY" | "DANGEROUS",
  "reason": "one or two sentences explaining your decision",
  "suggestedAction": "action name if verdict=MODIFY, null otherwise",
  "confidence": 0.85
}
Note: confidence is a float from 0.0 (very uncertain) to 1.0 (very certain). Pick the value that reflects how sure you are about your verdict.`;

// ── Safe fallback when guardian cannot respond ────────────────────────────────
const FALLBACK = {
  verdict:         'APPROVE',
  classification:  'CAUTIOUS',
  reason:          'Guardian unavailable — proceeding with caution.',
  suggestedAction: null,
  confidence:      0.5,
};

const VALID_VERDICTS  = new Set(['APPROVE', 'REJECT', 'MODIFY']);
const VALID_CLASSES   = new Set(['SAFE', 'CAUTIOUS', 'RISKY', 'DANGEROUS']);
const VALID_ACTIONS   = new Set(['restart', 'rollback', 'delete_pod', 'scale_down', 'increase_memory', 'noop']);

class GuardianAgent {
  constructor(clusterName, tier = 'dev') {
    this.clusterName = clusterName;
    this.tier        = tier;
  }

  /**
   * Review a proposed action.
   * @param {object} params
   * @param {object} params.issue      - Issue from PodAnalyzer
   * @param {object} params.diagnosis  - { rootCause, action, risk } from applicative LLM
   * @param {string} params.podLogs    - Last pod logs fetched during diagnosis
   * @param {number} params.attempt    - Current attempt number (1-based)
   * @returns {Promise<{verdict, classification, reason, suggestedAction, confidence}>}
   */
  async review({ issue, diagnosis, podLogs = '', attempt = 1 }) {
    const { action, rootCause, risk } = diagnosis;

    const repeatWarning = attempt > 1
      ? `\n⚠ This is attempt #${attempt}. The same issue persisted through ${attempt - 1} previous fix attempt(s).`
      : '';

    const userPrompt = `CLUSTER: ${this.clusterName} (tier: ${this.tier})

━━━ DETECTED ISSUE ━━━
Type:          ${issue.type}
Pod:           ${issue.podName}
Namespace:     ${issue.namespace ?? 'default'}
Deployment:    ${issue.deployment ?? 'none — this is a bare pod'}
Container:     ${issue.containerName ?? 'unknown'}
Restart count: ${issue.restartCount ?? 0}
OOM killed:    ${issue.oomKilled ?? false}
Exit code:     ${issue.exitCode ?? 'N/A'}
${repeatWarning}

━━━ APPLICATIVE AGENT PROPOSAL ━━━
Action:     ${action}
Root cause: ${rootCause}
Risk level: ${risk}

━━━ RECENT POD LOGS ━━━
${podLogs ? podLogs.slice(-2000) : '(no logs available)'}

Review this proposal and return your JSON verdict.`;

    const t0 = Date.now();
    console.log(`[${this.clusterName}] [GUARDIAN] Reviewing: action=${action}  issue=${issue.type}  attempt=${attempt}`);

    try {
      const stream = await guardianLlm.chat.completions.create({
        model:          GUARDIAN_MODEL,
        temperature:    0.1,
        stream:         true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: SYSTEM      },
          { role: 'user',   content: userPrompt  },
        ],
      });

      let raw = '', usage = null;
      for await (const chunk of stream) {
        raw += chunk.choices[0]?.delta?.content ?? '';
        if (chunk.usage) usage = chunk.usage;
      }

      tokenStore.record('guardian', usage);
      console.log(`[${this.clusterName}] [GUARDIAN] Response time: ${Date.now() - t0}ms${usage ? `  tokens=${usage.total_tokens}` : ''}`);

      let result;
      try {
        result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
      } catch {
        console.warn(`[${this.clusterName}] [GUARDIAN] Unparseable response — using fallback`);
        return { ...FALLBACK };
      }

      // Sanitise and validate fields
      if (!VALID_VERDICTS.has(result.verdict))      result.verdict        = 'APPROVE';
      if (!VALID_CLASSES.has(result.classification)) result.classification = 'CAUTIOUS';

      // MODIFY without a valid suggestedAction → downgrade to APPROVE
      if (result.verdict === 'MODIFY') {
        if (!result.suggestedAction || !VALID_ACTIONS.has(result.suggestedAction)) {
          console.warn(`[${this.clusterName}] [GUARDIAN] MODIFY without valid suggestedAction — downgrading to APPROVE`);
          result.verdict = 'APPROVE';
          result.suggestedAction = null;
        }
      } else {
        result.suggestedAction = null;
      }

      result.confidence = typeof result.confidence === 'number'
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.7;

      return result;

    } catch (err) {
      console.warn(`[${this.clusterName}] [GUARDIAN] LLM error: ${err.message} — using fallback`);
      return { ...FALLBACK, reason: `Guardian unavailable (${err.message}) — proceeding with caution.` };
    }
  }
}

module.exports = GuardianAgent;

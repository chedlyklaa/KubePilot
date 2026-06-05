'use strict';
require('dotenv').config({ override: true });
const OpenAI      = require('openai');
const tokenStore  = require('../api/tokenStore');

const client = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
const MODEL = process.env.OPENAI_MODEL;

const VALID_ACTIONS = new Set([
  'restart', 'rollback', 'delete_pod', 'scale_down', 'increase_memory', 'noop',
]);

const SYSTEM = `You are a Kubernetes SRE Planner Agent.
You receive a detected pod issue, recent pod logs, real-time Prometheus metrics, past similar incidents from operational memory, and learned rules extracted from repeated failures.
Your job is to select the safest, most effective remediation action — informed by all available evidence.
Output ONLY valid JSON. No markdown.`;

class PlannerAgent {
  async plan({ issue, podLogs, structuralMatches, semanticMatches, learnedRules, attempt, metrics }) {
    const hasDeployment = !!issue.deployment;

    const pastCtx    = this._formatPastEpisodes(structuralMatches, semanticMatches);
    const rulesCtx   = this._formatRules(learnedRules);
    const metricsCtx = this._formatMetrics(metrics);

    const prompt = `CURRENT ISSUE
issueType:    ${issue.type}
pod:          ${issue.podName}
deployment:   ${issue.deployment ?? 'none — bare pod'}
namespace:    ${issue.namespace ?? 'default'}
oomKilled:    ${issue.oomKilled ?? false}
exitCode:     ${issue.exitCode ?? 'N/A'}
restartCount: ${issue.restartCount ?? 0}
attempt:      #${attempt}
${podLogs ? `\nRECENT POD LOGS\n${podLogs.slice(-1200)}` : ''}
${metricsCtx}
${pastCtx}
${rulesCtx}
ACTION RULES (mandatory)
- increase_memory : oomKilled=true OR exitCode=137. Requires human approval.
- rollback        : deployment exists AND broken image or bad config pushed recently.
- restart         : deployment exists AND transient crash (not OOM, not bad image).
- delete_pod      : bare pod ONLY (no deployment).
- scale_down      : deployment exists AND resource pressure from excess replicas.
- noop            : no safe automated fix available.

deployment present: ${hasDeployment}
oomKilled: ${issue.oomKilled ?? false}

Return ONLY valid JSON:
{
  "rootCause": "one-sentence diagnosis",
  "action":    "increase_memory|restart|rollback|delete_pod|scale_down|noop",
  "risk":      "LOW|MEDIUM|HIGH",
  "rationale": "why this action — cite past episodes or rules if they influenced the choice"
}`;

    const t0 = Date.now();
    console.log(`[PLANNER] issue=${issue.type}  attempt=${attempt}  pastCtx=${(structuralMatches?.length ?? 0) + (semanticMatches?.length ?? 0)}  rules=${learnedRules?.length ?? 0}  metrics=${metrics ? 'yes' : 'unavailable'}`);

    const stream = await client.chat.completions.create({
      model:          MODEL,
      temperature:    0.1,
      stream:         true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: prompt },
      ],
    });

    let raw = '', usage = null;
    for await (const chunk of stream) {
      raw   += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) usage = chunk.usage;
    }

    const elapsed = Date.now() - t0;
    tokenStore.record('planner', usage);
    console.log(`[PLANNER] ${elapsed}ms${usage ? `  tokens=${usage.total_tokens}` : ''}`);
    console.log(`[PLANNER] raw: ${raw}`);

    let parsed;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON object found in response');
      parsed = JSON.parse(match[0]);
    } catch (err) {
      console.warn(`[PLANNER] Unparseable response — using noop fallback: ${err.message}`);
      return { rootCause: 'Planner could not parse LLM response', action: 'noop', risk: 'LOW', rationale: 'fallback' };
    }

    if (!VALID_ACTIONS.has(parsed.action)) {
      console.warn(`[PLANNER] Invalid action "${parsed.action}" — defaulting to noop`);
      parsed.action = 'noop';
    }

    // Structural guard: delete_pod makes no sense for deployment-managed pods
    if (parsed.action === 'delete_pod' && hasDeployment) {
      console.warn('[PLANNER] delete_pod overridden to rollback (deployment exists)');
      parsed.action = 'rollback';
    }

    return parsed;
  }

  // ── Format Prometheus metrics for prompt injection ────────────────────────
  _formatMetrics(metrics) {
    if (!metrics) return '';
    const lines = ['\nMETRICS SNAPSHOT (Prometheus — last 15 minutes)'];

    if (metrics.cpu) {
      lines.push(`CPU       avg=${metrics.cpu.avgPct}%  peak=${metrics.cpu.peakPct}%  trend=${metrics.cpu.trend}`);
    }
    if (metrics.memory) {
      lines.push(`Memory    avg=${metrics.memory.avgMi}Mi  peak=${metrics.memory.peakMi}Mi  trend=${metrics.memory.trend}`);
    }
    if (metrics.restarts?.count != null) {
      lines.push(`Restarts  ${metrics.restarts.count}`);
    }
    if (metrics.oomDetected != null) {
      lines.push(`OOMKilled ${metrics.oomDetected}`);
    }

    return lines.join('\n');
  }

  // ── Format past episodes for prompt injection ──────────────────────────────
  _formatPastEpisodes(structural, semantic) {
    if (!structural?.length && !semantic?.length) return '';

    const lines = ['\nPAST SIMILAR INCIDENTS (use to inform your decision)'];

    if (structural?.length) {
      lines.push('Structurally identical (same issueType / oomKilled / exitCode):');
      for (const ep of structural) {
        const actions = (ep.timeline || []).map(t => `${t.action}→${t.outcome}`).join(', ');
        lines.push(`  • ${ep.fingerprint?.issueType}  actions:[${actions}]  resolved:${ep.resolved}  final:${ep.resolvedAction ?? 'escalated'}`);
        if (ep.reflection?.lessonsLearned) {
          lines.push(`    lesson: ${ep.reflection.lessonsLearned}`);
        }
      }
    }

    if (semantic?.length) {
      lines.push('Semantically similar (same symptoms, may differ in type):');
      for (const hit of semantic) {
        lines.push(`  • ${hit.payload?.issueType}  resolved:${hit.payload?.resolved}  final:${hit.payload?.resolvedAction ?? 'escalated'}  (similarity:${hit.score?.toFixed(2)})`);
      }
    }

    return lines.join('\n');
  }

  // ── Format learned rules for prompt injection ──────────────────────────────
  _formatRules(rules) {
    if (!rules?.length) return '';
    const lines = ['\nLEARNED RULES (apply these — generated from repeated failure patterns)'];
    for (const r of rules) {
      lines.push(`  • [${r.issueType}] ${r.rule}  (confidence:${r.confidence?.toFixed(2)}, occurrences:${r.occurrences})`);
    }
    return lines.join('\n');
  }
}

module.exports = new PlannerAgent();

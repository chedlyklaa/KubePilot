'use strict';
require('dotenv').config({ override: true });
const OpenAI     = require('openai');
const tokenStore = require('../api/tokenStore');

// Reuse the Guardian LLM (Mistral) — fast, structured JSON, different family from Planner
const client = new OpenAI({
  apiKey:  process.env.GUARDIAN_API_KEY  || process.env.OPENAI_API_KEY,
  baseURL: process.env.GUARDIAN_BASE_URL || process.env.OPENAI_BASE_URL,
});
const MODEL = process.env.GUARDIAN_MODEL || process.env.OPENAI_MODEL;

const SYSTEM = `You are a Kubernetes SRE Reflection Agent.
After a remediation attempt concludes (success or failure), you analyze what happened, identify the true root cause, extract a reusable lesson, and — when a clear pattern exists — propose a rule that should prevent the same mistake in the future.
Be concise and precise. Output ONLY valid JSON, no markdown.`;

const FALLBACK = {
  rootCause:      'Could not determine root cause — reflection unavailable',
  lessonsLearned: 'No lesson extracted',
  suggestedRule:  null,
  confidence:     0.3,
};

class ReflectionAgent {
  async reflect({ issue, planAction, rootCauseDiagnosis, timeline, resolved, podLogs }) {
    const timelineText = (timeline || [])
      .map((t, i) => `  ${i + 1}. action=${t.action}  outcome=${t.outcome}${t.note ? `  (${t.note})` : ''}`)
      .join('\n');

    const prompt = `INCIDENT
issueType:    ${issue.type}
pod:          ${issue.podName}
deployment:   ${issue.deployment ?? 'none — bare pod'}
namespace:    ${issue.namespace ?? 'default'}
oomKilled:    ${issue.oomKilled ?? false}
exitCode:     ${issue.exitCode ?? 'N/A'}
restartCount: ${issue.restartCount ?? 0}

REMEDIATION TIMELINE
${timelineText || '  (no actions recorded)'}

OUTCOME
resolved:          ${resolved}
last action tried: ${planAction}
AI diagnosis was:  ${rootCauseDiagnosis ?? 'unknown'}

RECENT POD LOGS
${podLogs ? podLogs.slice(-1500) : '(not available)'}

Return ONLY valid JSON:
{
  "rootCause":      "precise one-sentence root cause",
  "lessonsLearned": "what the agent should do differently next time — one or two sentences",
  "suggestedRule":  "a reusable rule string for future similar incidents, or null if nothing clear emerged",
  "confidence":     0.0
}
Note: confidence is 0.0–1.0 — how certain you are about the root cause given the evidence above.`;

    console.log(`[REFLECTION] Analyzing: ${issue.type} resolved=${resolved} attempts=${timeline?.length ?? 0}`);
    const t0 = Date.now();

    try {
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
        raw += chunk.choices[0]?.delta?.content ?? '';
        if (chunk.usage) usage = chunk.usage;
      }

      tokenStore.record('reflection', usage);
      console.log(`[REFLECTION] Done in ${Date.now() - t0}ms${usage ? `  tokens=${usage.total_tokens}` : ''}`);

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        console.warn('[REFLECTION] Unparseable response — using fallback');
        return { ...FALLBACK };
      }

      const result = JSON.parse(match[0]);
      result.confidence = typeof result.confidence === 'number'
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5;

      console.log(`[REFLECTION] rootCause:  ${result.rootCause}`);
      console.log(`[REFLECTION] lesson:     ${result.lessonsLearned}`);
      if (result.suggestedRule) console.log(`[REFLECTION] rule:       ${result.suggestedRule}`);

      return result;
    } catch (err) {
      console.warn('[REFLECTION] LLM error:', err.message);
      return { ...FALLBACK };
    }
  }
}

module.exports = new ReflectionAgent();

'use strict';
require('dotenv').config({ override: true });

const http           = require('http');
const https          = require('https');
const OpenAI         = require('openai');
const kubectl        = require('../tools/kubectl');
const vectorStore    = require('../memory/vectorStore');
const tokenStore     = require('../api/tokenStore');
const { runLLMCall } = require('../resilience/llmCircuitBreaker');

const client = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
const MODEL    = process.env.OPENAI_MODEL;
const PROM_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';

const FALLBACK_RCA = {
  suspected_cause:   'unknown — investigation failed',
  confidence:        0.0,
  evidence:          [],
  recommended_focus: 'manual inspection required',
  risk_level:        'medium',
};

const SYSTEM_PROMPT = `You are a Kubernetes root cause analysis engine.
You will be given raw evidence about a failing pod.
You MUST respond with ONLY a valid JSON object, no preamble, no markdown.
Schema:
{
  "suspected_cause": string,
  "confidence": number (0.0 to 1.0),
  "evidence": string[],
  "recommended_focus": string,
  "risk_level": "low" | "medium" | "high" | "critical"
}`;

const GATHER_TIMEOUT_MS = 10_000;

function promQuery(query) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/query', PROM_URL);
    url.searchParams.set('query', query);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url.toString(), { timeout: 5000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('prometheus timeout')); });
  });
}

class InvestigatorAgent {
  async investigate(issue, clusterName, kubeContext) {
    try {
      const { podName, namespace = 'default', deployment, nodeName } = issue;
      const ns = namespace;

      // ── Gather all evidence concurrently ───────────────────────────────────
      const logStep = podName
        ? kubectl.runCommand(`kubectl --context="${kubeContext}" logs ${podName} -n ${ns} --tail=100`)
        : Promise.resolve(null);

      const prevLogStep = podName
        ? kubectl.runCommand(`kubectl --context="${kubeContext}" logs ${podName} -n ${ns} --tail=100 --previous`)
        : Promise.resolve(null);

      const eventsStep = podName
        ? kubectl.runCommand(`kubectl --context="${kubeContext}" get events -n ${ns} --field-selector involvedObject.name=${podName}`)
        : Promise.resolve(null);

      const deployStep = deployment
        ? kubectl.runCommand(`kubectl --context="${kubeContext}" get deployment ${deployment} -n ${ns} -o json`)
        : Promise.resolve(null);

      const nodeStep = nodeName
        ? kubectl.runCommand(`kubectl --context="${kubeContext}" describe node ${nodeName}`)
        : Promise.resolve(null);

      const promStep = podName ? (async () => {
        const parts = [];
        const [mem, cpu] = await Promise.allSettled([
          promQuery(`container_memory_working_set_bytes{pod="${podName}",namespace="${ns}"}`),
          promQuery(`rate(container_cpu_usage_seconds_total{pod="${podName}",namespace="${ns}"}[5m])`),
        ]);
        if (mem.status === 'fulfilled' && mem.value?.data?.result?.[0]?.value?.[1])
          parts.push(`memory=${mem.value.data.result[0].value[1]} bytes`);
        if (cpu.status === 'fulfilled' && cpu.value?.data?.result?.[0]?.value?.[1])
          parts.push(`cpu_rate=${cpu.value.data.result[0].value[1]}`);
        return parts;
      })() : Promise.resolve([]);

      const vectorStep = vectorStore.ready
        ? vectorStore.search(`${issue.type} ${podName ?? ''} ${ns}`, 3)
        : Promise.resolve([]);

      // ── Hard 10-second total timeout using Promise.allSettled ──────────────
      const results = await Promise.race([
        Promise.allSettled([logStep, prevLogStep, eventsStep, deployStep, nodeStep, promStep, vectorStep]),
        new Promise(resolve => setTimeout(() => resolve(null), GATHER_TIMEOUT_MS)),
      ]);

      if (!results) {
        console.warn(`[INVESTIGATOR][${clusterName}] Timed out after ${GATHER_TIMEOUT_MS}ms`);
        return { ...FALLBACK_RCA };
      }

      const val = r => (r?.status === 'fulfilled' ? r.value ?? null : null);
      const [logs, prevLogs, events, deployManifest, nodeDescribe, promParts, vectorHits] = results.map(val);

      // ── Assemble evidence array ────────────────────────────────────────────
      const evidence = [];
      if (logs)     evidence.push(`current logs:\n${logs.slice(-800)}`);
      if (prevLogs) evidence.push(`previous container logs:\n${prevLogs.slice(-800)}`);
      if (events)   evidence.push(`k8s events:\n${events.slice(0, 600)}`);
      if (deployManifest) {
        try {
          const d = JSON.parse(deployManifest);
          const c = d.spec?.template?.spec?.containers?.[0];
          if (c?.resources) evidence.push(`resource limits: ${JSON.stringify(c.resources)}`);
        } catch {}
      }
      if (nodeDescribe) evidence.push(`node describe (excerpt):\n${nodeDescribe.slice(0, 600)}`);
      if (Array.isArray(promParts) && promParts.length > 0)
        evidence.push(`prometheus: ${promParts.join(', ')}`);
      if (Array.isArray(vectorHits) && vectorHits.length > 0)
        evidence.push(`similar past incidents: ${vectorHits.map(h => `${h.payload?.issueType}(resolved=${h.payload?.resolved})`).join(', ')}`);

      // ── Single LLM call (circuit-breaker wrapped, streaming) ─────────────
      const userPrompt = `Pod: ${podName ?? 'unknown'}
Namespace: ${ns}
IssueType: ${issue.type}
Cluster: ${clusterName}

GATHERED EVIDENCE
${evidence.join('\n\n') || '(no evidence gathered)'}`;

      let raw = '', usage = null;
      try {
        ({ raw, usage } = await runLLMCall(
          () => client.chat.completions.create({
            model:          MODEL,
            temperature:    0.1,
            stream:         true,
            stream_options: { include_usage: true },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user',   content: userPrompt },
            ],
          }),
          { requiredFields: ['suspected_cause', 'confidence'] }
        ));
      } catch (err) {
        console.warn(`[INVESTIGATOR][${clusterName}] LLM failed: ${err.message}`);
        return { ...FALLBACK_RCA };
      }
      if (usage) tokenStore.record('investigator', usage);

      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { ...FALLBACK_RCA };

      const result = JSON.parse(match[0]);
      if (!result.suspected_cause || typeof result.confidence !== 'number') return { ...FALLBACK_RCA };
      result.confidence = Math.max(0, Math.min(1, result.confidence));
      if (!['low', 'medium', 'high', 'critical'].includes(result.risk_level)) result.risk_level = 'medium';
      if (!Array.isArray(result.evidence)) result.evidence = [];

      // Enrich with capacity forecast context for memory/OOM issues
      const CAPACITY_ISSUE_TYPES = new Set(['OOMKilled', 'HighRestarts', 'MemNearLimit']);
      if (podName && (CAPACITY_ISSUE_TYPES.has(issue.type) || issue.oomKilled)) {
        try {
          const capacityEngine = require('./capacityForecastEngine');
          const fc = await capacityEngine.getPodForecast(clusterName, podName);
          if (fc && (fc.alertLevel === 'HIGH' || fc.alertLevel === 'CRITICAL')) {
            result.capacityContext = {
              alertLevel:        fc.alertLevel,
              resource:          fc.resource,
              currentPct:        fc.currentPct,
              slope:             fc.slope,
              hoursToExhaustion: fc.hoursToExhaustion,
              exhaustionAt:      fc.exhaustionAt,
            };
          }
        } catch { /* capacity forecast unavailable — non-blocking */ }
      }

      console.log(`[INVESTIGATOR][${clusterName}] ${result.suspected_cause} (conf=${result.confidence.toFixed(2)}, risk=${result.risk_level})`);
      return result;

    } catch (err) {
      console.warn(`[INVESTIGATOR] Investigation failed: ${err.message}`);
      return { ...FALLBACK_RCA };
    }
  }
}

module.exports = new InvestigatorAgent();

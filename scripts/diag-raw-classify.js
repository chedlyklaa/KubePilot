#!/usr/bin/env node
'use strict';
require('dotenv').config({ override: true });
const { ChatOpenAI }     = require('@langchain/openai');
const kubectl             = require('../src/tools/kubectl');
const OrchestratorAgent   = require('../src/agents/orchestratorAgent');
const dbConnection        = require('../src/db/connection');
const mongoose            = require('mongoose');
const { loadConfig }      = require('../src/config');

const CONTEXT = process.argv[2] || 'kind-kubepilot-test';

const SYSTEM_PROMPT = `You are the Orchestrator agent of an autonomous Kubernetes remediation system.
You receive a compact summary of the current pods, nodes, and warning events in one cluster.
Classify this evidence into a list of distinct INCIDENTS worth investigating — do not report
healthy/normal state.

━━━ WHEN TO MERGE, WHEN TO KEEP SEPARATE ━━━
Merge multiple symptoms into ONE incident ONLY when they belong to the SAME pod/deployment
(e.g. a CrashLoopBackOff pod plus its own warning events is one incident, not two).
Two different pods are TWO incidents even if the symptom looks identical (e.g. two unrelated
pods both in CrashLoopBackOff are two separate incidents, one per pod/deployment) — never
merge across different pods, deployments, or namespaces just because the failure type matches.
Every downstream system (dedup, dispatch grouping, the Investigator) keys off the SPECIFIC
pod/deployment/namespace/node you name below, not off "type" — an over-merged incident makes
its members invisible to all of that.

━━━ REQUIRED IDENTIFYING FIELDS ━━━
For every incident, set "scope" to pod, node, or cluster, and then COPY the exact identifying
field(s) verbatim from the input signal that triggered it — do not leave them null and do not
paraphrase them into evidenceSummary only:
  - scope "pod":  namespace is REQUIRED, and podName or deployment is REQUIRED.
  - scope "node": nodeName is REQUIRED.
  - scope "cluster": use only for issues with no single owning pod/node (e.g. a
    cluster-wide HPA or admission-controller failure).
evidenceSummary is a short justification for why you classified it as an incident — it does
NOT substitute for filling in the structured fields above; both are required.

If nothing is wrong, return an empty incidents array.`;

async function main() {
  await dbConnection.connect();

  const [podsResult, nodesResult, eventsResult] = await Promise.allSettled([
    kubectl.getPods('*', CONTEXT, true),
    kubectl.getNodes(CONTEXT),
    kubectl.getEvents(CONTEXT),
  ]);

  const signals = {
    pods:   OrchestratorAgent._summarizePods(podsResult.status === 'fulfilled' ? podsResult.value : null),
    nodes:  OrchestratorAgent._summarizeNodes(nodesResult.status === 'fulfilled' ? nodesResult.value : null),
    events: OrchestratorAgent._summarizeEvents(eventsResult.status === 'fulfilled' ? eventsResult.value : null),
  };
  console.log('=== SIGNALS SENT TO LLM ===');
  console.log(JSON.stringify(signals, null, 2));

  const _config = loadConfig();
  const rawLlm = new ChatOpenAI({
    apiKey:  _config.OPENAI_API_KEY,
    model:   _config.OPENAI_MODEL,
    configuration: _config.OPENAI_BASE_URL ? { baseURL: _config.OPENAI_BASE_URL } : undefined,
    temperature: 0,
    maxTokens: 8000,
  });

  console.log('\n=== CALLING LLM (no structured-output schema) ===');
  const res = await rawLlm.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(signals) },
  ]);

  console.log('\n=== RAW MODEL RESPONSE (content) ===');
  console.log(res.content);
  console.log('\n=== RAW MODEL RESPONSE (tool_calls, if any) ===');
  console.log(JSON.stringify(res.tool_calls ?? res.additional_kwargs, null, 2));
}

main()
  .catch(err => { console.error('DIAG FAILED:', err.stack || err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());

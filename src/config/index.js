'use strict';
const { z } = require('zod');

// Central, validated environment configuration — replaces ad-hoc `process.env.X || default`
// reads scattered across 15+ files. Not every tunable env var in the codebase is modeled
// here yet (there are ~40+); this covers the ones whose absence or malformation should
// fail loudly at boot rather than silently misbehave at request time (missing API keys,
// a NaN interval from a typo'd number, etc.). Unmodeled vars still work via direct
// process.env reads elsewhere — `.passthrough()` below means this schema doesn't reject them.

// zod's z.coerce.boolean() uses JS's Boolean(str) coercion, which treats the STRING
// "false" as truthy — the opposite of what an env var flag means. This codebase's existing
// convention is `=== 'true'`, so match that instead of using z.coerce.boolean().
const boolFlag = (defaultValue) =>
  z.string().optional().transform(v => (v === undefined ? defaultValue : v === 'true'));

const EnvSchema = z.object({
  // Core services
  MONGODB_URI:   z.string().min(1).default('mongodb://localhost:27017/k8s_agent'),
  REDIS_URL:     z.string().min(1).default('redis://localhost:6379'),
  API_PORT:      z.coerce.number().int().positive().default(3001),
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),

  // LLM — core agent functionality, hard requirement
  OPENAI_API_KEY:    z.string().min(1, 'OPENAI_API_KEY is required — add it to .env'),
  OPENAI_MODEL:      z.string().min(1, 'OPENAI_MODEL is required — add it to .env'),
  OPENAI_BASE_URL:   z.string().url().optional(),
  GUARDIAN_API_KEY:  z.string().optional(),
  GUARDIAN_MODEL:    z.string().optional(),
  GUARDIAN_BASE_URL: z.string().url().optional(),
  // Optional cheaper/faster model tier for the Investigator's evidence-gathering and
  // tool-selection work (architecture-doc §7.4) — falls back to OPENAI_* when unset,
  // same pattern GUARDIAN_* already uses.
  INVESTIGATOR_API_KEY:  z.string().optional(),
  INVESTIGATOR_MODEL:    z.string().optional(),
  INVESTIGATOR_BASE_URL: z.string().url().optional(),
  // Same tiering for the Planner's multi-step planning/dry-run/evidence-gathering loop.
  PLANNER_API_KEY:  z.string().optional(),
  PLANNER_MODEL:    z.string().optional(),
  PLANNER_BASE_URL: z.string().url().optional(),
  // Same tiering for the Fast Path's single-call diagnosis (src/agents/fastPath.js) —
  // a good candidate for a cheaper/faster model tier since it's exactly one
  // no-tool-calling structured-output call per SIMPLE incident.
  FASTPATH_API_KEY:  z.string().optional(),
  FASTPATH_MODEL:    z.string().optional(),
  FASTPATH_BASE_URL: z.string().url().optional(),
  // Same tiering for the Phase 4 root-cause-fit advisory check
  // (src/agents/rootCauseFitAssessor.js) — a single narrow structured-output call,
  // logged/traced only, never gates anything. See that file's header for the
  // experiment this is part of.
  ROOTCAUSEFIT_API_KEY:  z.string().optional(),
  ROOTCAUSEFIT_MODEL:    z.string().optional(),
  ROOTCAUSEFIT_BASE_URL: z.string().url().optional(),
  LLM_TIMEOUT_MS:    z.coerce.number().int().positive().default(30_000),

  // LangSmith tracing (KubePilot v5 pipeline) — off by default; set LANGCHAIN_TRACING_V2=true
  // plus LANGCHAIN_API_KEY to enable per-node tracing on the LangGraph StateGraph.
  LANGCHAIN_TRACING_V2: boolFlag(false),
  LANGCHAIN_API_KEY:    z.string().optional(),
  LANGCHAIN_PROJECT:    z.string().default('kubepilot'),

  // Developer-only per-pod decision tracer (src/monitoring/incidentTracer.js) — never
  // surfaced in user-facing output/API, logs/CLI only. TRACE_ENABLED is the master
  // switch (off disables both stdout and file writes with zero overhead); TRACE_STDOUT
  // toggles whether events also print to stdout on top of ./logs/<workflowId>.jsonl,
  // which is always written to when TRACE_ENABLED is on (the `trace` CLI reads from it).
  TRACE_ENABLED: boolFlag(true),
  TRACE_STDOUT:  boolFlag(true),

  // Notification channel secrets encryption — hard requirement (also enforced directly
  // in services/notifications/crypto.js; centralizing the check here surfaces it at the
  // very first boot validation instead of on first notification send).
  NOTIFICATION_SECRET: z.string().min(16, 'NOTIFICATION_SECRET must be a long random value (see: openssl rand -hex 32)'),

  // Orchestrator / cluster cycle tuning
  CYCLE_INTERVAL_MS:   z.coerce.number().int().positive().default(30_000),
  CLUSTER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  ISSUE_CONCURRENCY:   z.coerce.number().int().positive().default(3),

  // Analyzer thresholds (nodeAnalyzer.js, clusterAnalyzer.js, eventAnalyzer.js) —
  // previously each read process.env directly with its own inline parseInt/parseFloat.
  NODE_CPU_SAT_THRESHOLD:  z.coerce.number().min(0).max(1).default(0.90),
  NODE_MEM_SAT_THRESHOLD:  z.coerce.number().min(0).max(1).default(0.90),
  NODE_FLAP_TRANSITIONS:   z.coerce.number().int().positive().default(2),
  NODE_FLAP_WINDOW_MS:     z.coerce.number().int().positive().default(10 * 60 * 1000),
  MASS_FAILURE_THRESHOLD:  z.coerce.number().int().positive().default(5),
  EVENT_MAX_AGE_MS:        z.coerce.number().int().positive().default(30 * 60 * 1000),
  EVENT_MIN_COUNT:         z.coerce.number().int().positive().default(3),
  EVENT_RECENT_WINDOW_MS:  z.coerce.number().int().positive().default(2 * 60 * 1000),

  // Monitoring
  PROMETHEUS_URL:       z.string().url().default('http://localhost:9090'),
  PROMETHEUS_NAMESPACE: z.string().default('monitoring'),

  // Feature flags
  // ORCHESTRATOR_V5_ENABLED is no longer env-driven — the v5 pipeline always runs
  // (index.js calls OrchestratorAgent.start() unconditionally).
  //
  // PolicyEngine.dryRunMode defaults to `true` (simulate — see §Fix-DryRunDefault,
  // src/policy/policyEngine.js) and is NOT overridable via a generic "dry run" toggle
  // on purpose. ALLOW_LIVE_KUBECTL_EXECUTION is the one narrow exception: set it to
  // "true" only when intentionally running a real-cluster benchmark (dual-cluster-
  // must-fix-demo.js / agent-benchmark-advanced1.js) against a server booted for that
  // purpose — never in a normal deployment's .env.
  ALLOW_LIVE_KUBECTL_EXECUTION: boolFlag(false),
  CAPACITY_FORECAST_ENABLED:   boolFlag(false),
  CHANGE_CORRELATION_ENABLED:  boolFlag(false),
  RBAC_DRIFT_ENABLED:          boolFlag(false),
  RBAC_WATCH_ENABLED:          boolFlag(false),
  CONNECTIVITY_ALERTS_ENABLED: boolFlag(false),
  RBAC_POSTURE_ENABLED:        boolFlag(false),
  WORKLOAD_HARDENING_ENABLED:  boolFlag(false),
  NETWORK_EXPOSURE_ENABLED:    boolFlag(false),
  SECRETS_HYGIENE_ENABLED:     boolFlag(false),
  POLICY_AWARENESS_ENABLED:    boolFlag(false),
  FALLBACK_ENABLED:            boolFlag(true),

  // Agent Mesh (src/mesh/) — per-agent switch between running in-process ("local", the
  // default and today's behavior) and calling that agent's own service over the Redis
  // Streams bus ("remote"). Validated here so a typo ("remot") fails loudly at boot
  // instead of silently staying local; read via process.env in src/mesh/agentClient.js.
  // Persist LangGraph workflow state to MongoDB and resume in-flight workflows after an
  // orchestrator restart (src/orchestrator/checkpointing.js). "false" = old behavior.
  WORKFLOW_RESUME_ENABLED:  boolFlag(true),
  // Kubernetes identity for the read/write gateways and detection
  // (src/services/clusterIdentity.js): "bootstrap" = today's shared credential;
  // "serviceaccount" = per-role kubepilot-reader / kubepilot-executor tokens minted via
  // TokenRequest (requires deploy/k8s/target-cluster-rbac.yaml on each cluster).
  CLUSTER_IDENTITY_MODE:      z.enum(['bootstrap', 'serviceaccount']).default('bootstrap'),
  CLUSTER_IDENTITY_NAMESPACE: z.string().min(1).default('kubepilot-system'),
  MESH_REDIS_URL:           z.string().min(1).optional(), // defaults to REDIS_URL
  MESH_LEASE_MS:            z.coerce.number().int().positive().default(30_000),
  AGENT_FASTPATH_MODE:      z.enum(['local', 'remote']).default('local'),
  AGENT_INVESTIGATOR_MODE:  z.enum(['local', 'remote']).default('local'),
  AGENT_PLANNER_MODE:       z.enum(['local', 'remote']).default('local'),
  AGENT_GUARDIAN_MODE:      z.enum(['local', 'remote']).default('local'),
  AGENT_REFLECTION_MODE:    z.enum(['local', 'remote']).default('local'),
  AGENT_K8S_READ_MODE:      z.enum(['local', 'remote']).default('local'),
  AGENT_K8S_WRITE_MODE:     z.enum(['local', 'remote']).default('local'),

  // Optional integrations — no default, feature is just unavailable if unset
  QDRANT_URL:        z.string().url().optional(),
  QDRANT_API_KEY:     z.string().optional(),
  EMBEDDING_API_KEY:  z.string().optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL:    z.string().optional(),
  EMAIL_HOST:         z.string().optional(),
  EMAIL_PORT:         z.coerce.number().int().positive().optional(),
  EMAIL_USER:         z.string().optional(),
  EMAIL_PASS:         z.string().optional(),
  EMAIL_FROM:         z.string().optional(),
  TEAMS_WEBHOOK_URL:  z.string().url().optional(),
}).passthrough();

let _config = null;

// Validates process.env once (cached after first call) and returns a frozen, typed config
// object. Throws with every problem listed at once — call this as early as possible at
// boot (index.js) so a bad .env fails loudly before anything else starts.
function loadConfig() {
  if (_config) return _config;

  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[Config] Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error('Invalid environment configuration — see errors above');
  }

  _config = Object.freeze(result.data);
  return _config;
}

module.exports = { loadConfig };

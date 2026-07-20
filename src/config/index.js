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
  API_PORT:      z.coerce.number().int().positive().default(3001),
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),

  // LLM — core agent functionality, hard requirement
  OPENAI_API_KEY:    z.string().min(1, 'OPENAI_API_KEY is required — add it to .env'),
  OPENAI_MODEL:      z.string().min(1, 'OPENAI_MODEL is required — add it to .env'),
  OPENAI_BASE_URL:   z.string().url().optional(),
  GUARDIAN_API_KEY:  z.string().optional(),
  GUARDIAN_MODEL:    z.string().optional(),
  GUARDIAN_BASE_URL: z.string().url().optional(),
  LLM_TIMEOUT_MS:    z.coerce.number().int().positive().default(30_000),

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
  CAPACITY_FORECAST_ENABLED:   boolFlag(false),
  CHANGE_CORRELATION_ENABLED:  boolFlag(false),
  RBAC_DRIFT_ENABLED:          boolFlag(false),
  CONNECTIVITY_ALERTS_ENABLED: boolFlag(false),
  POLICY_AWARENESS_ENABLED:    boolFlag(false),
  FALLBACK_ENABLED:            boolFlag(true),
  POLICY_DRY_RUN:              boolFlag(false),

  // Optional integrations — no default, feature is just unavailable if unset
  QDRANT_URL:         z.string().url().optional(),
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

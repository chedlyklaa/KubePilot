'use strict';
const { z } = require('zod');

// Parse a boolean env flag
const boolFlag = (defaultValue) =>
  z.string().optional().transform(v => (v === undefined ? defaultValue : v === 'true'));

const EnvSchema = z.object({
  MONGODB_URI:   z.string().min(1).default('mongodb://localhost:27017/k8s_agent'),
  REDIS_URL:     z.string().min(1).default('redis://localhost:6379'),
  API_PORT:      z.coerce.number().int().positive().default(3001),
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),

  OPENAI_API_KEY:    z.string().min(1, 'OPENAI_API_KEY is required — add it to .env'),
  OPENAI_MODEL:      z.string().min(1, 'OPENAI_MODEL is required — add it to .env'),
  OPENAI_BASE_URL:   z.string().url().optional(),
  GUARDIAN_API_KEY:  z.string().optional(),
  GUARDIAN_MODEL:    z.string().optional(),
  GUARDIAN_BASE_URL: z.string().url().optional(),
  INVESTIGATOR_API_KEY:  z.string().optional(),
  INVESTIGATOR_MODEL:    z.string().optional(),
  INVESTIGATOR_BASE_URL: z.string().url().optional(),
  PLANNER_API_KEY:  z.string().optional(),
  PLANNER_MODEL:    z.string().optional(),
  PLANNER_BASE_URL: z.string().url().optional(),
  FASTPATH_API_KEY:  z.string().optional(),
  FASTPATH_MODEL:    z.string().optional(),
  FASTPATH_BASE_URL: z.string().url().optional(),
  ROOTCAUSEFIT_API_KEY:  z.string().optional(),
  ROOTCAUSEFIT_MODEL:    z.string().optional(),
  ROOTCAUSEFIT_BASE_URL: z.string().url().optional(),
  LLM_TIMEOUT_MS:    z.coerce.number().int().positive().default(30_000),

  LANGCHAIN_TRACING_V2: boolFlag(false),
  LANGCHAIN_API_KEY:    z.string().optional(),
  LANGCHAIN_PROJECT:    z.string().default('kubepilot'),

  TRACE_ENABLED: boolFlag(true),
  TRACE_STDOUT:  boolFlag(true),

  NOTIFICATION_SECRET: z.string().min(16, 'NOTIFICATION_SECRET must be a long random value (see: openssl rand -hex 32)'),

  CYCLE_INTERVAL_MS:   z.coerce.number().int().positive().default(30_000),
  CLUSTER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  ISSUE_CONCURRENCY:   z.coerce.number().int().positive().default(3),

  NODE_CPU_SAT_THRESHOLD:  z.coerce.number().min(0).max(1).default(0.90),
  NODE_MEM_SAT_THRESHOLD:  z.coerce.number().min(0).max(1).default(0.90),
  NODE_FLAP_TRANSITIONS:   z.coerce.number().int().positive().default(2),
  NODE_FLAP_WINDOW_MS:     z.coerce.number().int().positive().default(10 * 60 * 1000),
  MASS_FAILURE_THRESHOLD:  z.coerce.number().int().positive().default(5),
  EVENT_MAX_AGE_MS:        z.coerce.number().int().positive().default(30 * 60 * 1000),
  EVENT_MIN_COUNT:         z.coerce.number().int().positive().default(3),
  EVENT_RECENT_WINDOW_MS:  z.coerce.number().int().positive().default(2 * 60 * 1000),

  PROMETHEUS_URL:       z.string().url().default('http://localhost:9090'),
  PROMETHEUS_NAMESPACE: z.string().default('monitoring'),

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

// Load and validate the environment config
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

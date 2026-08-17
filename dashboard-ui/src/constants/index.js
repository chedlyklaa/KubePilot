export const STATES = [
  { key: 'in_progress', label: 'Working on it', color: 'primary' },
  { key: 'fixed',       label: 'Fixed ✓',        color: 'success' },
  { key: 'not_fixed',   label: 'Not Fixed',      color: 'danger'  },
  { key: 'need_help',   label: 'Need Help',      color: 'warn'    },
]

export const STATE_LABEL = {
  pending:      'Pending',
  acknowledged: 'Acknowledged',
  in_progress:  'In Progress',
  fixed:        'Fixed',
  not_fixed:    'Not Fixed',
  need_help:    'Need Help',
}

export const RISK_COLOR = { LOW: 'success', MEDIUM: 'warn', HIGH: 'danger' }

// Issue tracker lifecycle — see src/db/models/history.js IssueTrackerSchema for the
// authoritative state list.
export const ISSUE_STATUS = {
  detected:          { label: 'Detected',           color: 'info'    },
  investigating:     { label: 'Investigating',       color: 'info'    },
  awaiting_approval: { label: 'Awaiting Approval',   color: 'warn'    },
  approved:          { label: 'Approved',            color: 'primary' },
  blocked:           { label: 'Blocked',             color: 'warn'    },
  skipped:           { label: 'Skipped',             color: 'dim'     },
  failed:            { label: 'Retrying',            color: 'danger'  },
  success:           { label: 'Fix Applied',         color: 'primary' },
  escalated:         { label: 'Escalated',           color: 'danger'  },
  fixed:             { label: 'Fixed',               color: 'success' },
}

export const SEVERITY_COLOR = { critical: 'var(--danger)', high: 'var(--danger)', medium: 'var(--warn)', low: 'var(--text-dim)' }

export const CATEGORY_ICON = {
  'read-only':      { icon: '👁',  label: 'Read-only'     },
  'rolling-update': { icon: '♻',  label: 'Rolling update' },
  'scaling':        { icon: '⇅',  label: 'Scaling'        },
  'config-change':  { icon: '⚙',  label: 'Config change'  },
  'destructive':    { icon: '⚠',  label: 'Destructive'    },
  'provision':      { icon: '🔧', label: 'Provision cluster' },
}

export const LOG_LEVELS = ['ALL', 'INFO', 'WARN', 'ERROR']

// Scaleway Generative APIs per-1M-token pricing (EUR), keyed by agent — mirrors
// which model each agent is actually configured to use (OPENAI_MODEL for
// planner/investigator, GUARDIAN_MODEL for guardian/reflection in .env).
// Update these if .env is repointed at different models.
export const AGENT_PRICING = {
  planner:      { model: 'qwen3-235b-a22b-instruct-2507',        inputPerM: 0.75, outputPerM: 2.25 },
  investigator: { model: 'qwen3-235b-a22b-instruct-2507',        inputPerM: 0.75, outputPerM: 2.25 },
  guardian:     { model: 'mistral-small-3.2-24b-instruct-2506',  inputPerM: 0.15, outputPerM: 0.35 },
  reflection:   { model: 'mistral-small-3.2-24b-instruct-2506',  inputPerM: 0.15, outputPerM: 0.35 },
}

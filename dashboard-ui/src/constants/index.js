export const STATE_LABEL = {
  pending:      'Pending',
  acknowledged: 'Acknowledged',
  in_progress:  'In Progress',
  fixed:        'Fixed',
  not_fixed:    'Not Fixed',
  need_help:    'Need Help',
}

export const RISK_COLOR = { LOW: 'success', MEDIUM: 'warn', HIGH: 'danger' }

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

export const WORKFLOW_STEP = {
  orchestrator: { icon: '🛰',  label: 'Detected' },
  investigator: { icon: '🔎', label: 'Investigator' },
  planner:      { icon: '🧩', label: 'Planner' },
  guardian:     { icon: '🛡',  label: 'Guardian' },
  policy:       { icon: '📋', label: 'Policy' },
  executor:     { icon: '⚙',  label: 'Executor' },
  reflector:    { icon: '🪞', label: 'Reflexion' },
}
export const WORKFLOW_STEP_ORDER = ['orchestrator', 'investigator', 'planner', 'guardian', 'policy', 'executor', 'reflector']

export const AGENT_PRICING = {
  planner:      { model: 'qwen3-235b-a22b-instruct-2507',        inputPerM: 0.75, outputPerM: 2.25 },
  investigator: { model: 'qwen3-235b-a22b-instruct-2507',        inputPerM: 0.75, outputPerM: 2.25 },
  guardian:     { model: 'mistral-small-3.2-24b-instruct-2506',  inputPerM: 0.15, outputPerM: 0.35 },
  reflection:   { model: 'mistral-small-3.2-24b-instruct-2506',  inputPerM: 0.15, outputPerM: 0.35 },
}

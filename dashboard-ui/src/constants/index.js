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

export const CATEGORY_ICON = {
  'read-only':      { icon: '👁',  label: 'Read-only'     },
  'rolling-update': { icon: '♻',  label: 'Rolling update' },
  'scaling':        { icon: '⇅',  label: 'Scaling'        },
  'config-change':  { icon: '⚙',  label: 'Config change'  },
  'destructive':    { icon: '⚠',  label: 'Destructive'    },
  'provision':      { icon: '🔧', label: 'Provision cluster' },
}

export const LOG_LEVELS = ['ALL', 'INFO', 'WARN', 'ERROR']

// Pick bar color from usage percentage
const THRESHOLD_COLOR = pct => pct >= 90 ? 'var(--danger)' : pct >= 75 ? 'var(--warn)' : 'var(--success)'

// Progress bar from a percentage
export function PercentBar({ value, label, size = 'md' }) {
  const v = value ?? 0
  return (
    <div className={`cp-bar cp-bar-${size}`}>
      <div className="cp-bar-track">
        <div className="cp-bar-fill" style={{ width: `${Math.min(100, v)}%`, background: THRESHOLD_COLOR(v) }} />
      </div>
      <span className="cp-bar-label">{label ?? (value != null ? `${v}%` : '—')}</span>
    </div>
  )
}

// Parse a Kubernetes quantity string into a number
export function parseQty(str) {
  if (str == null) return null
  const m = String(str).match(/^([\d.]+)([A-Za-z]*)$/)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2]
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, m: 0.001 }
  return mult[unit] ? n * mult[unit] : n
}

// Progress bar from used and hard quota values
export function QuotaBar({ used, hard }) {
  const u = parseQty(used), h = parseQty(hard)
  const pct = u != null && h ? Math.min(100, (u / h) * 100) : null
  return <PercentBar value={pct ?? 0} label={`${used ?? '—'} / ${hard ?? '—'}`} size="sm" />
}

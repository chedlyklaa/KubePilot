// Shared color-threshold progress bar — CapacityPage, AutoscalingPage, and
// PoliciesPage each used to define a near-identical local copy of this.
const THRESHOLD_COLOR = pct => pct >= 90 ? 'var(--danger)' : pct >= 75 ? 'var(--warn)' : 'var(--success)'

// Percentage-driven bar: caller already has a 0-100 number (CPU/mem %, forecast %).
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

// Parse a Kubernetes resource quantity string ("500m", "2Gi", "4") into a raw number.
export function parseQty(str) {
  if (str == null) return null
  const m = String(str).match(/^([\d.]+)([A-Za-z]*)$/)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2]
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, m: 0.001 }
  return mult[unit] ? n * mult[unit] : n
}

// Quantity-driven bar: caller has raw "used"/"hard" quantity strings (ResourceQuota).
export function QuotaBar({ used, hard }) {
  const u = parseQty(used), h = parseQty(hard)
  const pct = u != null && h ? Math.min(100, (u / h) * 100) : null
  return <PercentBar value={pct ?? 0} label={`${used ?? '—'} / ${hard ?? '—'}`} size="sm" />
}

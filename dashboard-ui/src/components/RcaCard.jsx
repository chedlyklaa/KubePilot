const RISK_COLOR = { low: '#22c55e', medium: '#f59e0b', high: '#f97316', critical: '#ef4444' }

function fmtEta(hours) {
  if (hours == null) return null
  if (hours < 1)   return `${Math.round(hours * 60)}m`
  if (hours < 24)  return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

export default function RcaCard({ rca }) {
  if (!rca) return null
  const pct         = Math.round((rca.confidence ?? 0) * 100)
  const inconclusive = pct === 0
  const color       = inconclusive ? 'var(--text-dim)' : (RISK_COLOR[rca.risk_level] ?? RISK_COLOR.medium)
  const cap         = rca.capacityContext
  return (
    <div className={`rca-card${inconclusive ? ' rca-card-inconclusive' : ''}`}>
      <div className="rca-header">
        <span className="rca-title">Root Cause Analysis</span>
        <span className="rca-badge" style={{ background: color }}>
          {inconclusive ? 'inconclusive' : (rca.risk_level ?? 'unknown')}
        </span>
      </div>
      <div className="rca-cause">{rca.suspected_cause}</div>
      <div className="rca-confidence-row">
        <span className="rca-conf-label">Confidence</span>
        <div className="rca-conf-bar-wrap">
          <div className="rca-conf-bar" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="rca-conf-pct">{pct}%</span>
      </div>
      {rca.evidence?.length > 0 && (
        <ul className="rca-evidence">
          {rca.evidence.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {rca.recommended_focus && (
        <div className="rca-focus">{rca.recommended_focus}</div>
      )}
      {cap && (
        <div className={`rca-capacity-warn rca-cap-${cap.alertLevel.toLowerCase()}`}>
          <span className="rca-cap-icon">{cap.alertLevel === 'CRITICAL' ? '🔴' : '🟠'}</span>
          <span className="rca-cap-body">
            <strong>Capacity {cap.alertLevel}</strong>
            {' — '}
            {cap.resource} at {cap.currentPct}%
            {cap.slope > 0 && ` (+${cap.slope}%/h)`}
            {cap.hoursToExhaustion != null && ` · saturation in ~${fmtEta(cap.hoursToExhaustion)}`}
          </span>
        </div>
      )}
    </div>
  )
}

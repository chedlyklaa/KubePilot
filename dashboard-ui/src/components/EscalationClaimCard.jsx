import { useState } from 'react'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { fmtTime } from '../utils/format'
import { Row } from './Row'

export default function EscalationClaimCard({ item, onTake }) {
  const notify          = useNotify()
  const [busy, setBusy] = useState(false)

  async function take() {
    setBusy(true)
    try {
      const r = await apiFetch(`/api/escalations/${item.id}/acknowledge`, { method: 'POST' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        notify('error', d.error || 'Failed to claim — please try again')
        return
      }
      notify('success', `You claimed: ${item.issueKey}`)
      onTake(item.id)
    } catch {
      notify('error', 'Network error — could not claim escalation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card escalation-card">
      <div className="card-head">
        <span className="card-type esc-type">{item.issue?.type ?? 'Unknown'}</span>
        <span className="card-time">{fmtTime(item.createdAt)}</span>
      </div>
      <div className="card-body">
        <Row label="Key"       val={item.issueKey} mono />
        <Row label="Namespace" val={item.issue?.namespace ?? 'default'} />
        <div className="card-row">
          <span className="card-label">Attempts</span>
          <span className="card-value esc-attempts">{item.attempts} failed</span>
        </div>
      </div>
      <div className="card-actions">
        <button className="btn-take" disabled={busy} onClick={take}>
          Take it — I'll handle this
        </button>
      </div>
    </div>
  )
}

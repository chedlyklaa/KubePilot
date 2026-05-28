import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { fmtTime } from '../utils/format'
import { Row } from './Row'

export default function ApprovalCard({ approval, onSettle }) {
  const { user }        = useAuth()
  const notify          = useNotify()
  const [busy, setBusy] = useState(false)
  const { id, payload, createdAt } = approval
  const { issue, diagnosis } = payload

  async function handle(action) {
    setBusy(true)
    await apiFetch(`/api/approvals/${id}/${action}`, { method: 'POST' })
    notify(action === 'approve' ? 'success' : 'warn', `${action === 'approve' ? 'Approved' : 'Denied'}: ${payload.issueKey}`)
    onSettle(id)
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-type">{issue?.type ?? 'Unknown'}</span>
        <span className="card-time">{fmtTime(createdAt)}</span>
      </div>
      <div className="card-body">
        <Row label="Cluster"    val={issue?.clusterName ?? '—'} />
        <Row label="Namespace"  val={issue?.namespace ?? 'default'} />
        <Row label="Deployment" val={issue?.deployment ?? issue?.podName ?? '—'} />
        <Row label="Action"     val={diagnosis?.action ?? '—'} />
        <div className="card-row">
          <span className="card-label">Risk</span>
          <span className={`card-risk ${diagnosis?.risk ?? 'HIGH'}`}>{diagnosis?.risk ?? 'HIGH'}</span>
        </div>
        {diagnosis?.rootCause && <div className="card-diagnosis">{diagnosis.rootCause}</div>}
      </div>
      <div className="card-actions">
        {user.role === 'admin'
          ? <>
              <button className="btn-approve" disabled={busy} onClick={() => handle('approve')}>Approve</button>
              <button className="btn-deny"    disabled={busy} onClick={() => handle('deny')}>Deny</button>
            </>
          : <div className="card-readonly">Awaiting admin approval</div>
        }
      </div>
    </div>
  )
}

import { useState } from 'react'
import { SEVERITY_COLOR } from '../constants'

// Shared render for every security-finding page (RBAC posture, Workload
// Hardening, and future families) — the same severity/resource/description/
// CIS-control/status/actions shape works for all of them, so this replaces
// what would otherwise be a near-identical table hand-rolled per page.
export default function SecurityFindingsTable({ findings, loading, error, emptyMessage, onAccept, onRescan, onEscalate, busyId }) {
  const [acceptTarget, setAcceptTarget] = useState(null)
  const [acceptReason, setAcceptReason] = useState('')
  const [acceptBusy,   setAcceptBusy]   = useState(false)

  async function submitAccept() {
    if (!acceptTarget) return
    setAcceptBusy(true)
    const ok = await onAccept(acceptTarget, acceptReason)
    setAcceptBusy(false)
    if (ok) { setAcceptTarget(null); setAcceptReason('') }
  }

  if (loading) return <div className="page-loading">Scanning…</div>
  if (error) return <div className="health-error">{error}</div>
  if (!findings || findings.length === 0) {
    return <div className="empty-state">{emptyMessage ?? 'No open findings.'}</div>
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Severity</th><th>Resource</th><th>Description</th><th>CIS Control</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {findings.map(f => (
              <tr key={f._id} className={f.severity === 'critical' || f.severity === 'high' ? 'rbac-row-danger' : ''}>
                <td>
                  <span className="cm-current-badge" style={{ background: 'transparent', border: `1px solid ${SEVERITY_COLOR[f.severity] ?? 'var(--border)'}`, color: SEVERITY_COLOR[f.severity] ?? 'var(--text)' }}>
                    {f.severity}
                  </span>
                </td>
                <td className="mono-small">{f.resource?.kind}/{f.resource?.name}{f.resource?.namespace ? <span className="text-dim"> ({f.resource.namespace})</span> : ''}</td>
                <td style={{ maxWidth: 420 }}>{f.description}</td>
                <td className="text-dim mono-small">{f.cisControl ?? '—'}</td>
                <td>
                  {f.status === 'accepted'
                    ? <span className="role-badge role-viewer" title={f.acceptedReason ?? ''}>accepted{f.acceptedBy?.name ? ` by ${f.acceptedBy.name}` : ''}</span>
                    : <span className={`role-badge ${f.status === 'resolved' ? 'role-viewer' : 'role-admin'}`}>{f.status}</span>}
                </td>
                <td>
                  <div className="action-btns">
                    {f.status === 'open' && (
                      <button className="btn-sm" onClick={() => { setAcceptTarget(f); setAcceptReason('') }}>Accept Risk</button>
                    )}
                    <button className="btn-sm" disabled={busyId === f._id} onClick={() => onRescan(f)}>
                      {busyId === f._id ? '…' : '↺ Re-scan'}
                    </button>
                    {f.status === 'open' && (
                      <button className="btn-sm btn-danger" disabled={busyId === f._id} onClick={() => onEscalate(f)}>
                        Escalate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {acceptTarget && (
        <div className="modal-backdrop" onClick={() => setAcceptTarget(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>Accept Risk</span>
              <button className="modal-close" onClick={() => setAcceptTarget(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="rbac-apply-hint">{acceptTarget.description}</p>
              <p className="text-dim" style={{ fontSize: 12, marginBottom: 6 }}>
                This marks the finding as a deliberately accepted risk — it stops appearing as open, but a future
                re-scan will bring it back to "open" if it ever changes.
              </p>
              <textarea
                className="rbac-yaml-editor"
                placeholder="Why is this an acceptable risk? (optional but recommended)"
                value={acceptReason}
                onChange={e => setAcceptReason(e.target.value)}
                rows={4}
              />
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setAcceptTarget(null)}>Cancel</button>
              <button className="btn-primary-sm" onClick={submitAccept} disabled={acceptBusy}>
                {acceptBusy ? 'Saving…' : 'Accept Risk'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

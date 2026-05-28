import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import { STATE_LABEL } from '../constants'

export default function EscalationRow({ item, onRemove, users }) {
  const { user }              = useAuth()
  const notify                = useNotify()
  const [busy,     setBusy]   = useState(false)
  const [open,     setOpen]   = useState(false)
  const [assignId, setAssignId] = useState(users[0]?._id || '')

  useEffect(() => { if (users.length) setAssignId(users[0]._id) }, [users])

  const isAssigned = item.assignedTo?.userId === user.id
  const canEdit    = isAssigned

  async function changeState(e) {
    const state = e.target.value
    setBusy(true)
    await apiFetch(`/api/escalations/${item.id}/state`, { method: 'PUT', body: { state } })
    notify('success', `Status → ${STATE_LABEL[state]}`)
    if (state === 'fixed') onRemove(item.id)
    setBusy(false)
  }

  async function reassign() {
    if (!assignId) return
    setBusy(true)
    await apiFetch(`/api/escalations/${item.id}/assign`, { method: 'PUT', body: { userId: assignId } })
    notify('success', `Reassigned to ${users.find(u => u._id === assignId)?.name}`)
    setBusy(false)
  }

  async function requestReassign() {
    setBusy(true)
    await apiFetch(`/api/escalations/${item.id}/request-reassign`, { method: 'POST' })
    notify('info', 'Reassignment request sent to admins')
    setBusy(false)
  }

  return (
    <>
      <tr className={item.reassignRequested ? 'row-warn' : ''}>
        <td>
          <span className="esc-type fw-500">{item.issue?.type ?? 'Unknown'}</span>
          <div className="mono-small text-dim" style={{ marginTop: 2 }}>{item.issueKey}</div>
        </td>

        <td className="text-dim">{item.issue?.namespace ?? 'default'}</td>

        <td style={{ textAlign: 'center' }}>
          {item.attempts > 0
            ? <button className="attempts-btn" onClick={() => setOpen(o => !o)} title="Show attempt history">
                {item.attempts} {open ? '▲' : '▼'}
              </button>
            : <span className="text-dim">0</span>
          }
        </td>

        <td>
          {canEdit && item.status !== 'pending'
            ? <select value={item.status} onChange={changeState} disabled={busy} className={`state-select state-select-${item.status}`}>
                <option value="acknowledged">Acknowledged</option>
                <option value="in_progress">Working on it</option>
                <option value="not_fixed">Not Fixed</option>
                <option value="need_help">Need Help</option>
                <option value="fixed">Fixed ✓</option>
              </select>
            : <span className={`state-badge state-${item.status}`}>{STATE_LABEL[item.status] ?? item.status}</span>
          }
        </td>

        <td>
          {item.assignedTo
            ? <span>
                {item.assignedTo.name}
                <span className={`role-badge role-${item.assignedTo.role}`} style={{ marginLeft: 5 }}>{item.assignedTo.role}</span>
                {isAssigned && <span className="you-badge">you</span>}
              </span>
            : <span className="text-dim">Unassigned</span>
          }
          {item.reassignRequested && (
            <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 3 }}>⚠ Reassign requested</div>
          )}
        </td>

        {user.role === 'admin' && (
          <td>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <select value={assignId} onChange={e => setAssignId(e.target.value)} className="reassign-select" style={{ fontSize: 12, padding: '3px 6px' }}>
                {users.map(u => <option key={u._id} value={u._id}>{u.name}</option>)}
              </select>
              <button className="btn-sm btn-primary-sm" disabled={busy} onClick={reassign}>→</button>
            </div>
          </td>
        )}

        <td className="text-dim">{fmtDT(item.createdAt)}</td>

        <td>
          {user.role === 'developer' && isAssigned && !item.reassignRequested && (
            <button className="btn-sm" disabled={busy} onClick={requestReassign} style={{ whiteSpace: 'nowrap' }}>
              Request Reassign
            </button>
          )}
        </td>
      </tr>

      {open && item.history?.length > 0 && (
        <tr className="history-expand-row">
          <td colSpan={user.role === 'admin' ? 8 : 7} style={{ padding: 0 }}>
            <div className="history-expand">
              {item.history.map((h, i) => (
                <div key={i} className="history-item">
                  <span className="history-num">#{h.attempt}</span>
                  <span className="history-action">{h.action}</span>
                  <span className="history-outcome">{h.outcome}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

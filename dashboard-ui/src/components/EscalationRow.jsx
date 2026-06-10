import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import { STATE_LABEL } from '../constants'

const STATUS_OPTIONS = [
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'in_progress',  label: 'Working on it' },
  { value: 'not_fixed',    label: 'Not Fixed'     },
  { value: 'need_help',    label: 'Need Help'      },
  { value: 'fixed',        label: 'Fixed ✓'        },
]

function StatusDropdown({ value, onChange, disabled }) {
  const [open,    setOpen]  = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const triggerRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e) {
      if (triggerRef.current && !triggerRef.current.contains(e.target)) setOpen(false)
    }
    function onScroll() { setOpen(false) }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  function toggle() {
    if (disabled) return
    if (!open) {
      const rect = triggerRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, left: rect.left })
    }
    setOpen(o => !o)
  }

  function select(val) {
    setOpen(false)
    if (val !== value) onChange(val)
  }

  return (
    <div className={`sd-wrap sd-${value} ${disabled ? 'sd-disabled' : ''}`} ref={triggerRef}>
      <button className="sd-trigger" onClick={toggle} disabled={disabled} type="button">
        <span className="sd-label">{STATE_LABEL[value] ?? value}</span>
        <span className="sd-arrow">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div
          className="sd-menu"
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
        >
          {STATUS_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`sd-option sd-option-${opt.value} ${opt.value === value ? 'sd-option-active' : ''}`}
              onClick={() => select(opt.value)}
              type="button"
            >
              {opt.label}
              {opt.value === value && <span className="sd-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function EscalationRow({ item, onRemove, users }) {
  const { user }              = useAuth()
  const notify                = useNotify()
  const [busy,        setBusy]      = useState(false)
  const [open,        setOpen]      = useState(false)
  const [assignId,    setAssignId]  = useState(users[0]?._id || '')
  const [showDelModal, setShowDelModal] = useState(false)

  useEffect(() => { if (users.length) setAssignId(users[0]._id) }, [users])

  const isAssigned = item.assignedTo?.userId === user.id
  const canEdit    = isAssigned

  async function changeState(state) {
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

  async function deleteEscalation() {
    setBusy(true)
    const res = await apiFetch(`/api/escalations/${item.id}`, { method: 'DELETE' })
    if (res.ok) {
      notify('success', `Escalation deleted: ${item.issueKey}`)
      onRemove(item.id)
    } else {
      notify('error', 'Failed to delete escalation')
    }
    setBusy(false)
    setConfirmDelete(false)
  }

  return (
    <>
      {showDelModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowDelModal(false)}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <div style={{ fontSize: 32, textAlign: 'center', marginBottom: 8 }}>🗑</div>
            <h3 style={{ margin: '0 0 6px', textAlign: 'center' }}>Delete Escalation?</h3>
            <p style={{ margin: '0 0 20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
              <strong>{item.issueKey}</strong> will be permanently removed.
            </p>
            <div className="signout-actions">
              <button className="btn-secondary" onClick={() => setShowDelModal(false)}>Cancel</button>
              <button className="btn-danger-solid" disabled={busy} onClick={deleteEscalation}>Delete</button>
            </div>
          </div>
        </div>
      )}
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
            ? <StatusDropdown value={item.status} onChange={changeState} disabled={busy} />
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
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {user.role === 'developer' && isAssigned && !item.reassignRequested && (
              <button className="btn-sm" disabled={busy} onClick={requestReassign} style={{ whiteSpace: 'nowrap' }}>
                Request Reassign
              </button>
            )}
            {user.role === 'admin' && (
              <button className="btn-sm btn-danger-sm" disabled={busy} onClick={() => setShowDelModal(true)} title="Delete escalation">
                Delete
              </button>
            )}
          </div>
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

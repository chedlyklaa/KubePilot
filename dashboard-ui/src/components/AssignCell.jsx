import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'

export default function AssignCell({ record, users, onAssigned }) {
  const { user }              = useAuth()
  const notify                = useNotify()
  const [editing, setEditing] = useState(false)
  const [selId,   setSelId]   = useState('')
  const [busy,    setBusy]    = useState(false)

  function startEdit() {
    setSelId(record.assignedTo?.userId || users[0]?._id || '')
    setEditing(true)
  }

  async function save() {
    if (!selId) return
    setBusy(true)
    const res = await apiFetch(`/api/history/escalations/${record._id}/assign`, { method: 'PUT', body: { userId: selId } })
    if (res.ok) {
      const { assignedTo } = await res.json()
      onAssigned(record._id, assignedTo)
      notify('success', `Assigned to ${assignedTo.name}`)
    }
    setEditing(false); setBusy(false)
  }

  if (user.role !== 'admin') {
    return record.assignedTo
      ? <span>{record.assignedTo.name} <span className={`role-badge role-${record.assignedTo.role}`}>{record.assignedTo.role}</span></span>
      : <span className="text-dim">—</span>
  }

  if (!editing) {
    return (
      <div className="assign-cell" onClick={startEdit} title="Click to reassign">
        {record.assignedTo
          ? <><span className="fw-500">{record.assignedTo.name}</span> <span className={`role-badge role-${record.assignedTo.role}`}>{record.assignedTo.role}</span> <span className="assign-edit-hint">✎</span></>
          : <span className="assign-placeholder">+ Assign</span>
        }
      </div>
    )
  }

  return (
    <div className="assign-inline">
      <select value={selId} onChange={e => setSelId(e.target.value)} autoFocus>
        {users.map(u => <option key={u._id} value={u._id}>{u.name} ({u.role})</option>)}
      </select>
      <button className="assign-confirm" disabled={busy} onClick={save}>✓</button>
      <button className="assign-cancel"  onClick={() => setEditing(false)}>✕</button>
    </div>
  )
}

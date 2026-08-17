import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import UserProfileModal from '../components/UserProfileModal'
import ConfirmDialog from '../components/ConfirmDialog'

export default function UsersPage() {
  const { user: me }              = useAuth()
  const notify                    = useNotify()
  const location                  = useLocation()
  const navigate                  = useNavigate()
  const [users, setUsers]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [editing, setEditing]     = useState(null)
  const [viewUser, setViewUser]   = useState(null)   // userId being viewed in profile modal
  const [form, setForm]           = useState({ name: '', email: '', password: '', role: 'developer' })
  const [formErr, setFormErr]     = useState('')
  const [clusters, setClusters]   = useState([])
  const [issueCert, setIssueCert] = useState(false)
  const [certContext, setCertContext] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null) // user pending delete confirmation

  const load = () => apiFetch('/api/users').then(r => r.json()).then(d => { setUsers(d); setLoading(false) })
  useEffect(() => { load() }, [])
  useEffect(() => {
    apiFetch('/api/kube/contexts').then(r => r.json())
      .then(d => setClusters((d.contexts ?? []).filter(c => c.isMonitored)))
      .catch(() => {})
  }, [])

  // Handoff from RbacSyncPage's "new users detected" panel — open straight into the
  // create form with the email already filled in. Clear the state afterward so
  // navigating back here later (or refreshing) doesn't keep reopening it.
  useEffect(() => {
    const prefillEmail = location.state?.prefillEmail
    if (!prefillEmail) return
    setEditing(null); setFormErr('')
    setForm({ name: '', email: prefillEmail, password: '', role: 'developer' })
    setIssueCert(false)
    setShowForm(true)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  function openCreate() {
    setEditing(null); setForm({ name: '', email: '', password: '', role: 'developer' }); setFormErr('')
    // Default to whichever cluster is currently active in kubectl, not just the first
    // one in the list — falls back to the first monitored cluster if none is current.
    const current = clusters.find(c => c.isCurrent)
    setIssueCert(false); setCertContext((current ?? clusters[0])?.name ?? '')
    setShowForm(true)
  }
  function openEdit(u)  { setEditing(u);    setForm({ name: u.name, email: u.email, password: '', role: u.role }); setFormErr(''); setShowForm(true) }

  async function saveUser(e) {
    e.preventDefault(); setFormErr('')
    const method = editing ? 'PUT' : 'POST'
    const url    = editing ? `/api/users/${editing._id}` : '/api/users'
    const body   = editing
      ? { name: form.name, role: form.role, ...(form.password ? { password: form.password } : {}), active: form.active }
      : { name: form.name, email: form.email, password: form.password, role: form.role }
    const res = await apiFetch(url, { method, body })
    if (!res.ok) { const d = await res.json(); setFormErr(d.error); return }
    const created = await res.json()
    notify('success', editing ? `Updated ${form.name}` : `Created ${form.name}`)

    if (!editing && issueCert && certContext) {
      try {
        const certRes = await apiFetch(`/api/rbac/users/${created.id}/certificate`, { method: 'POST', body: { context: certContext } })
        if (!certRes.ok) { const d = await certRes.json().catch(() => ({})); notify('error', d.error || 'Failed to issue certificate'); }
        else {
          const blob = await certRes.blob()
          const url2 = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url2; a.download = `kubeconfig-${created.email}.yaml`; a.click()
          URL.revokeObjectURL(url2)
          notify('success', `Certificate issued for ${created.name} — kubeconfig downloaded`)
        }
      } catch (err) { notify('error', err.message) }
    }

    setShowForm(false); load()
  }

  async function toggleActive(u) {
    await apiFetch(`/api/users/${u._id}`, { method: 'PUT', body: { active: !u.active } })
    notify(u.active ? 'warn' : 'success', `${u.name} ${u.active ? 'deactivated' : 'activated'}`)
    load()
  }

  async function deleteUser(u) {
    const res = await apiFetch(`/api/users/${u._id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); notify('error', d.error); return }
    notify('success', `Deleted ${u.name}`); load()
  }

  if (loading) return <div className="page-loading">Loading users…</div>

  return (
    <div className="users-page">
      {viewUser && <UserProfileModal userId={viewUser} onClose={() => setViewUser(null)} />}
      <div className="page-header">
        <div><h2>Account Management</h2><p className="page-subtitle">Manage dashboard users and roles</p></div>
        <button className="btn-primary" onClick={openCreate}>+ Add User</button>
      </div>

      <div className="table-wrap">
        <table className="data-table data-table-responsive">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u._id} className={!u.active ? 'row-inactive' : ''}>
                <td data-label="Name" className="fw-500">{u.name}{u._id === me.id && <span className="you-badge">you</span>}</td>
                <td data-label="Email" className="text-dim">{u.email}</td>
                <td data-label="Role"><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                <td data-label="Status"><span className={`status-pill ${u.active ? 'active' : 'inactive'}`}>{u.active ? 'Active' : 'Inactive'}</span></td>
                <td data-label="Created" className="text-dim">{fmtDT(u.createdAt)}</td>
                <td data-label="Actions">
                  <div className="action-btns">
                    <button className="btn-sm btn-view" onClick={() => setViewUser(u._id)}>View</button>
                    <button className="btn-sm" onClick={() => openEdit(u)}>Edit</button>
                    <button className={`btn-sm ${u.active ? 'btn-warn' : 'btn-success'}`} onClick={() => toggleActive(u)} disabled={u._id === me.id}>
                      {u.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn-sm btn-danger" onClick={() => setConfirmDelete(u)} disabled={u._id === me.id}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowForm(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>{editing ? 'Edit User' : 'New User'}</h3>
              <button className="modal-close" onClick={() => setShowForm(false)}>×</button>
            </div>
            <form onSubmit={saveUser} className="modal-form">
              <div className="field"><label>Name</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></div>
              {!editing && <div className="field"><label>Email</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required /></div>}
              <div className="field">
                <label>{editing ? 'New Password (leave blank to keep)' : 'Password'}</label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} {...(!editing && { required: true })} />
              </div>
              <div className="field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="developer">Developer</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {!editing && (
                <div className="field">
                  <label>
                    <input type="checkbox" checked={issueCert} onChange={e => setIssueCert(e.target.checked)} />
                    {' '}Also generate a downloadable kubeconfig certificate
                  </label>
                  {issueCert && (
                    <select value={certContext} onChange={e => setCertContext(e.target.value)} style={{ marginTop: 6 }}>
                      {clusters.length === 0 && <option value="">No monitored clusters</option>}
                      {clusters.map(c => <option key={c.name} value={c.name}>{c.config?.name ?? c.name}</option>)}
                    </select>
                  )}
                </div>
              )}
              {formErr && <div className="login-error">{formErr}</div>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn-primary">{editing ? 'Save Changes' : 'Create User'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete user?"
          message={`Delete ${confirmDelete.name}? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => { deleteUser(confirmDelete); setConfirmDelete(null) }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

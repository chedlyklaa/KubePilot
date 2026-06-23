import { useState, useEffect } from 'react'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'

const ROLES = ['viewer', 'editor', 'admin']
const EMPTY_SCOPE = { cluster: '', namespace: '*', role: 'viewer' }

function updateScopeAt(arr, i, field, val) {
  const next = [...arr]; next[i] = { ...next[i], [field]: val }; return next
}

function ScopeEditor({ scopes, setScopes, clusters }) {
  const [nsCache, setNsCache] = useState({})

  function fetchNs(cluster) {
    if (!cluster || cluster === '*' || nsCache[cluster]) return
    apiFetch(`/api/rbac/namespaces?context=${encodeURIComponent(cluster)}`)
      .then(r => r.json())
      .then(ns => { if (Array.isArray(ns)) setNsCache(c => ({ ...c, [cluster]: ns })) })
      .catch(() => {})
  }

  useEffect(() => {
    scopes.forEach(s => { if (s.cluster && s.cluster !== '*') fetchNs(s.cluster) })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  function onClusterChange(i, val) {
    const next = [...scopes]
    next[i] = { ...next[i], cluster: val, namespace: '*' }
    setScopes(next)
    if (val && val !== '*') fetchNs(val)
  }

  return (
    <div className="tp-scopes">
      {scopes.map((s, i) => {
        const nsList = nsCache[s.cluster] ?? []
        const listId = `ns-list-${i}`
        return (
          <div key={i} className="tp-scope-row">
            <select value={s.cluster} onChange={e => onClusterChange(i, e.target.value)}>
              <option value="">— cluster —</option>
              <option value="*">* (all)</option>
              {clusters.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input list={listId} placeholder="* = all namespaces" value={s.namespace}
              onChange={e => setScopes(updateScopeAt(scopes, i, 'namespace', e.target.value))} />
            <datalist id={listId}>
              <option value="*">all namespaces</option>
              {nsList.map(ns => <option key={ns} value={ns} />)}
            </datalist>
            <select value={s.role} onChange={e => setScopes(updateScopeAt(scopes, i, 'role', e.target.value))}>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" className="btn-sm btn-danger" onClick={() => setScopes(scopes.filter((_, j) => j !== i))}>×</button>
          </div>
        )
      })}
      <button type="button" className="btn-sm" onClick={() => setScopes([...scopes, { ...EMPTY_SCOPE }])}>+ Add scope</button>
    </div>
  )
}

export default function TeamsPage() {
  const notify = useNotify()
  const [tab, setTab]             = useState('teams')   // 'teams' | 'users'
  const [groups, setGroups]       = useState([])
  const [users, setUsers]         = useState([])
  const [clusters, setClusters]   = useState([])
  const [loading, setLoading]     = useState(true)

  // Group form
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [editGroup, setEditGroup]         = useState(null)
  const [gForm, setGForm]                 = useState({ name: '', description: '', permissions: [], members: [] })
  const [gErr, setGErr]                   = useState('')
  const [memberSearch, setMemberSearch]   = useState('')

  // User permission panel
  const [selUser, setSelUser]     = useState(null)
  const [uPerms, setUPerms]      = useState([])
  const [uGroup, setUGroup]      = useState('')
  const [uErr, setUErr]          = useState('')

  async function loadAll() {
    try {
      const [gr, ur, cr] = await Promise.all([
        apiFetch('/api/groups'), apiFetch('/api/users'), apiFetch('/api/kube/contexts'),
      ])
      setGroups(await gr.json())
      setUsers(await ur.json())
      const ctx = await cr.json()
      setClusters((ctx.contexts ?? []).map(c => c.name))
    } catch {}
    setLoading(false)
  }
  useEffect(() => { loadAll() }, [])

  // ── Group CRUD ──────────────────────────────────────────────────────
  function openCreateGroup() {
    setEditGroup(null)
    setGForm({ name: '', description: '', permissions: [], members: [] })
    setGErr(''); setMemberSearch(''); setShowGroupForm(true)
  }
  function openEditGroup(g) {
    setEditGroup(g)
    const currentMembers = users.filter(u => u.group?.toString() === g._id || u.group === g._id).map(u => u._id)
    setGForm({ name: g.name, description: g.description ?? '', permissions: g.permissions?.length ? [...g.permissions] : [], members: currentMembers })
    setGErr(''); setMemberSearch(''); setShowGroupForm(true)
  }
  async function saveGroup(e) {
    e.preventDefault(); setGErr('')
    const method = editGroup ? 'PUT' : 'POST'
    const url = editGroup ? `/api/groups/${editGroup._id}` : '/api/groups'
    const res = await apiFetch(url, { method, body: gForm })
    if (!res.ok) { const d = await res.json(); setGErr(d.error); return }
    notify('success', editGroup ? `Updated ${gForm.name}` : `Created ${gForm.name}`)
    setShowGroupForm(false); loadAll()
  }
  async function deleteGroup(g) {
    if (!confirm(`Delete team "${g.name}"? Members will be unlinked.`)) return
    await apiFetch(`/api/groups/${g._id}`, { method: 'DELETE' })
    notify('success', `Deleted ${g.name}`); loadAll()
  }

  // ── User permissions ────────────────────────────────────────────────
  async function openUserPerms(u) {
    setSelUser(u); setUErr('')
    try {
      const res = await apiFetch(`/api/users/${u._id}/permissions`)
      const data = await res.json()
      setUPerms(data.own ?? [])
      setUGroup(data.group?._id ?? '')
    } catch { setUPerms([]); setUGroup('') }
  }
  async function saveUserPerms() {
    setUErr('')
    const res = await apiFetch(`/api/users/${selUser._id}/permissions`, {
      method: 'PUT',
      body: { permissions: uPerms, group: uGroup || null },
    })
    if (!res.ok) { const d = await res.json(); setUErr(d.error); return }
    notify('success', `Updated permissions for ${selUser.name}`)
    setSelUser(null); loadAll()
  }

  function membersOf(groupId) { return users.filter(u => u.group?.toString() === groupId || u.group === groupId) }

  if (loading) return <div className="page-loading">Loading…</div>

  return (
    <div className="users-page">
      <div className="page-header">
        <div>
          <h2>Teams & Permissions</h2>
          <p className="page-subtitle">Manage groups, assign cluster/namespace roles to users</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="tp-tabs">
        <button className={`tp-tab ${tab === 'teams' ? 'active' : ''}`} onClick={() => setTab('teams')}>Teams</button>
        <button className={`tp-tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>User Permissions</button>
      </div>

      {/* ── Teams tab ───────────────────────────────────────────────── */}
      {tab === 'teams' && (<>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn-primary" onClick={openCreateGroup}>+ New Team</button>
        </div>
        {groups.length === 0 && <p className="text-dim" style={{ textAlign: 'center', padding: 24 }}>No teams yet. Create one to start assigning scoped permissions.</p>}
        <div className="tp-grid">
          {groups.map(g => (
            <div key={g._id} className="tp-card">
              <div className="tp-card-head">
                <div>
                  <div className="tp-card-name">{g.name}</div>
                  {g.description && <div className="tp-card-desc">{g.description}</div>}
                </div>
                <div className="action-btns">
                  <button className="btn-sm" onClick={() => openEditGroup(g)}>Edit</button>
                  <button className="btn-sm btn-danger" onClick={() => deleteGroup(g)}>Delete</button>
                </div>
              </div>
              <div className="tp-card-section">
                <div className="tp-label">Permissions ({g.permissions?.length ?? 0})</div>
                {g.permissions?.length ? (
                  <div className="tp-scope-list">
                    {g.permissions.map((p, i) => (
                      <span key={i} className="tp-scope-badge">
                        {p.cluster}/{p.namespace} <span className={`role-badge role-${p.role}`}>{p.role}</span>
                      </span>
                    ))}
                  </div>
                ) : <span className="text-dim">No scopes</span>}
              </div>
              <div className="tp-card-section">
                <div className="tp-label">Members ({membersOf(g._id).length})</div>
                <div className="tp-member-list">
                  {membersOf(g._id).map(u => (
                    <span key={u._id} className="tp-member-chip">{u.name}</span>
                  ))}
                  {membersOf(g._id).length === 0 && <span className="text-dim">No members</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </>)}

      {/* ── Users tab ───────────────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Platform Role</th><th>Team</th><th>Scopes</th><th></th></tr></thead>
            <tbody>
              {users.map(u => {
                const g = groups.find(gr => gr._id === u.group)
                const ownCount = u.permissions?.length ?? 0
                const groupCount = g?.permissions?.length ?? 0
                return (
                  <tr key={u._id}>
                    <td className="fw-500">{u.name}</td>
                    <td className="text-dim">{u.email}</td>
                    <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                    <td>{g ? g.name : <span className="text-dim">—</span>}</td>
                    <td className="text-dim">{u.role === 'admin' ? 'full access' : `${ownCount} own + ${groupCount} from team`}</td>
                    <td>
                      {u.role !== 'admin' && (
                        <button className="btn-sm" onClick={() => openUserPerms(u)}>Edit</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Group form modal ────────────────────────────────────────── */}
      {showGroupForm && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowGroupForm(false)}>
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h3>{editGroup ? 'Edit Team' : 'New Team'}</h3>
              <button className="modal-close" onClick={() => setShowGroupForm(false)}>×</button>
            </div>
            <form onSubmit={saveGroup} className="modal-form">
              <div className="field"><label>Name</label><input value={gForm.name} onChange={e => setGForm(f => ({ ...f, name: e.target.value }))} required /></div>
              <div className="field"><label>Description</label><input value={gForm.description} onChange={e => setGForm(f => ({ ...f, description: e.target.value }))} /></div>
              <div className="field">
                <label>Members</label>
                <div className="tp-member-add">
                  <input placeholder="Search users…" value={memberSearch}
                    onChange={e => setMemberSearch(e.target.value)} />
                  {memberSearch && (() => {
                    const q = memberSearch.toLowerCase()
                    const filtered = users.filter(u =>
                      u.role !== 'admin' && !gForm.members.includes(u._id) &&
                      (u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
                    )
                    return filtered.length > 0 && (
                      <div className="tp-member-dropdown">
                        {filtered.map(u => (
                          <div key={u._id} className="tp-member-dropdown-item" onClick={() => {
                            setGForm(f => ({ ...f, members: [...f.members, u._id] }))
                            setMemberSearch('')
                          }}>
                            <span className="fw-500">{u.name}</span>
                            <span className="text-dim">{u.email}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </div>
                {gForm.members.length > 0 && (
                  <div className="tp-chip-list">
                    {gForm.members.map(id => {
                      const u = users.find(x => x._id === id)
                      if (!u) return null
                      return (
                        <span key={id} className="tp-chip">
                          {u.name}
                          <button type="button" className="tp-chip-x"
                            onClick={() => setGForm(f => ({ ...f, members: f.members.filter(m => m !== id) }))}>×</button>
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="field">
                <label>Permission Scopes</label>
                <ScopeEditor scopes={gForm.permissions} setScopes={p => setGForm(f => ({ ...f, permissions: p }))} clusters={clusters} />
              </div>
              {gErr && <div className="login-error">{gErr}</div>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowGroupForm(false)}>Cancel</button>
                <button type="submit" className="btn-primary">{editGroup ? 'Save' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── User permission modal ───────────────────────────────────── */}
      {selUser && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setSelUser(null)}>
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <h3>Permissions — {selUser.name}</h3>
              <button className="modal-close" onClick={() => setSelUser(null)}>×</button>
            </div>
            <div className="modal-form">
              <div className="field">
                <label>Assign to Team</label>
                <select value={uGroup} onChange={e => setUGroup(e.target.value)}>
                  <option value="">— none —</option>
                  {groups.map(g => <option key={g._id} value={g._id}>{g.name} ({g.permissions?.length ?? 0} scopes)</option>)}
                </select>
              </div>
              <div className="field">
                <label>Individual Permissions</label>
                <ScopeEditor scopes={uPerms} setScopes={setUPerms} clusters={clusters} />
              </div>
              {uErr && <div className="login-error">{uErr}</div>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setSelUser(null)}>Cancel</button>
                <button type="button" className="btn-primary" onClick={saveUserPerms}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

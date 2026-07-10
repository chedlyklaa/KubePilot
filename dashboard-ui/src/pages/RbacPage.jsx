import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import ScopeEditor from '../components/ScopeEditor'

const KIND_LABEL = { User: 'User', Group: 'Group', ServiceAccount: 'SA' }
const KIND_COLOR = { User: 'role-admin', Group: 'role-user', ServiceAccount: 'role-viewer' }

const ADMIN_TABS  = ['Bindings', 'Roles', 'Service Accounts', 'Audit', 'Teams', 'User Permissions']
const VIEWER_TABS = ['Bindings', 'Roles', 'Service Accounts', 'Audit']

const ROLE_YAML_TEMPLATE = (name, ns) =>
`apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${name}
  namespace: ${ns}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]`

export default function RbacPage() {
  const { user } = useAuth()
  const isAdmin  = user.role === 'admin'

  const [clusters,   setClusters]   = useState([])
  const [context,    setContext]    = useState('')
  const [namespaces, setNamespaces] = useState([])
  const [nsFilter,   setNsFilter]  = useState('_all')  // '_all' = show everything
  const [tab,        setTab]        = useState(0)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')

  const [overview,   setOverview]   = useState(null)
  const [audit,      setAudit]      = useState(null)

  // Sync system users from K8s RoleBindings/ClusterRoleBindings
  const [syncBusy,   setSyncBusy]   = useState(false)

  // Apply YAML modal
  const [showApply,  setShowApply]  = useState(false)
  const [yamlDraft,  setYamlDraft]  = useState('')
  const [applyBusy,  setApplyBusy]  = useState(false)
  const [applyOut,   setApplyOut]   = useState('')
  const [applyErr,   setApplyErr]   = useState('')

  // Delete confirm
  const [delTarget,  setDelTarget]  = useState(null)
  const [delBusy,    setDelBusy]    = useState(false)

  // Audit filter
  const [auditSearch, setAuditSearch] = useState('')
  const [showDangerOnly, setShowDangerOnly] = useState(false)

  // Platform teams + user permissions management
  const notify = useNotify()
  const [pGroups, setPGroups] = useState([])
  const [pUsers, setPUsers]   = useState([])
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [editGroup, setEditGroup]         = useState(null)
  const [gForm, setGForm]                 = useState({ name: '', description: '', permissions: [], members: [] })
  const [gErr, setGErr]                   = useState('')
  const [memberSearch, setMemberSearch]   = useState('')
  const [memberOpen, setMemberOpen]       = useState(false)
  const [selUser, setSelUser]             = useState(null)
  const [uPerms, setUPerms]              = useState([])
  const [uGroup, setUGroup]              = useState('')
  const [uCanProvision, setUCanProvision] = useState(false)
  const [uErr, setUErr]                  = useState('')

  const clusterNames = useMemo(() => clusters.map(c => c.name), [clusters])

  function loadTeams() {
    if (!isAdmin) return
    Promise.all([apiFetch('/api/groups'), apiFetch('/api/users')])
      .then(async ([gr, ur]) => { setPGroups(await gr.json()); setPUsers(await ur.json()) })
      .catch(() => {})
  }
  useEffect(() => { loadTeams() }, [isAdmin])

  // Load clusters from the kube/contexts endpoint
  useEffect(() => {
    apiFetch('/api/kube/contexts')
      .then(r => r.json())
      .then(d => {
        const list = d.contexts ?? []
        setClusters(list)
        if (list.length > 0) setContext(list[0].name)
      })
      .catch(() => {})
  }, [])

  // Load namespace list for the filter dropdown
  useEffect(() => {
    if (!context) return
    setNsFilter('_all')
    apiFetch(`/api/rbac/namespaces?context=${encodeURIComponent(context)}`)
      .then(r => r.json())
      .then(ns => { if (Array.isArray(ns)) setNamespaces(ns) })
      .catch(() => {})
  }, [context])

  const load = useCallback(async () => {
    if (!context) return
    setLoading(true)
    setError('')
    try {
      const [ovRes, auRes] = await Promise.all([
        apiFetch(`/api/rbac/overview?context=${encodeURIComponent(context)}&namespace=_all`),
        apiFetch(`/api/rbac/audit?context=${encodeURIComponent(context)}&namespace=_all`),
      ])
      const [ov, au] = await Promise.all([ovRes.json(), auRes.json()])
      if (ov.error) throw new Error(ov.error)
      setOverview(ov)
      setAudit(Array.isArray(au) ? au : [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [context])

  useEffect(() => {
    if (context) load()
  }, [load])

  // ── Apply YAML ────────────────────────────────────────────────────────────

  async function submitApply() {
    setApplyBusy(true); setApplyErr(''); setApplyOut('')
    try {
      const r = await apiFetch('/api/rbac/apply', {
        method: 'POST',
        body: { yaml: yamlDraft, context },
      })
      const d = await r.json()
      if (d.error) setApplyErr(d.detail ? `${d.error}\n\n${d.detail}` : d.error)
      else {
        const prefix = d.appliedCount > 1 ? `Applied ${d.appliedCount} documents:\n\n` : ''
        setApplyOut(prefix + d.output)
        load()
      }
    } catch (err) { setApplyErr(err.message) }
    finally { setApplyBusy(false) }
  }

  // ── Sync system user permissions from K8s bindings ────────────────────────

  async function syncFromK8s() {
    if (!context) return
    setSyncBusy(true)
    try {
      const r = await apiFetch('/api/rbac/sync-from-k8s', { method: 'POST', body: { context } })
      const d = await r.json()
      if (d.error) { notify('error', d.error); return }
      const parts = []
      if (d.updated.length)   parts.push(`${d.updated.length} user(s) updated`)
      if (d.cleared.length)   parts.push(`${d.cleared.length} user(s) had revoked access removed`)
      if (d.unmatched.length) parts.push(`${d.unmatched.length} K8s subject(s) had no matching system account`)
      notify('success', parts.length ? `Synced from ${d.cluster}: ${parts.join(', ')}` : `Synced from ${d.cluster}: no changes`)
      if (tab === 5) loadTeams() // refresh User Permissions tab if currently viewing it
    } catch (err) { notify('error', err.message) }
    finally { setSyncBusy(false) }
  }

  // ── Delete resource ───────────────────────────────────────────────────────

  async function confirmDelete() {
    if (!delTarget) return
    setDelBusy(true)
    try {
      const r = await apiFetch('/api/rbac/resource', {
        method: 'DELETE',
        body: { ...delTarget, context },
      })
      const d = await r.json()
      if (d.error) alert(d.error)
      else { setDelTarget(null); load() }
    } catch (err) { alert(err.message) }
    finally { setDelBusy(false) }
  }

  // ── Audit filtered list ───────────────────────────────────────────────────

  const filteredAudit = useMemo(() => {
    if (!audit) return []
    let r = audit
    if (nsFilter !== '_all') r = r.filter(e => e.namespace === nsFilter || e.scope === 'cluster')
    if (showDangerOnly) r = r.filter(e => e.dangerous)
    if (auditSearch.trim()) {
      const q = auditSearch.toLowerCase()
      r = r.filter(e =>
        e.subject?.toLowerCase().includes(q) ||
        e.role?.toLowerCase().includes(q) ||
        e.namespace?.toLowerCase().includes(q)
      )
    }
    return r
  }, [audit, nsFilter, showDangerOnly, auditSearch])

  const dangerCount = useMemo(() => (audit ?? []).filter(e => e.dangerous).length, [audit])

  // ── Role rules summary ────────────────────────────────────────────────────

  function rulesSummary(rules) {
    if (!rules?.length) return '—'
    const verbs = new Set()
    const res   = new Set()
    for (const r of rules) {
      ;(r.verbs     ?? []).forEach(v => verbs.add(v))
      ;(r.resources ?? []).forEach(x => res.add(x))
    }
    return `${[...verbs].join(', ')} → ${[...res].join(', ')}`
  }

  // ── Renderers ─────────────────────────────────────────────────────────────

  function renderBindings() {
    const rbs  = overview?.roleBindings        ?? []
    const crbs = overview?.clusterRoleBindings ?? []
    const all  = [
      ...rbs.map(rb => ({
        name:      rb.metadata.name,
        namespace: rb.metadata.namespace,
        role:      rb.roleRef.name,
        roleKind:  rb.roleRef.kind,
        subjects:  rb.subjects ?? [],
        scope:     'namespace',
        kind:      'rolebinding',
        dangerous: rb.dangerous ?? false,
        managed:   rb.metadata.labels?.['app.kubernetes.io/managed-by'] === 'kubepilot',
      })),
      ...crbs.map(crb => ({
        name:      crb.metadata.name,
        namespace: '(cluster-wide)',
        role:      crb.roleRef.name,
        roleKind:  crb.roleRef.kind,
        subjects:  crb.subjects ?? [],
        scope:     'cluster',
        kind:      'clusterrolebinding',
        dangerous: crb.dangerous ?? false,
        managed:   crb.metadata.labels?.['app.kubernetes.io/managed-by'] === 'kubepilot',
      })),
    ]
    const filtered = nsFilter === '_all' ? all : all.filter(b => b.namespace === nsFilter || b.scope === 'cluster')
    if (filtered.length === 0) return <div className="empty-state">No bindings found{nsFilter !== '_all' ? ` in ${nsFilter}` : ''}</div>
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Scope</th><th>Namespace</th>
              <th>Role / ClusterRole</th><th>Subjects</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map(b => (
              <tr key={`${b.kind}/${b.name}`} className={b.dangerous ? 'rbac-row-danger' : ''}>
                <td className="mono-small">{b.name}{b.managed && <span className="rbac-kp-badge">⎈ KubePilot</span>}{b.dangerous && <span className="rbac-danger-badge">⚠ privileged</span>}</td>
                <td><span className={`rbac-scope-badge rbac-scope-${b.scope}`}>{b.scope}</span></td>
                <td className="text-dim">{b.namespace}</td>
                <td>
                  <span className="rbac-role-name">{b.role}</span>
                  <span className="text-dim" style={{ marginLeft: 5, fontSize: 10 }}>{b.roleKind}</span>
                </td>
                <td>
                  <div className="rbac-subjects">
                    {b.subjects.slice(0, 3).map((s, i) => (
                      <span key={i} className={`role-badge ${KIND_COLOR[s.kind] ?? ''}`}>
                        {KIND_LABEL[s.kind] ?? s.kind}: {s.name}
                      </span>
                    ))}
                    {b.subjects.length > 3 && <span className="text-dim">+{b.subjects.length - 3}</span>}
                  </div>
                </td>
                {isAdmin && (
                  <td>
                    <button className="btn-danger-xs" onClick={() => setDelTarget({ kind: b.kind, name: b.name, namespace: b.scope === 'namespace' ? b.namespace : null })}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  function renderRoles() {
    const allRoles = [
      ...(overview?.roles ?? []).map(r => ({ ...r, _type: 'Role' })),
      ...(overview?.clusterRoles ?? []).map(r => ({ ...r, _type: 'ClusterRole' })),
    ]
    const roles = nsFilter === '_all' ? allRoles : allRoles.filter(r => r.metadata.namespace === nsFilter || r._type === 'ClusterRole')
    if (roles.length === 0) return <div className="empty-state">No roles found{nsFilter !== '_all' ? ` in ${nsFilter}` : ''}</div>
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Kind</th><th>Namespace</th><th>Rules Summary</th><th># Rules</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {roles.map(r => (
              <tr key={`${r._type}/${r.metadata.name}`}>
                <td className="mono-small">{r.metadata.name}</td>
                <td><span className={`rbac-scope-badge rbac-scope-${r._type === 'ClusterRole' ? 'cluster' : 'namespace'}`}>{r._type}</span></td>
                <td className="text-dim">{r.metadata.namespace ?? '(cluster-wide)'}</td>
                <td className="rbac-rules-summary">{rulesSummary(r.rules)}</td>
                <td style={{ textAlign: 'center' }}>{r.rules?.length ?? 0}</td>
                {isAdmin && (
                  <td>
                    <button className="btn-danger-xs" onClick={() => setDelTarget({ kind: r._type.toLowerCase(), name: r.metadata.name, namespace: r.metadata.namespace ?? null })}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  function renderServiceAccounts() {
    const allSas = overview?.serviceAccounts ?? []
    const sas = nsFilter === '_all' ? allSas : allSas.filter(sa => sa.metadata.namespace === nsFilter)
    if (sas.length === 0) return <div className="empty-state">No service accounts found{nsFilter !== '_all' ? ` in ${nsFilter}` : ''}</div>
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Namespace</th><th>Secrets</th><th>Age</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sas.map(sa => (
              <tr key={sa.metadata.name}>
                <td className="mono-small">{sa.metadata.name}</td>
                <td className="text-dim">{sa.metadata.namespace}</td>
                <td style={{ textAlign: 'center' }}>{sa.secrets?.length ?? 0}</td>
                <td className="text-dim">{fmtAge(sa.metadata.creationTimestamp)}</td>
                {isAdmin && (
                  <td>
                    <button className="btn-danger-xs" onClick={() => setDelTarget({ kind: 'serviceaccount', name: sa.metadata.name, namespace: sa.metadata.namespace })}>
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  function renderAudit() {
    return (
      <>
        <div className="rbac-audit-toolbar">
          <input
            className="rbac-search-input"
            placeholder="Search subject, role, namespace..."
            value={auditSearch}
            onChange={e => setAuditSearch(e.target.value)}
          />
          <label className="rbac-danger-toggle">
            <input type="checkbox" checked={showDangerOnly} onChange={e => setShowDangerOnly(e.target.checked)} />
            <span>Show dangerous only</span>
            {dangerCount > 0 && <span className="rbac-danger-count">{dangerCount}</span>}
          </label>
        </div>
        {filteredAudit.length === 0
          ? <div className="empty-state">No entries match</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Subject</th><th>Kind</th><th>Namespace</th>
                    <th>Role / ClusterRole</th><th>Scope</th><th>Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAudit.map((e, i) => (
                    <tr key={i} className={e.dangerous ? 'rbac-row-danger' : ''}>
                      <td className="mono-small">{e.subject}</td>
                      <td><span className={`role-badge ${KIND_COLOR[e.kind] ?? ''}`}>{KIND_LABEL[e.kind] ?? e.kind}</span></td>
                      <td className="text-dim">{e.namespace}</td>
                      <td className="rbac-role-name">{e.role}</td>
                      <td><span className={`rbac-scope-badge rbac-scope-${e.scope}`}>{e.scope}</span></td>
                      <td>
                        {e.dangerous
                          ? <span className="card-risk HIGH">HIGH</span>
                          : <span className="card-risk LOW">LOW</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </>
    )
  }

  // ── Team CRUD helpers ─────────────────────────────────────────────────────
  function openCreateGroup() {
    setEditGroup(null); setGForm({ name: '', description: '', permissions: [], members: [] })
    setGErr(''); setMemberSearch(''); setShowGroupForm(true)
  }
  function openEditGroup(g) {
    setEditGroup(g)
    const curMembers = pUsers.filter(u => u.group?.toString() === g._id || u.group === g._id).map(u => u._id)
    setGForm({ name: g.name, description: g.description ?? '', permissions: g.permissions?.length ? [...g.permissions] : [], members: curMembers })
    setGErr(''); setMemberSearch(''); setShowGroupForm(true)
  }
  async function saveGroup(e) {
    e.preventDefault(); setGErr('')
    const method = editGroup ? 'PUT' : 'POST'
    const url = editGroup ? `/api/groups/${editGroup._id}` : '/api/groups'
    const res = await apiFetch(url, { method, body: gForm })
    if (!res.ok) { const d = await res.json(); setGErr(d.error); return }
    notify('success', editGroup ? `Updated ${gForm.name}` : `Created ${gForm.name}`)
    setShowGroupForm(false); loadTeams()
  }
  async function deleteGroup(g) {
    if (!confirm(`Delete team "${g.name}"? Members will be unlinked.`)) return
    await apiFetch(`/api/groups/${g._id}`, { method: 'DELETE' })
    notify('success', `Deleted ${g.name}`); loadTeams()
  }
  function membersOf(gid) { return pUsers.filter(u => u.group?.toString() === gid || u.group === gid) }

  async function openUserPerms(u) {
    setSelUser(u); setUErr(''); setUCanProvision(u.canProvision ?? false)
    try {
      const res = await apiFetch(`/api/users/${u._id}/permissions`)
      const data = await res.json()
      setUPerms(data.own ?? []); setUGroup(data.group?._id ?? '')
    } catch { setUPerms([]); setUGroup('') }
  }
  async function saveUserPerms() {
    setUErr('')
    const [permRes, userRes] = await Promise.all([
      apiFetch(`/api/users/${selUser._id}/permissions`, {
        method: 'PUT', body: { permissions: uPerms, group: uGroup || null },
      }),
      apiFetch(`/api/users/${selUser._id}`, {
        method: 'PUT', body: { canProvision: uCanProvision },
      }),
    ])
    if (!permRes.ok) { const d = await permRes.json(); setUErr(d.error); return }
    if (!userRes.ok) { const d = await userRes.json(); setUErr(d.error); return }
    notify('success', `Updated permissions for ${selUser.name}`)
    setSelUser(null); loadTeams()
  }

  // ── Client certificate (direct kubectl access) for the currently selected cluster ─
  async function issueCertificate(u) {
    if (!context) { notify('error', 'Select a cluster first'); return }
    try {
      const r = await apiFetch(`/api/rbac/users/${u._id}/certificate`, { method: 'POST', body: { context } })
      if (!r.ok) { const d = await r.json().catch(() => ({})); notify('error', d.error || 'Failed to issue certificate'); return }
      const blob = await r.blob()
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `kubeconfig-${u.email}.yaml`; a.click()
      URL.revokeObjectURL(url)
      notify('success', `Certificate issued for ${u.name} — kubeconfig downloaded`)
    } catch (err) { notify('error', err.message) }
  }

  function renderTeams() {
    return (<>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn-primary" onClick={openCreateGroup}>+ New Team</button>
      </div>
      {pGroups.length === 0 && <p className="text-dim" style={{ textAlign: 'center', padding: 24 }}>No teams yet. Create one to start assigning scoped permissions.</p>}
      <div className="tp-grid">
        {pGroups.map(g => (
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
                {membersOf(g._id).map(u => <span key={u._id} className="tp-member-chip">{u.name}</span>)}
                {membersOf(g._id).length === 0 && <span className="text-dim">No members</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>)
  }

  function renderUserPerms() {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Email</th><th>Platform Role</th><th>Team</th><th>Scopes</th><th></th></tr></thead>
          <tbody>
            {pUsers.map(u => {
              const g = pGroups.find(gr => gr._id === u.group)
              const ownCount = u.permissions?.length ?? 0
              const groupCount = g?.permissions?.length ?? 0
              return (
                <tr key={u._id}>
                  <td className="fw-500">{u.name}</td>
                  <td className="text-dim">{u.email}</td>
                  <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                  <td>{g ? g.name : <span className="text-dim">—</span>}</td>
                  <td className="text-dim">{u.role === 'admin' ? 'full access' : `${ownCount} own + ${groupCount} from team`}</td>
                  <td className="action-btns">
                    {u.role !== 'admin' && <button className="btn-sm" onClick={() => openUserPerms(u)}>Edit</button>}
                    <button className="btn-sm" disabled={!context}
                      title="Issue a client certificate + kubeconfig for this user on the currently selected cluster, based on their current permissions"
                      onClick={() => issueCertificate(u)}>
                      Certificate
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  const tabContent = [renderBindings, renderRoles, renderServiceAccounts, renderAudit, renderTeams, renderUserPerms]

  return (
    <div className="rbac-page">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h2>RBAC</h2>
          <p className="page-subtitle">Roles, bindings, and service accounts across monitored clusters</p>
        </div>
        <div className="rbac-header-actions">
          {isAdmin && (
            <button className="btn-primary-sm" onClick={() => { setYamlDraft(ROLE_YAML_TEMPLATE('my-role', nsFilter === '_all' ? 'default' : nsFilter)); setApplyOut(''); setApplyErr(''); setShowApply(true) }}>
              + Apply YAML
            </button>
          )}
          {isAdmin && (
            <button className="btn-sm" onClick={syncFromK8s} disabled={syncBusy || !context}
              title="Read RoleBindings/ClusterRoleBindings from this cluster and update system user permissions to match">
              {syncBusy ? 'Syncing…' : '⟳ Sync Users from K8s'}
            </button>
          )}
          <button className="btn-refresh" onClick={load} disabled={loading} title="Refresh">
            {loading ? '…' : '↺'}
          </button>
        </div>
      </div>

      {/* ── Cluster + namespace selectors ──────────────────────────────── */}
      <div className="rbac-selectors">
        <div className="rbac-selector-group">
          <label className="rbac-selector-label">Cluster</label>
          <select className="rbac-select" value={context} onChange={e => setContext(e.target.value)}>
            {clusters.length === 0 && <option value="">No clusters configured</option>}
            {clusters.map(c => (
              <option key={c.name} value={c.name}>{c.config?.name ?? c.name}</option>
            ))}
          </select>
        </div>
        <div className="rbac-selector-group">
          <label className="rbac-selector-label">Namespace</label>
          <select className="rbac-select" value={nsFilter} onChange={e => setNsFilter(e.target.value)}>
            <option value="_all">All namespaces</option>
            {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
          </select>
        </div>
        {overview && (
          <div className="rbac-stats">
            <span className="rbac-stat-pill">{(overview.roles?.length ?? 0) + (overview.clusterRoles?.length ?? 0)} roles</span>
            <span className="rbac-stat-pill">{(overview.roleBindings?.length ?? 0) + (overview.clusterRoleBindings?.length ?? 0)} bindings</span>
            <span className="rbac-stat-pill">{overview.serviceAccounts?.length ?? 0} service accounts</span>
            {dangerCount > 0 && <span className="rbac-stat-pill rbac-stat-danger">{dangerCount} privileged</span>}
          </div>
        )}
      </div>

      {error && <div className="health-error">{error}</div>}

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <div className="tab-bar-flat">
        {(isAdmin ? ADMIN_TABS : VIEWER_TABS).map((t, i) => (
          <button key={t} className={`tab-flat${tab === i ? ' active' : ''}`} onClick={() => setTab(i)}>
            {t}
          </button>
        ))}
      </div>

      {/* ── Content ────────────────────────────────────────────────────── */}
      {loading
        ? <div className="page-loading">Loading RBAC data…</div>
        : (overview || audit)
          ? tabContent[tab]()
          : !error && <div className="empty-state">Select a cluster to view RBAC data</div>
      }

      {/* ── Apply YAML modal ────────────────────────────────────────────── */}
      {showApply && (
        <div className="modal-backdrop" onClick={() => setShowApply(false)}>
          <div className="modal-box rbac-apply-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>Apply RBAC Manifest</span>
              <button className="modal-close" onClick={() => setShowApply(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="rbac-apply-hint">Paste one or more RBAC manifests separated by <code>---</code>. Supported kinds: Role, ClusterRole, RoleBinding, ClusterRoleBinding, ServiceAccount. Cluster: <strong>{context}</strong></p>
              <textarea
                className="rbac-yaml-editor"
                value={yamlDraft}
                onChange={e => setYamlDraft(e.target.value)}
                rows={16}
                spellCheck={false}
              />
              {applyErr && <div className="rbac-apply-error">{applyErr}</div>}
              {applyOut && <div className="rbac-apply-output">{applyOut}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowApply(false)}>Cancel</button>
              <button className="btn-primary-sm" onClick={submitApply} disabled={applyBusy || !yamlDraft.trim()}>
                {applyBusy ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm modal ───────────────────────────────────────── */}
      {delTarget && (
        <div className="modal-backdrop" onClick={() => setDelTarget(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>Confirm Delete</span>
              <button className="modal-close" onClick={() => setDelTarget(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
                Delete <strong className="mono-small">{delTarget.kind}/{delTarget.name}</strong>
                {delTarget.namespace && <> in namespace <strong>{delTarget.namespace}</strong></>}?
                This action cannot be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setDelTarget(null)}>Cancel</button>
              <button className="btn-danger-sm" onClick={confirmDelete} disabled={delBusy}>
                {delBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Group form modal ────────────────────────────────────────── */}
      {showGroupForm && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowGroupForm(false)}>
          <div className="tm-modal">
            <div className="tm-header">
              <div className="tm-header-left">
                <span className="tm-header-icon">{editGroup ? '✏' : '+'}</span>
                <div>
                  <div className="tm-header-title">{editGroup ? 'Edit Team' : 'New Team'}</div>
                  <div className="tm-header-sub">{editGroup ? `Editing "${editGroup.name}"` : 'Create a team and assign cluster permissions'}</div>
                </div>
              </div>
              <button className="modal-close" onClick={() => setShowGroupForm(false)}>×</button>
            </div>
            <form onSubmit={saveGroup} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div className="tm-body">
                <div className="tm-section">
                  <div className="tm-section-label">General</div>
                  <div className="tm-fields">
                    <div className="field"><label>Team Name</label><input value={gForm.name} onChange={e => setGForm(f => ({ ...f, name: e.target.value }))} required placeholder="e.g. Backend Team" /></div>
                    <div className="field"><label>Description</label><input value={gForm.description} onChange={e => setGForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional — what this team is responsible for" /></div>
                  </div>
                </div>

                <div className="tm-section">
                  <div className="tm-section-label">Members <span className="tm-count">{gForm.members.length}</span></div>
                  <div className="tm-combo">
                    <div className="tm-combo-box" onClick={() => document.getElementById('tm-member-input')?.focus()}>
                      {gForm.members.map(id => {
                        const u = pUsers.find(x => x._id === id)
                        if (!u) return null
                        return (
                          <span key={id} className="tm-combo-chip">
                            <span className="tm-combo-chip-avatar">{u.name.charAt(0).toUpperCase()}</span>
                            {u.name}
                            <button type="button" className="tm-combo-chip-x" onMouseDown={e => e.preventDefault()}
                              onClick={() => setGForm(f => ({ ...f, members: f.members.filter(m => m !== id) }))}>×</button>
                          </span>
                        )
                      })}
                      <input id="tm-member-input" placeholder={gForm.members.length === 0 ? 'Search by name or email…' : 'Add more…'}
                        value={memberSearch} onChange={e => setMemberSearch(e.target.value)}
                        onFocus={() => setMemberOpen(true)}
                        onBlur={() => setTimeout(() => setMemberOpen(false), 150)}
                        autoComplete="off" />
                    </div>
                    {memberOpen && (() => {
                      const q = (memberSearch || '').toLowerCase()
                      const available = pUsers.filter(u =>
                        u.role !== 'admin' && !gForm.members.includes(u._id) &&
                        (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
                      )
                      return available.length > 0 && (
                        <div className="tm-combo-dropdown">
                          {available.map(u => (
                            <div key={u._id} className="tm-combo-option" onMouseDown={e => e.preventDefault()} onClick={() => {
                              setGForm(f => ({ ...f, members: [...f.members, u._id] }))
                              setMemberSearch('')
                            }}>
                              <span className="tm-combo-option-avatar">{u.name.charAt(0).toUpperCase()}</span>
                              <div className="tm-combo-option-info">
                                <span className="tm-combo-option-name">{u.name}</span>
                                <span className="tm-combo-option-email">{u.email}</span>
                              </div>
                              <span className={`role-badge role-${u.role}`}>{u.role}</span>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                  {gForm.members.length === 0 && <div className="tm-empty-hint">No members added yet</div>}
                </div>

                <div className="tm-section">
                  <div className="tm-section-label">Permission Scopes <span className="tm-count">{gForm.permissions.length}</span></div>
                  <div className="tm-section-hint">Define which clusters and namespaces this team can access</div>
                  <ScopeEditor scopes={gForm.permissions} setScopes={p => setGForm(f => ({ ...f, permissions: p }))} clusters={clusterNames} />
                </div>

                {gErr && <div className="login-error" style={{ marginBottom: 8 }}>{gErr}</div>}
              </div>
              <div className="tm-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowGroupForm(false)}>Cancel</button>
                <button type="submit" className="btn-primary">{editGroup ? 'Save Changes' : 'Create Team'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── User permission modal ───────────────────────────────────── */}
      {selUser && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setSelUser(null)}>
          <div className="tm-modal">
            <div className="tm-header">
              <div className="tm-header-left">
                <span className="tm-header-icon">🔑</span>
                <div>
                  <div className="tm-header-title">{selUser.name}</div>
                  <div className="tm-header-sub">{selUser.email}</div>
                </div>
              </div>
              <button className="modal-close" onClick={() => setSelUser(null)}>×</button>
            </div>
            <div className="tm-body">
              <div className="tm-section">
                <div className="tm-section-label">Team Assignment</div>
                <select value={uGroup} onChange={e => setUGroup(e.target.value)}>
                  <option value="">— No team —</option>
                  {pGroups.map(g => <option key={g._id} value={g._id}>{g.name} ({g.permissions?.length ?? 0} scopes)</option>)}
                </select>
              </div>

              <div className="tm-section">
                <div className="tm-section-label">Individual Permissions <span className="tm-count">{uPerms.length}</span></div>
                <div className="tm-section-hint">Override or extend team scopes for this user</div>
                <ScopeEditor scopes={uPerms} setScopes={setUPerms} clusters={clusterNames} />
              </div>

              <div className="tm-section">
                <div className="tm-section-label">Cluster Provisioning</div>
                <div className={`rbac-provision-card${uCanProvision ? ' rbac-provision-active' : ''}`}
                  onClick={() => setUCanProvision(v => !v)}>
                  <div className="rbac-provision-icon">{uCanProvision ? '⎈' : '○'}</div>
                  <div className="rbac-provision-text">
                    <div className="rbac-provision-title">Can create clusters</div>
                    <div className="rbac-provision-desc">Provision new Minikube clusters via the command chat</div>
                  </div>
                  <div className={`rbac-provision-switch${uCanProvision ? ' on' : ''}`}>
                    <div className="rbac-provision-knob" />
                  </div>
                </div>
              </div>

              {uErr && <div className="login-error" style={{ marginBottom: 8 }}>{uErr}</div>}
            </div>
            <div className="tm-footer">
              <button type="button" className="btn-secondary" onClick={() => setSelUser(null)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={saveUserPerms}>Save Permissions</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtAge(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  const days  = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days  > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  return '<1h'
}

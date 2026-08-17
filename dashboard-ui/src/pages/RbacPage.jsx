import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import ScopeEditor from '../components/ScopeEditor'
import ConfirmDialog from '../components/ConfirmDialog'
import SecurityFindingsTable from '../components/SecurityFindingsTable'
import { useSecurityFindings } from '../hooks/useSecurityFindings'

const KIND_LABEL = { User: 'User', Group: 'Group', ServiceAccount: 'SA' }
const KIND_COLOR = { User: 'role-admin', Group: 'role-user', ServiceAccount: 'role-viewer' }

const ADMIN_TABS  = ['Bindings', 'Roles', 'Service Accounts', 'Audit', 'Findings', 'Teams', 'User Permissions']
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
  const navigate = useNavigate()

  const [clusters,   setClusters]   = useState([])
  const [context,    setContext]    = useState('')
  const [namespaces, setNamespaces] = useState([])
  const [nsFilter,   setNsFilter]  = useState('_all')  // '_all' = show everything
  const [tab,        setTab]        = useState(0)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')

  const [overview,   setOverview]   = useState(null)
  const [audit,      setAudit]      = useState(null)

  // Fleet-wide RBAC sync summary (the actual sync button + result panels now live on
  // the dedicated /rbac/sync page — this is just enough to show a live count here).
  const [syncPendingCount, setSyncPendingCount] = useState(0)
  const [syncReviewCount,  setSyncReviewCount]  = useState(0)

  // Apply YAML modal
  const [showApply,  setShowApply]  = useState(false)
  const [yamlDraft,  setYamlDraft]  = useState('')
  const [applyBusy,  setApplyBusy]  = useState(false)
  const [applyOut,   setApplyOut]   = useState('')
  const [applyErr,   setApplyErr]   = useState('')

  // Delete confirm
  const [delTarget,  setDelTarget]  = useState(null)
  const [delBusy,    setDelBusy]    = useState(false)

  // Team delete confirm
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(null)

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

  // ScopeEditor's cluster field feeds User.permissions[].cluster, which rbacSync,
  // filterClusters, and certIssuer all key by the clusters.yaml friendly name — not
  // the raw kubectl context (c.name here). Using c.name silently broke K8s sync
  // whenever a cluster's context differs from its friendly name (e.g. name "ubuntu",
  // context "kp-ubuntu"): permissions saved fine, but no RoleBinding was ever created.
  const clusterNames = useMemo(() => clusters.map(c => c.config?.name ?? c.name), [clusters])

  function loadTeams() {
    if (!isAdmin) return
    Promise.all([apiFetch('/api/groups'), apiFetch('/api/users')])
      .then(async ([gr, ur]) => { setPGroups(await gr.json()); setPUsers(await ur.json()) })
      .catch(() => {})
  }
  useEffect(() => { loadTeams() }, [isAdmin])

  // Load clusters from the kube/contexts endpoint — only ones KubePilot actually
  // monitors (an unmanaged context has no RBAC data reachable through these routes
  // anyway), defaulting to whichever context is currently active in kubectl rather
  // than just the first one in the list.
  useEffect(() => {
    apiFetch('/api/kube/contexts')
      .then(r => r.json())
      .then(d => {
        const list = (d.contexts ?? []).filter(c => c.isMonitored)
        setClusters(list)
        const current = list.find(c => c.isCurrent)
        setContext((current ?? list[0])?.name ?? '')
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

  // Fleet-wide counts (across every monitored cluster, not just the one selected
  // above) — same endpoints the /rbac/sync page uses, just summed here for the banner.
  const loadSyncSummary = useCallback(async () => {
    if (!isAdmin) return
    try {
      const [pr, ar] = await Promise.all([
        apiFetch('/api/rbac/pending-changes'),
        apiFetch('/api/rbac/multi-subject-advisories'),
      ])
      const [pd, ad] = await Promise.all([pr.json(), ar.json()])
      setSyncPendingCount((pd.clusters ?? []).reduce((s, c) => s + (c.pending?.length ?? 0), 0))
      setSyncReviewCount((ad.advisories ?? []).length)
    } catch { /* leave the last known counts rather than clearing them on a transient error */ }
  }, [isAdmin])

  useEffect(() => { loadSyncSummary() }, [loadSyncSummary])
  useEffect(() => {
    if (!isAdmin) return
    const iv = setInterval(loadSyncSummary, 20_000)
    return () => clearInterval(iv)
  }, [isAdmin, loadSyncSummary])

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

  // ── Security findings (RBAC posture) ──────────────────────────────────────
  // security.routes.js keys findings by the cluster's friendly name (from
  // clusters.yaml), not the raw kubectl context this page otherwise uses — so
  // derive it from the already-fetched, already-monitored-only `clusters` list.
  const clusterFriendlyName = useMemo(
    () => clusters.find(c => c.name === context)?.config?.name ?? context,
    [clusters, context]
  )
  const rbacFindings = useSecurityFindings(clusterFriendlyName, 'RbacPosture')

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
      if (d.error) notify('error', d.error)
      else { setDelTarget(null); load() }
    } catch (err) { notify('error', err.message) }
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
        <table className="data-table data-table-responsive rbac-bindings-table">
          <colgroup>
            <col style={{ width: '24%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: isAdmin ? '26%' : '36%' }} />
            {isAdmin && <col style={{ width: '10%' }} />}
          </colgroup>
          <thead>
            <tr>
              <th>Name</th><th>Scope</th><th>Namespace</th>
              <th>Role / ClusterRole</th><th>Subjects</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map(b => (
              <tr key={`${b.kind}/${b.namespace}/${b.name}`} className={b.dangerous ? 'rbac-row-danger' : ''}>
                <td data-label="Name" className="mono-small">{b.name}{b.managed && <span className="rbac-kp-badge">⎈ KubePilot</span>}{b.dangerous && <span className="rbac-danger-badge">⚠ privileged</span>}</td>
                <td data-label="Scope"><span className={`rbac-scope-badge rbac-scope-${b.scope}`}>{b.scope}</span></td>
                <td data-label="Namespace" className="text-dim">{b.namespace}</td>
                <td data-label="Role / ClusterRole">
                  <span className="rbac-role-name">{b.role}</span>
                  <span className="text-dim" style={{ marginLeft: 5, fontSize: 10 }}>{b.roleKind}</span>
                </td>
                <td data-label="Subjects">
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
                  <td data-label="Actions">
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
              <tr key={`${r._type}/${r.metadata.namespace ?? 'cluster'}/${r.metadata.name}`}>
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
              <tr key={`${sa.metadata.namespace}/${sa.metadata.name}`}>
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

  function renderFindings() {
    return (
      <SecurityFindingsTable
        findings={rbacFindings.findings}
        loading={rbacFindings.loading}
        error={rbacFindings.error}
        busyId={rbacFindings.busyId}
        onAccept={rbacFindings.accept}
        onRescan={rbacFindings.rescan}
        onEscalate={rbacFindings.escalate}
        emptyMessage={
          `No open findings${clusterFriendlyName ? ` for ${clusterFriendlyName}` : ''}. ` +
          `Enable RBAC_POSTURE_ENABLED=true and wait for a scan cycle if this cluster hasn't been scanned yet.`
        }
      />
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
                <button className="btn-sm btn-danger" onClick={() => setConfirmDeleteGroup(g)}>Delete</button>
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

  const tabContent = [renderBindings, renderRoles, renderServiceAccounts, renderAudit, renderFindings, renderTeams, renderUserPerms]

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

      {/* ── RBAC watch summary — fleet-wide, drills into the dedicated sync page ── */}
      {isAdmin && (
        <div className="rbac-sync-banner">
          <div className="rbac-sync-banner-info">
            <span className="rbac-sync-banner-icon">⟳</span>
            <div>
              <div className="rbac-sync-banner-title">RBAC Sync</div>
              <div className="rbac-sync-banner-sub">
                {syncPendingCount > 0
                  ? `${syncPendingCount} pending change${syncPendingCount !== 1 ? 's' : ''} across monitored clusters`
                  : 'All monitored clusters are in sync'}
                {syncReviewCount > 0 && ` · ${syncReviewCount} need${syncReviewCount === 1 ? 's' : ''} manual review`}
              </div>
            </div>
          </div>
          <button className="rbac-sync-banner-btn" onClick={() => navigate('/rbac/sync')}>
            {syncPendingCount > 0 && <span className="rbac-sync-banner-count">{syncPendingCount}</span>}
            Open Sync Center
            <span className="rbac-sync-banner-arrow">→</span>
          </button>
        </div>
      )}

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
      {/* key={tab}: every tab's render function returns the same top-level shape
          (div.table-wrap > table.data-table) with a different row-key scheme, so
          without a key change here React tries to diff/reuse that DOM across tab
          switches instead of fully replacing it — which is what let content from
          one tab visually linger into another. Forcing a fresh subtree per tab
          eliminates that regardless of the two row-key fixes above. */}
      {loading
        ? <div className="page-loading">Loading RBAC data…</div>
        : (overview || audit)
          ? <div key={tab}>{tabContent[tab]()}</div>
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
        <ConfirmDialog
          title="Confirm delete"
          message={`Delete ${delTarget.kind}/${delTarget.name}${delTarget.namespace ? ` in namespace ${delTarget.namespace}` : ''}? This action cannot be undone.`}
          confirmLabel={delBusy ? 'Deleting…' : 'Delete'}
          confirmDisabled={delBusy}
          onConfirm={confirmDelete}
          onCancel={() => setDelTarget(null)}
        />
      )}

      {/* ── Team delete confirm ─────────────────────────────────────────── */}
      {confirmDeleteGroup && (
        <ConfirmDialog
          title="Delete team?"
          message={`Delete team "${confirmDeleteGroup.name}"? Members will be unlinked.`}
          confirmLabel="Delete"
          onConfirm={() => { deleteGroup(confirmDeleteGroup); setConfirmDeleteGroup(null) }}
          onCancel={() => setConfirmDeleteGroup(null)}
        />
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

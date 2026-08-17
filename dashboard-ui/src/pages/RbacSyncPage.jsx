import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useNotify } from '../contexts/NotifyContext'

function nsLabel(ns) {
  return ns === '*' ? 'cluster-wide' : ns
}

// Fleet-wide counterpart to the per-cluster sync button that used to live on RbacPage:
// the watch (rbacWatcher.js) runs for every monitored cluster at once in the background,
// so reviewing/applying what it's found belongs on one page that covers all of them,
// not gated behind whichever single cluster happens to be selected in a dropdown.
export default function RbacSyncPage() {
  const navigate = useNavigate()
  const notify   = useNotify()

  const [pendingByCluster, setPendingByCluster] = useState([]) // [{ cluster, context, pending: [...] }]
  const [advisories,       setAdvisories]        = useState([]) // [{ cluster, context, bindingKind, ..., k8sUsers, dbUsers }]
  const [unmatchedUsers,   setUnmatchedUsers]    = useState([]) // [{ email, scopes: [{ cluster, namespace, role, bindingName, timestamp }] }]
  const [lastResults,      setLastResults]       = useState(null) // [{ cluster, context, updated, deleted, unmatched, deletedUnmatched } | { cluster, context, error }]
  const [syncBusy,         setSyncBusy]          = useState(false)

  const loadPending = useCallback(async () => {
    try {
      const r = await apiFetch('/api/rbac/pending-changes')
      const d = await r.json()
      setPendingByCluster(Array.isArray(d.clusters) ? d.clusters : [])
    } catch { /* leave the last known list rather than clearing it on a transient error */ }
  }, [])

  const loadAdvisories = useCallback(async () => {
    try {
      const r = await apiFetch('/api/rbac/multi-subject-advisories')
      const d = await r.json()
      setAdvisories(Array.isArray(d.advisories) ? d.advisories : [])
    } catch { /* leave the last known list rather than clearing it on a transient error */ }
  }, [])

  const loadUnmatchedUsers = useCallback(async () => {
    try {
      const r = await apiFetch('/api/rbac/unmatched-users')
      const d = await r.json()
      setUnmatchedUsers(Array.isArray(d.users) ? d.users : [])
    } catch { /* leave the last known list rather than clearing it on a transient error */ }
  }, [])

  useEffect(() => { loadPending(); loadAdvisories(); loadUnmatchedUsers() }, [loadPending, loadAdvisories, loadUnmatchedUsers])
  useEffect(() => {
    const iv = setInterval(() => { loadPending(); loadAdvisories(); loadUnmatchedUsers() }, 20_000)
    return () => clearInterval(iv)
  }, [loadPending, loadAdvisories, loadUnmatchedUsers])

  function addUnmatchedUser(email) {
    navigate('/users', { state: { prefillEmail: email } })
  }

  async function syncAll() {
    setSyncBusy(true)
    try {
      const r = await apiFetch('/api/rbac/sync-from-k8s', { method: 'POST' })
      const d = await r.json()
      const results = Array.isArray(d.results) ? d.results : []
      setLastResults(results)

      const totals = results.reduce((acc, res) => {
        if (res.error) { acc.errors++; return acc }
        acc.updated   += res.updated?.length   ?? 0
        acc.deleted   += res.deleted?.length   ?? 0
        acc.unmatched += (res.unmatched?.length ?? 0) + (res.deletedUnmatched?.length ?? 0)
        acc.failed    += res.failed?.length ?? 0
        return acc
      }, { updated: 0, deleted: 0, unmatched: 0, failed: 0, errors: 0 })

      const parts = []
      if (totals.updated)   parts.push(`${totals.updated} updated`)
      if (totals.deleted)   parts.push(`${totals.deleted} access removed`)
      if (totals.unmatched) parts.push(`${totals.unmatched} need attention`)
      if (totals.failed)    parts.push(`${totals.failed} failed, will retry`)
      if (totals.errors)    parts.push(`${totals.errors} cluster(s) failed`)
      notify(totals.errors ? 'error' : 'success',
        parts.length ? `Synced ${results.length} cluster(s): ${parts.join(', ')}` : `Synced ${results.length} cluster(s): no pending changes`)

      loadPending()
    } catch (err) { notify('error', err.message) }
    finally { setSyncBusy(false) }
  }

  const totalPending    = pendingByCluster.reduce((s, c) => s + c.pending.length, 0)
  const clustersPending = pendingByCluster.filter(c => c.pending.length > 0)

  return (
    <div className="rbac-page">
      <div className="page-header">
        <div>
          <button className="rbac-sync-back" onClick={() => navigate('/rbac')}>← Back to RBAC</button>
          <h2>RBAC Sync</h2>
          <p className="page-subtitle">Apply RBAC changes the live Kubernetes watch has detected, across every monitored cluster</p>
        </div>
        <div className="rbac-header-actions">
          <button className="btn-primary" onClick={syncAll} disabled={syncBusy}>
            {syncBusy ? 'Syncing…' : `⟳ Sync All Clusters${totalPending > 0 ? ` (${totalPending})` : ''}`}
          </button>
        </div>
      </div>

      {/* ── Pending changes, grouped by cluster ── */}
      <div className="rbac-sync-panel">
        <div className="rbac-sync-panel-section">
          <div className="rbac-sync-panel-title">
            ⏳ {totalPending} pending change{totalPending !== 1 ? 's' : ''} across {clustersPending.length} cluster{clustersPending.length !== 1 ? 's' : ''}
          </div>
          {clustersPending.length === 0 && (
            <div className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>Nothing queued — every monitored cluster is in sync.</div>
          )}
          {clustersPending.map(c => (
            <div key={c.context} className="rbac-sync-cluster-group">
              <div className="rbac-sync-cluster-name">{c.cluster} <span className="text-dim">({c.pending.length})</span></div>
              <div className="rbac-pending-list">
                {c.pending.map((change, i) => (
                  <div key={i} className="rbac-pending-row">
                    <span className={`rbac-change-badge rbac-change-${change.changeType.toLowerCase()}`}>{change.changeType}</span>
                    <span className="mono-small">{change.email}</span>
                    <span className="text-dim">→ {change.role} @ {nsLabel(change.namespace)}</span>
                    <span className="text-dim rbac-pending-time">{new Date(change.timestamp).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── New users detected on K8s with no matching KubePilot account ── */}
      <div className="rbac-sync-panel">
        <div className="rbac-sync-panel-section">
          <div className="rbac-sync-panel-title">
            🆕 {unmatchedUsers.length} new user{unmatchedUsers.length !== 1 ? 's' : ''} detected — not yet in KubePilot
          </div>
          {unmatchedUsers.length === 0 ? (
            <div className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>
              No K8s-granted emails are waiting on a KubePilot account.
            </div>
          ) : (
            <div className="rbac-review-list">
              {unmatchedUsers.map(u => (
                <div key={u.email} className="rbac-review-card">
                  <div className="rbac-review-card-head">
                    <span className="mono-small">{u.email}</span>
                    <button className="btn-sm btn-primary" onClick={() => addUnmatchedUser(u.email)}>+ Add to KubePilot</button>
                  </div>
                  <div className="rbac-pending-list">
                    {u.scopes.map((s, i) => (
                      <div key={i} className="rbac-pending-row">
                        <span className="rbac-stat-pill">{s.cluster}</span>
                        <span className="text-dim">→ {s.role} @ {nsLabel(s.namespace)}</span>
                        <span className="text-dim rbac-pending-time">{new Date(s.timestamp).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Last sync result, grouped by cluster ── */}
      {lastResults && (
        <div className="rbac-sync-panel">
          <div className="rbac-sync-panel-section">
            <div className="rbac-sync-panel-title-row">
              <span className="rbac-sync-panel-title">✓ Last sync result</span>
              <button className="rbac-sync-panel-dismiss" onClick={() => setLastResults(null)}>✕</button>
            </div>
            {lastResults.map((res, ci) => (
              <div key={ci} className="rbac-sync-cluster-group">
                <div className="rbac-sync-cluster-name">{res.cluster}</div>

                {res.error && <div className="cm-error">{res.error}</div>}

                {!res.error && res.updated.length > 0 && (
                  <div className="rbac-sync-result-group">
                    <div className="rbac-sync-result-label rbac-sync-result-ok">✓ Successfully synced ({res.updated.length})</div>
                    {res.updated.map((u, i) => (
                      <div key={i} className="rbac-sync-result-row mono-small">{u.email} → {u.role} @ {nsLabel(u.namespace)}</div>
                    ))}
                  </div>
                )}

                {!res.error && res.deleted.length > 0 && (
                  <div className="rbac-sync-result-group">
                    <div className="rbac-sync-result-label rbac-sync-result-warn">↺ Access removed ({res.deleted.length})</div>
                    {res.deleted.map((u, i) => (
                      <div key={i} className="rbac-sync-result-row mono-small">{u.email} — {u.role} @ {nsLabel(u.namespace)}</div>
                    ))}
                  </div>
                )}

                {!res.error && (res.unmatched.length > 0 || res.deletedUnmatched.length > 0) && (
                  <div className="rbac-sync-result-group">
                    <div className="rbac-sync-result-label rbac-sync-result-danger">
                      ⚠ Pending manual add ({res.unmatched.length + res.deletedUnmatched.length})
                    </div>
                    {res.unmatched.map((u, i) => (
                      <div key={`u${i}`} className="rbac-sync-result-row mono-small">
                        {u.email} → {u.role} @ {nsLabel(u.namespace)} — no matching KubePilot account, add manually
                      </div>
                    ))}
                    {res.deletedUnmatched.map((u, i) => (
                      <div key={`d${i}`} className="rbac-sync-result-row mono-small">
                        {u.email} — binding removed from K8s but no stored permission matched
                      </div>
                    ))}
                  </div>
                )}

                {!res.error && res.failed?.length > 0 && (
                  <div className="rbac-sync-result-group">
                    <div className="rbac-sync-result-label rbac-sync-result-danger">⚠ Failed, will retry ({res.failed.length})</div>
                    {res.failed.map((u, i) => (
                      <div key={`f${i}`} className="rbac-sync-result-row mono-small">
                        {u.email} → {u.role} @ {nsLabel(u.namespace)} — {u.error}
                      </div>
                    ))}
                  </div>
                )}

                {!res.error && res.updated.length === 0 && res.deleted.length === 0 &&
                 res.unmatched.length === 0 && res.deletedUnmatched.length === 0 && !res.failed?.length && (
                  <div className="text-dim" style={{ fontSize: 12 }}>No pending changes were applied.</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Needs Review — multi-subject bindings, grouped by cluster ── */}
      <div className="rbac-sync-panel">
      <div className="rbac-sync-panel-section">
        <div className="rbac-sync-panel-title">
          ⚠ Needs Review — {advisories.length} multi-user binding{advisories.length !== 1 ? 's' : ''} can't be safely auto-diffed
        </div>
        {advisories.length === 0 ? (
          <div className="empty-state">
            No multi-user bindings need review right now. Bindings with a single user subject sync
            automatically; a binding with more than one user can't be safely auto-diffed on an edit
            (the watch only shows who's on it now, not who was removed), so those show up here
            instead of being applied automatically.
          </div>
        ) : (
          <div className="rbac-review-list">
            {advisories.map((a, i) => {
              const k8sSet = new Set(a.k8sUsers.map(e => e.toLowerCase()))
              const dbSet  = new Set(a.dbUsers.map(e => e.toLowerCase()))
              return (
                <div key={i} className="rbac-review-card">
                  <div className="rbac-review-card-head">
                    <span className="rbac-stat-pill">{a.cluster}</span>
                    <span className={`rbac-scope-badge rbac-scope-${a.bindingKind === 'ClusterRoleBinding' ? 'cluster' : 'namespace'}`}>
                      {a.bindingKind}
                    </span>
                    <span className="mono-small">{a.bindingName}</span>
                    <span className="text-dim">{nsLabel(a.namespace)} · role: {a.role}</span>
                    <span className="text-dim rbac-review-time">
                      last {a.lastEventType?.toLowerCase()} · {new Date(a.lastSeenAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="rbac-review-columns">
                    <div className="rbac-review-col">
                      <div className="rbac-review-col-title">In the Kubernetes binding ({a.k8sUsers.length})</div>
                      {a.k8sUsers.map(email => (
                        <div key={email} className="rbac-review-row mono-small">
                          {email}
                          {!dbSet.has(email.toLowerCase()) && <span className="rbac-review-tag rbac-review-tag-new">not yet in KubePilot</span>}
                        </div>
                      ))}
                    </div>
                    <div className="rbac-review-col">
                      <div className="rbac-review-col-title">In KubePilot, same cluster/namespace/role ({a.dbUsers.length})</div>
                      {a.dbUsers.length === 0 && <div className="text-dim" style={{ fontSize: 12 }}>No matching KubePilot permissions</div>}
                      {a.dbUsers.map(email => (
                        <div key={email} className="rbac-review-row mono-small">
                          {email}
                          {!k8sSet.has(email.toLowerCase()) && <span className="rbac-review-tag rbac-review-tag-stale">not in the K8s binding — possibly removed</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

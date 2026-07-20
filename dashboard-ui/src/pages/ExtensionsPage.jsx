import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import ConfirmDialog from '../components/ConfirmDialog'
import { useMonitoredClusters } from '../hooks/useMonitoredClusters'

const REFRESH_MS = 60_000
const STATUS_CLASS = { deployed: 'cp-phase-running', failed: 'cp-phase-fail', pending: 'cp-phase-pending', 'pending-upgrade': 'cp-phase-pending', 'pending-rollback': 'cp-phase-pending' }

export default function ExtensionsPage({ embedded = false }) {
  const { user } = useAuth()
  const notify   = useNotify()
  const { clusters, selected, setSelected } = useMonitoredClusters()
  const [tab, setTab]           = useState('helm') // 'helm' | 'crds'
  const [crds, setCrds]         = useState([])
  const [helmData, setHelmData] = useState(null)
  const [loading, setLoading]   = useState(false)
  const [pendingRollback, setPendingRollback] = useState(null)
  const [rollingBack, setRollingBack] = useState(false)

  const load = useCallback(async (cluster) => {
    if (!cluster) return
    setLoading(true)
    try {
      const [crdRes, helmRes] = await Promise.all([
        apiFetch(`/api/extensions/crds?cluster=${encodeURIComponent(cluster)}`),
        apiFetch(`/api/extensions/helm?cluster=${encodeURIComponent(cluster)}`),
      ])
      setCrds((await crdRes.json()).crds ?? [])
      setHelmData(await helmRes.json())
    } catch { setCrds([]); setHelmData(null) }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!selected) return
    load(selected)
    const id = setInterval(() => load(selected), REFRESH_MS)
    return () => clearInterval(id)
  }, [selected, load])

  async function confirmRollback() {
    const rel = pendingRollback
    if (!rel) return
    setRollingBack(true)
    try {
      const r = await apiFetch(`/api/extensions/helm/${encodeURIComponent(rel.name)}/rollback`, {
        method: 'POST', body: { cluster: selected, namespace: rel.namespace },
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); notify('error', d.error || 'Rollback failed'); return }
      notify('success', `Rolled back ${rel.name}`)
      load(selected)
    } catch (err) { notify('error', err.message) }
    finally { setRollingBack(false); setPendingRollback(null) }
  }

  return (
    <div className={embedded ? 'cp-page cp-page-embedded' : 'cp-page'}>
      <div className="page-header">
        {embedded
          ? <p className="page-subtitle">Custom Resource Definitions and Helm releases — apps KubePilot doesn't otherwise see</p>
          : (
            <div>
              <h2>Extensions</h2>
              <p className="page-subtitle">Custom Resource Definitions and Helm releases — apps KubePilot doesn't otherwise see</p>
            </div>
          )}
        <div className="cp-controls">
          <select value={selected} onChange={e => setSelected(e.target.value)}>
            {clusters.map(c => <option key={c.name} value={c.config?.name ?? c.name}>{c.config?.name ?? c.name}</option>)}
          </select>
          <button className="btn-primary" onClick={() => load(selected)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="filter-chips" style={{ marginBottom: 14 }}>
        <button className={`filter-chip ${tab === 'helm' ? 'active' : ''}`} onClick={() => setTab('helm')}>Helm Releases</button>
        <button className={`filter-chip ${tab === 'crds' ? 'active' : ''}`} onClick={() => setTab('crds')}>CRDs ({crds.length})</button>
      </div>

      {tab === 'helm' && (
        helmData && !helmData.available
          ? <div className="cp-empty">Helm is not installed on the KubePilot server — no release data available.</div>
          : !helmData?.releases?.length
            ? <div className="cp-empty">No Helm releases found on this cluster</div>
            : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Release</th><th>Namespace</th><th>Chart</th><th>App Version</th><th>Revision</th><th>Status</th><th>Updated</th><th></th></tr></thead>
                  <tbody>
                    {helmData.releases.map(r => (
                      <tr key={`${r.namespace}/${r.name}`}>
                        <td className="fw-500 mono-small">{r.name}</td>
                        <td className="text-dim">{r.namespace}</td>
                        <td className="mono-small">{r.chart}</td>
                        <td>{r.appVersion || '—'}</td>
                        <td>{r.revision}</td>
                        <td><span className={`cp-phase ${STATUS_CLASS[r.status] ?? 'cp-phase-unknown'}`}>{r.status}</span></td>
                        <td className="text-dim mono-small">{r.updated}</td>
                        <td>
                          {user.role === 'admin' && r.revision > 1 && (
                            <button className="btn-sm btn-danger" onClick={() => setPendingRollback(r)}>Rollback</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
      )}

      {tab === 'crds' && (
        crds.length === 0
          ? <div className="cp-empty">No Custom Resource Definitions installed on this cluster</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Kind</th><th>Group</th><th>Scope</th><th>Versions</th></tr></thead>
                <tbody>
                  {crds.map(c => (
                    <tr key={c.name}>
                      <td className="fw-500 mono-small">{c.kind}</td>
                      <td className="text-dim mono-small">{c.group}</td>
                      <td>{c.scope}</td>
                      <td className="text-dim">{c.versions?.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {pendingRollback && (
        <ConfirmDialog
          icon="↩"
          title={`Rollback ${pendingRollback.name}?`}
          message={`This rolls back to the previous revision of this Helm release in "${pendingRollback.namespace}". Pods managed by it will be recreated.`}
          confirmLabel={rollingBack ? 'Rolling back…' : 'Rollback'}
          onConfirm={confirmRollback}
          onCancel={() => setPendingRollback(null)}
        />
      )}
    </div>
  )
}

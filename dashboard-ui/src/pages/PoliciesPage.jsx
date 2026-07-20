import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useMonitoredClusters } from '../hooks/useMonitoredClusters'
import { QuotaBar } from '../components/QuotaBar'

const REFRESH_MS = 60_000

const PS_LEVEL_COLOR = { restricted: 'var(--success, #22c55e)', baseline: 'var(--warn)', privileged: 'var(--danger)' }

export default function PoliciesPage() {
  const { clusters, selected, setSelected } = useMonitoredClusters()
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  const load = useCallback(async (cluster) => {
    if (!cluster) return
    setLoading(true); setError(null)
    try {
      const r = await apiFetch(`/api/policies/overview?cluster=${encodeURIComponent(cluster)}`)
      if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error || 'Failed to load'); setData(null); return }
      setData(await r.json())
    } catch (err) { setError(err.message); setData(null) }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!selected) return
    load(selected)
    const id = setInterval(() => load(selected), REFRESH_MS)
    return () => clearInterval(id)
  }, [selected, load])

  const quotas = data?.quotas ?? []
  const pdbs = data?.pdbs ?? []
  const podSecurity = data?.podSecurity ?? []

  return (
    <div className="cp-page">
      <div className="page-header">
        <div>
          <h2>Policies</h2>
          <p className="page-subtitle">Quotas, disruption budgets, and Pod Security posture — admin-only, read-only</p>
        </div>
        <div className="cp-controls">
          <select value={selected} onChange={e => setSelected(e.target.value)}>
            {clusters.map(c => <option key={c.name} value={c.config?.name ?? c.name}>{c.config?.name ?? c.name}</option>)}
          </select>
          <button className="btn-primary" onClick={() => load(selected)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="cm-error" style={{ marginBottom: 14 }}>{error}</div>}
      {!data && !loading && !error && <div className="cp-empty">Select a cluster to view policy objects</div>}

      {data && (<>
        <div className="cp-section">
          <h3 className="cp-section-title">Resource Quotas ({quotas.length})</h3>
          {quotas.length === 0
            ? <div className="cp-empty">No ResourceQuotas configured on this cluster</div>
            : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Namespace</th><th>Quota</th><th>CPU (requests)</th><th>Memory (requests)</th></tr></thead>
                  <tbody>
                    {quotas.map(q => (
                      <tr key={`${q.namespace}/${q.name}`}>
                        <td className="fw-500">{q.namespace}</td>
                        <td className="text-dim mono-small">{q.name}</td>
                        <td><QuotaBar used={q.used['requests.cpu'] ?? q.used.cpu} hard={q.hard['requests.cpu'] ?? q.hard.cpu} /></td>
                        <td><QuotaBar used={q.used['requests.memory'] ?? q.used.memory} hard={q.hard['requests.memory'] ?? q.hard.memory} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>

        <div className="cp-section">
          <h3 className="cp-section-title">Pod Disruption Budgets ({pdbs.length})</h3>
          {pdbs.length === 0
            ? <div className="cp-empty">No PodDisruptionBudgets configured on this cluster</div>
            : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Name</th><th>Namespace</th><th>Min Available</th><th>Max Unavailable</th><th>Healthy</th><th>Disruptions Allowed</th></tr></thead>
                  <tbody>
                    {pdbs.map(p => (
                      <tr key={`${p.namespace}/${p.name}`}>
                        <td className="fw-500 mono-small">{p.name}</td>
                        <td className="text-dim">{p.namespace}</td>
                        <td>{p.minAvailable ?? '—'}</td>
                        <td>{p.maxUnavailable ?? '—'}</td>
                        <td>{p.currentHealthy ?? '—'} / {p.desiredHealthy ?? '—'}</td>
                        <td>
                          {p.disruptionsAllowed === 0
                            ? <span className="cm-current-badge" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>0 — blocks drain/restart</span>
                            : <span>{p.disruptionsAllowed ?? '—'}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>

        <div className="cp-section">
          <h3 className="cp-section-title">Pod Security Posture ({podSecurity.length} namespaces)</h3>
          <div className="cm-notice" style={{ marginBottom: 10 }}>
            Only namespaces with a Pod Security label are meaningfully configured — "—" means the cluster default applies.
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Namespace</th><th>Enforce</th><th>Warn</th><th>Audit</th></tr></thead>
              <tbody>
                {podSecurity.map(ns => (
                  <tr key={ns.namespace}>
                    <td className="fw-500">{ns.namespace}</td>
                    {['enforce', 'warn', 'audit'].map(k => (
                      <td key={k}>
                        {ns[k]
                          ? <span className="cm-current-badge" style={{ background: 'transparent', border: `1px solid ${PS_LEVEL_COLOR[ns[k]] ?? 'var(--border)'}`, color: PS_LEVEL_COLOR[ns[k]] ?? 'var(--text)' }}>{ns[k]}</span>
                          : <span className="text-dim">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>)}
    </div>
  )
}

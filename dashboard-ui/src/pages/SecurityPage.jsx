import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useMonitoredClusters } from '../hooks/useMonitoredClusters'
import { SEVERITY_COLOR } from '../constants'

const KIND_INFO = {
  RbacPosture:       { label: 'RBAC Posture',       page: '/rbac' },
  WorkloadHardening: { label: 'Workload Hardening', page: '/hardening' },
  NetworkExposure:   { label: 'Network Exposure',   page: '/network' },
  SecretsHygiene:    { label: 'Secrets',            page: '/secrets' },
}
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']

// Ties every finding family together into one fleet-wide scorecard — the other
// four pages (RBAC Findings tab, Hardening, Network, Secrets) each show one
// cluster's findings for one kind; this is the "which of my clusters has open
// critical findings right now" view across all of them at once.
export default function SecurityPage({ onNavigate }) {
  const { clusters } = useMonitoredClusters()
  const [byCluster, setByCluster] = useState({}) // clusterName -> overview response
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')

  const load = useCallback(async () => {
    if (clusters.length === 0) return
    setLoading(true); setError('')
    try {
      const names = clusters.map(c => c.config?.name ?? c.name)
      const results = await Promise.all(names.map(async name => {
        const r = await apiFetch(`/api/security/overview?cluster=${encodeURIComponent(name)}`)
        const d = await r.json()
        return [name, d.error ? null : d]
      }))
      setByCluster(Object.fromEntries(results))
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }, [clusters])

  useEffect(() => { load() }, [load])

  async function exportCsv() {
    const r = await apiFetch('/api/security/report')
    if (!r.ok) return
    const blob = await r.blob()
    const url  = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'security-findings.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const clusterNames = clusters.map(c => c.config?.name ?? c.name)

  return (
    <div className="cp-page">
      <div className="page-header">
        <div>
          <h2>Security</h2>
          <p className="page-subtitle">Fleet-wide posture across RBAC, workload hardening, network exposure, and secrets hygiene</p>
        </div>
        <div className="cp-controls">
          <button className="btn-sm" onClick={exportCsv}>⬇ Export CSV</button>
          <button className="btn-primary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="cm-error" style={{ marginBottom: 14 }}>{error}</div>}

      {clusterNames.length === 0 && !loading && (
        <div className="cp-empty">No monitored clusters configured</div>
      )}

      <div className="tp-grid">
        {clusterNames.map(name => {
          const overview = byCluster[name]
          return (
            <div key={name} className="tp-card">
              <div className="tp-card-head">
                <div>
                  <div className="tp-card-name">{name}</div>
                  <div className="tp-card-desc">{overview ? `${overview.total} open finding(s)` : loading ? 'Loading…' : 'No data yet'}</div>
                </div>
              </div>

              {overview && overview.total > 0 && (
                <div className="tp-card-section">
                  <div className="tp-label">By severity</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {SEVERITY_ORDER.filter(s => overview.bySeverity[s] > 0).map(s => (
                      <span key={s} className="cm-current-badge" style={{ background: 'transparent', border: `1px solid ${SEVERITY_COLOR[s]}`, color: SEVERITY_COLOR[s] }}>
                        {overview.bySeverity[s]} {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="tp-card-section">
                <div className="tp-label">By family</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {Object.entries(KIND_INFO).map(([kind, info]) => (
                    <div key={kind} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="text-dim">{info.label}</span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span>{overview?.byKind?.[kind] ?? 0}</span>
                        <button className="btn-sm" onClick={() => onNavigate?.(info.page)}>View →</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { useMonitoredClusters } from '../hooks/useMonitoredClusters'
import { PercentBar as Bar } from '../components/QuotaBar'

const REFRESH_MS = 30_000

function EditHpaModal({ hpa, cluster, onClose, onSaved }) {
  const notify = useNotify()
  const [minReplicas, setMinReplicas] = useState(hpa.minReplicas)
  const [maxReplicas, setMaxReplicas] = useState(hpa.maxReplicas)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const r = await apiFetch(`/api/autoscaling/hpas/${encodeURIComponent(hpa.name)}`, {
        method: 'PUT',
        body: { cluster, namespace: hpa.namespace, minReplicas: +minReplicas, maxReplicas: +maxReplicas },
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error || 'Save failed'); return }
      notify('success', `Updated ${hpa.name}`)
      onSaved()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>Edit {hpa.name}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSave} className="modal-form">
          <div className="field"><label>Namespace</label><input value={hpa.namespace} disabled /></div>
          <div className="field"><label>Min Replicas</label>
            <input type="number" min="1" value={minReplicas} onChange={e => setMinReplicas(e.target.value)} required />
          </div>
          <div className="field"><label>Max Replicas</label>
            <input type="number" min="1" value={maxReplicas} onChange={e => setMaxReplicas(e.target.value)} required />
          </div>
          {error && <div className="login-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function AutoscalingPage({ embedded = false }) {
  const { user } = useAuth()
  const { clusters, selected, setSelected } = useMonitoredClusters()
  const [data, setData]             = useState(null)
  const [loading, setLoading]       = useState(false)
  const [editing, setEditing]       = useState(null)

  const load = useCallback(async (cluster) => {
    if (!cluster) return
    setLoading(true)
    try {
      const r = await apiFetch(`/api/autoscaling/hpas?cluster=${encodeURIComponent(cluster)}`)
      setData(await r.json())
    } catch { setData(null) }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!selected) return
    load(selected)
    const id = setInterval(() => load(selected), REFRESH_MS)
    return () => clearInterval(id)
  }, [selected, load])

  const hpas = data?.hpas ?? []

  return (
    <div className={embedded ? 'cp-page cp-page-embedded' : 'cp-page'}>
      <div className="page-header">
        {embedded
          ? <p className="page-subtitle">HorizontalPodAutoscalers — replica targets vs. live state</p>
          : (
            <div>
              <h2>Autoscaling</h2>
              <p className="page-subtitle">HorizontalPodAutoscalers — replica targets vs. live state</p>
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

      {data && !data.metricsAvailable && (
        <div className="cm-notice" style={{ marginBottom: 14 }}>
          ⚠ metrics-server is unreachable on this cluster — every HPA below is unable to scale until it's fixed.
        </div>
      )}

      {!data && loading && <div className="cp-empty">Loading…</div>}
      {!data && !loading && <div className="cp-empty">Select a cluster to view autoscalers</div>}

      {data && hpas.length === 0 && <div className="cp-empty">No HorizontalPodAutoscalers found on this cluster</div>}

      {data && hpas.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>App</th><th>Namespace</th><th>Replicas</th><th>Target CPU</th>
                <th>Current CPU</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {hpas.map(h => (
                <tr key={`${h.namespace}/${h.name}`}>
                  <td className="fw-500 mono-small">{h.target}</td>
                  <td className="text-dim">{h.namespace}</td>
                  <td className="mono-small">{h.currentReplicas} / {h.desiredReplicas} <span className="text-dim">(min {h.minReplicas}, max {h.maxReplicas})</span></td>
                  <td>{h.cpuTarget != null ? `${h.cpuTarget}%` : '—'}</td>
                  <td><Bar value={h.cpuCurrent} size="sm" /></td>
                  <td>
                    {h.stuck
                      ? <span className="cm-current-badge" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }} title="Can't scale — metrics unavailable">✗ stuck</span>
                      : <span className="cm-current-badge" style={{ background: 'var(--success-dim, rgba(34,197,94,.12))', color: 'var(--success, #22c55e)' }}>✓ active</span>}
                  </td>
                  <td>
                    {user.role === 'admin' && (
                      <button className="btn-sm" onClick={() => setEditing(h)}>Edit</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditHpaModal
          hpa={editing}
          cluster={selected}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(selected) }}
        />
      )}
    </div>
  )
}

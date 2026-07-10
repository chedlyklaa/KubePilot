import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'

export default function ClusterManager({ onClose, onSaved }) {
  const [contexts,   setContexts]   = useState([])
  const [selections, setSelections] = useState({})
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState(null)

  useEffect(() => {
    apiFetch('/api/kube/contexts')
      .then(r => r.json())
      .then(data => {
        setContexts(data.contexts ?? [])
        const init = {}
        for (const ctx of data.contexts ?? []) {
          init[ctx.name] = {
            enabled:     ctx.isMonitored,
            displayName: ctx.config?.name ?? ctx.name,
            tier:        ctx.config?.tier ?? 'dev',
          }
        }
        setSelections(init)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  function update(ctxName, patch) {
    setSelections(p => ({ ...p, [ctxName]: { ...p[ctxName], ...patch } }))
  }

  async function downloadKubeconfig(clusterName) {
    setError(null)
    try {
      const r = await apiFetch(`/api/kube/clusters/${encodeURIComponent(clusterName)}/kubeconfig`)
      if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error || 'Download failed'); return }
      const blob = await r.blob()
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `kubeconfig-${clusterName}.yaml`; a.click()
      URL.revokeObjectURL(url)
    } catch (err) { setError(err.message) }
  }

  async function handleSave() {
    setSaving(true); setError(null)
    try {
      const clusters = Object.entries(selections)
        .filter(([, v]) => v.enabled)
        .map(([ctx, v]) => ({ name: v.displayName || ctx, context: ctx, tier: v.tier }))
      const r = await apiFetch('/api/kube/clusters', {
        method: 'PUT',
        body: { clusters },
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error || 'Save failed'); return }
      onSaved()
      onClose()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const enabledCount = Object.values(selections).filter(v => v.enabled).length

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cluster-mgr" onClick={e => e.stopPropagation()}>

        <div className="cluster-mgr-header">
          <span className="cluster-mgr-title">⚙ Manage Monitored Clusters</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="cluster-mgr-body">
          {loading && <div className="cm-info">Discovering kubectl contexts…</div>}
          {error   && <div className="cm-error">{error}</div>}
          {!loading && contexts.length === 0 && (
            <div className="cm-info">No kubectl contexts found.</div>
          )}

          {!loading && contexts.length > 0 && (
            <table className="cm-table">
              <thead>
                <tr>
                  <th className="cm-th cm-th-check"></th>
                  <th className="cm-th">Context</th>
                  <th className="cm-th">Display Name</th>
                  <th className="cm-th">Tier</th>
                  <th className="cm-th"></th>
                </tr>
              </thead>
              <tbody>
                {contexts.map(ctx => {
                  const sel = selections[ctx.name] ?? { enabled: false, displayName: ctx.name, tier: 'dev' }
                  return (
                    <tr key={ctx.name} className={`cm-row${sel.enabled ? ' cm-row-on' : ''}`}>
                      <td className="cm-td cm-th-check">
                        <input type="checkbox" className="cm-check"
                          checked={sel.enabled}
                          onChange={e => update(ctx.name, { enabled: e.target.checked })} />
                      </td>
                      <td className="cm-td">
                        <span className="cm-ctx-name">{ctx.name}</span>
                        {ctx.isCurrent && <span className="cm-current-badge">current</span>}
                      </td>
                      <td className="cm-td">
                        <input className="cm-name-input" value={sel.displayName}
                          disabled={!sel.enabled}
                          onChange={e => update(ctx.name, { displayName: e.target.value })}
                          placeholder={ctx.name} />
                      </td>
                      <td className="cm-td">
                        <select className="cm-tier-select" value={sel.tier}
                          disabled={!sel.enabled}
                          onChange={e => update(ctx.name, { tier: e.target.value })}>
                          <option value="dev">dev</option>
                          <option value="staging">staging</option>
                          <option value="production">production</option>
                        </select>
                      </td>
                      <td className="cm-td">
                        {ctx.isMonitored && (
                          <button type="button" className="btn-sm" title="Download this cluster's kubeconfig (full access — admin only)"
                            onClick={() => downloadKubeconfig(ctx.config?.name ?? ctx.name)}>
                            ⬇ Kubeconfig
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <div className="cm-notice">
            ✓ Changes apply automatically — no restart needed. The dashboard refreshes
            immediately and the agent pipeline picks up new clusters within one cycle.
          </div>
        </div>

        <div className="cluster-mgr-footer">
          <span className="cm-count">{enabledCount} cluster{enabledCount !== 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn" onClick={handleSave} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

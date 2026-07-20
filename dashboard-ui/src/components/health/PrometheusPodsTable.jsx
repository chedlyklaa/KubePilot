import { useState } from 'react'
import { fmtBytes, RestartCount } from './atoms'
import { ALERT_LABELS } from './alertLabels'

function CpuBar({ cores }) {
  if (cores == null) return <span className="hcell-dim">—</span>
  const pct = Math.min(100, cores * 100)
  const cls = pct > 80 ? 'mf-danger' : pct > 50 ? 'mf-warn' : 'mf-ok'
  return (
    <div className="prom-cpu-wrap">
      <span className="prom-cpu-val">{cores < 0.001 ? '<0.001' : cores.toFixed(3)}</span>
      <div className="mbar-track prom-cpu-track">
        <div className={`mbar-fill ${cls}`} style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
    </div>
  )
}

function OomBadge({ oomKilled }) {
  return oomKilled
    ? <span className="prom-oom-yes" title="OOMKilled detected">OOM</span>
    : <span className="prom-oom-no">—</span>
}

function ErrorTypeBadges({ types }) {
  if (!types?.length) return <span className="prom-ok">✓</span>
  return (
    <div className="prom-err-types">
      {types.map(t => (
        <span key={t} className="prom-err-badge">{ALERT_LABELS[t] ?? t}</span>
      ))}
    </div>
  )
}

function ClusterBadge({ name }) {
  if (!name || name === 'default') return <span className="hcell-dim">—</span>
  return <span className="prom-cluster-badge">{name}</span>
}

export default function PrometheusPodsTable({ pods, loading }) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const visible = q
    ? pods.filter(p =>
        p.pod.includes(q) ||
        p.namespace.includes(q) ||
        (p.cluster ?? '').includes(q)
      )
    : pods

  if (loading) return <div className="page-loading" style={{ marginTop: 16 }}>Loading Prometheus metrics…</div>

  if (!pods.length) return (
    <div className="alerts-empty" style={{ marginTop: 16 }}>
      <span style={{ fontSize: 24 }}>📊</span>
      <span>No pod metrics found in Prometheus</span>
    </div>
  )

  return (
    <div className="prom-pods-section">
      <div className="prom-pods-search-row">
        <div className="prom-pods-search-wrap">
          <span className="health-search-icon">⌕</span>
          <input className="health-search" placeholder="Filter by pod, namespace or cluster…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button className="health-search-clear" onClick={() => setSearch('')}>✕</button>}
        </div>
      </div>

      <div className="prom-pods-table-wrap">
        <table className="prom-pods-table">
          <thead>
            <tr>
              <th>Cluster</th>
              <th>Namespace</th>
              <th>Pod</th>
              <th>CPU (cores)</th>
              <th>Memory</th>
              <th>Restarts</th>
              <th>OOM</th>
              <th>Issues</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(p => (
              <tr key={p.key} className={`prom-pod-row${p.errorTypes.length > 0 ? ' prom-pod-row-err' : ''}`}>
                <td data-label="Cluster"><ClusterBadge name={p.cluster} /></td>
                <td data-label="Namespace"><span className="ns-tag">{p.namespace}</span></td>
                <td data-label="Pod" className="prom-pod-name mono-small" title={p.pod}>
                  {p.pod.length > 42 ? p.pod.slice(0, 40) + '…' : p.pod}
                </td>
                <td data-label="CPU (cores)"><CpuBar cores={p.cpuCores} /></td>
                <td data-label="Memory">
                  {p.memBytes != null
                    ? <span className="hcell-mono">{fmtBytes(p.memBytes)}</span>
                    : <span className="hcell-dim">—</span>}
                </td>
                <td data-label="Restarts"><RestartCount n={p.restarts ?? 0} /></td>
                <td data-label="OOM"><OomBadge oomKilled={p.oomKilled} /></td>
                <td data-label="Issues"><ErrorTypeBadges types={p.errorTypes} /></td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={8} className="nc-history-empty">No pods match "{search}"</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

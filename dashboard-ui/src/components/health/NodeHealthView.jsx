import { useState } from 'react'

const NODE_COND_LABEL = {
  MemoryPressure:    { label: 'Mem Pressure',  cls: 'nc-cond-warn'   },
  DiskPressure:      { label: 'Disk Pressure', cls: 'nc-cond-warn'   },
  PIDPressure:       { label: 'PID Pressure',  cls: 'nc-cond-warn'   },
  NetworkUnavailable:{ label: 'Net Unavail',   cls: 'nc-cond-danger' },
}

function ConditionTags({ conditions }) {
  const tags = []
  for (const [k, active] of Object.entries(conditions ?? {})) {
    if (k === 'Ready' || !active) continue
    const c = NODE_COND_LABEL[k] ?? { label: k, cls: 'nc-cond-warn' }
    tags.push(<span key={k} className={`nc-cond-tag ${c.cls}`}>{c.label}</span>)
  }
  return tags.length ? <div className="nc-cond-wrap">{tags}</div> : <span className="hcell-dim">—</span>
}

function PctBar({ pct, warnAt = 70, dangerAt = 90 }) {
  if (pct == null) return <span className="hcell-dim">—</span>
  const cls = pct >= dangerAt ? 'mf-danger' : pct >= warnAt ? 'mf-warn' : 'mf-ok'
  return (
    <div className="nh-pct-wrap">
      <div className="mbar-track nh-pct-track">
        <div className={`mbar-fill ${cls}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={`nh-pct-val${pct >= dangerAt ? ' pct-danger' : pct >= warnAt ? ' pct-warn' : ''}`}>{pct}%</span>
    </div>
  )
}

export default function NodeHealthView({ nodeClusters, loading }) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()

  if (loading) return <div className="page-loading" style={{ marginTop: 16 }}>Loading node data…</div>
  if (!nodeClusters?.length) return (
    <div className="alerts-empty"><span style={{ fontSize: 28 }}>🖥</span><span>No node data available</span></div>
  )

  return (
    <div className="nh-section">
      <div className="prom-pods-header" style={{ marginBottom: 12 }}>
        <div className="prom-pods-title">
          Node Health
          {nodeClusters.map(c => (
            <span key={c.clusterName} className="prom-pods-count">
              {c.clusterName}: {c.nodes.length} nodes
            </span>
          ))}
        </div>
        <div className="prom-pods-search-wrap">
          <span className="health-search-icon">⌕</span>
          <input className="health-search" placeholder="Filter nodes…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button className="health-search-clear" onClick={() => setSearch('')}>✕</button>}
        </div>
      </div>

      {nodeClusters.map(cluster => {
        const visible       = q ? cluster.nodes.filter(n => n.name.includes(q)) : cluster.nodes
        const notReadyCount = visible.filter(n => !n.isReady).length
        const issueCount    = visible.filter(n => n.issues?.length > 0).length
        if (!cluster.connected) return (
          <div key={cluster.clusterName} className="health-error">⚠ {cluster.clusterName}: {cluster.error}</div>
        )
        return (
          <div key={cluster.clusterName} className="nh-cluster-block">
            <div className="nh-cluster-header">
              <span className="hc-name">{cluster.clusterName}</span>
              <span className={`tier-badge tier-${cluster.tier}`}>{cluster.tier}</span>
              {notReadyCount > 0 && <span className="prom-pods-errbadge">{notReadyCount} NotReady</span>}
              {issueCount    > 0 && <span className="prom-pods-oombadge">{issueCount} with issues</span>}
            </div>
            <div className="prom-pods-table-wrap">
              <table className="prom-pods-table">
                <thead>
                  <tr>
                    <th>Node</th><th>Status</th><th>Role</th>
                    <th>CPU</th><th>Memory</th><th>Disk</th>
                    <th>Conditions</th><th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(node => (
                    <tr key={node.name} className={`prom-pod-row${node.issues?.length > 0 ? ' prom-pod-row-err' : ''}`}>
                      <td className="prom-pod-name mono-small" title={node.name}>
                        {node.name.length > 38 ? node.name.slice(0, 36) + '…' : node.name}
                      </td>
                      <td>
                        {node.isReady
                          ? <span className="phase-b pb-running">Ready</span>
                          : <span className="phase-b pb-failed">NotReady</span>}
                      </td>
                      <td>
                        {node.isControlPlane
                          ? <span className="nc-role-cp">control-plane</span>
                          : <span className="hcell-dim">worker</span>}
                      </td>
                      <td><PctBar pct={node.cpuUsagePct} warnAt={70} dangerAt={90} /></td>
                      <td><PctBar pct={node.memUsedPct}  warnAt={75} dangerAt={90} /></td>
                      <td><PctBar pct={node.diskUsedPct} warnAt={80} dangerAt={95} /></td>
                      <td><ConditionTags conditions={node.conditions} /></td>
                      <td>
                        {node.issues?.length
                          ? <div className="prom-err-types">{node.issues.map((iss, i) => (
                              <span key={i} className="prom-err-badge">{iss.type.replace('Node','')}</span>
                            ))}</div>
                          : <span className="prom-ok">✓</span>}
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={8} className="nc-history-empty">No nodes match "{search}"</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

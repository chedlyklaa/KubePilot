import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../lib/api'
import FilterDrawer, { FilterSection, FilterChips } from '../components/FilterDrawer'

const REFRESH_INTERVAL = 10

const PHASE_OPTS = [
  { value: 'Running',   label: 'Running'   },
  { value: 'Degraded',  label: 'Degraded'  },
  { value: 'Pending',   label: 'Pending'   },
  { value: 'Failed',    label: 'Failed'    },
  { value: 'Succeeded', label: 'Succeeded' },
]
const EMPTY_FILTERS = { phases: [], namespaces: [], clusters: [], hasRestarts: false, hasGpu: false }

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b == null) return null
  if (b < 1024)      return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} Ki`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(0)} Mi`
  return                    `${(b / 1024 ** 3).toFixed(2)} Gi`
}

function fmtAge(t) {
  if (!t) return '—'
  const s = Math.floor((Date.now() - new Date(t)) / 1000)
  if (s < 60)    return `${s}s`
  if (s < 3600)  return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return                `${Math.floor(s / 86400)}d`
}

function effectivePhase(pod) {
  return pod.phase === 'Running' && !pod.isReady ? 'Degraded' : pod.phase
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ phase, isReady }) {
  const ep = phase === 'Running' && !isReady ? 'Degraded' : phase
  const cls = {
    Running: 'sdot-running', Degraded: 'sdot-degraded', Pending: 'sdot-pending',
    Failed: 'sdot-failed', Succeeded: 'sdot-succeeded',
  }[ep] ?? 'sdot-unknown'
  return <span className={`status-dot ${cls}`} title={ep} />
}

function PhaseBadge({ phase, isReady }) {
  const ep  = phase === 'Running' && !isReady ? 'Degraded' : phase
  const cls = { Running:'pb-running', Degraded:'pb-degraded', Pending:'pb-pending',
                Failed:'pb-failed', Succeeded:'pb-succeeded' }[ep] ?? 'pb-unknown'
  return <span className={`phase-b ${cls}`}>{ep}</span>
}

function MemBar({ usedBytes, limitBytes, rawLabel }) {
  if (!usedBytes && !rawLabel) return <span className="hcell-dim">—</span>
  if (!limitBytes || !usedBytes)
    return <span className="hcell-mono">{rawLabel ?? fmtBytes(usedBytes)}</span>
  const pct = Math.min(100, (usedBytes / limitBytes) * 100)
  const cls = pct > 85 ? 'mf-danger' : pct > 65 ? 'mf-warn' : 'mf-ok'
  return (
    <div className="mbar">
      <div className="mbar-track"><div className={`mbar-fill ${cls}`} style={{ width: `${pct.toFixed(0)}%` }} /></div>
      <div className="mbar-labels">
        <span>{rawLabel}</span>
        <span className="mbar-pct">{pct.toFixed(0)}%</span>
        <span className="mbar-limit">/ {fmtBytes(limitBytes)}</span>
      </div>
    </div>
  )
}

function RestartCount({ n }) {
  if (n === 0) return <span className="hcell-dim">—</span>
  const cls = n > 15 ? 'rc-high' : n > 5 ? 'rc-med' : 'rc-low'
  return <span className={`rc ${cls}`}>{n}</span>
}

function ClusterStats({ pods }) {
  const counts = { running: 0, degraded: 0, pending: 0, failed: 0 }
  for (const p of pods) {
    const ep = effectivePhase(p)
    if (ep === 'Running')   counts.running++
    else if (ep === 'Degraded') counts.degraded++
    else if (ep === 'Pending')  counts.pending++
    else if (ep === 'Failed')   counts.failed++
  }
  return (
    <div className="cstats">
      <span className="cstat cstat-run"><span className="cstat-dot" />  {counts.running} running</span>
      {counts.degraded > 0 && <span className="cstat cstat-deg"><span className="cstat-dot" /> {counts.degraded} degraded</span>}
      {counts.pending  > 0 && <span className="cstat cstat-pnd"><span className="cstat-dot" /> {counts.pending} pending</span>}
      {counts.failed   > 0 && <span className="cstat cstat-fail"><span className="cstat-dot" /> {counts.failed} failed</span>}
    </div>
  )
}

function MetricsNotice({ onDismiss }) {
  return (
    <div className="metrics-notice">
      <div className="metrics-notice-icon">⚡</div>
      <div className="metrics-notice-body">
        <strong>Live metrics unavailable</strong>
        <p>
          CPU &amp; memory usage requires the <strong>Metrics Server</strong> add-on.
          Without it, only spec limits from pod YAML are shown — not live consumption.
        </p>
        <div className="metrics-notice-cmds">
          <span className="mncmd-label">Minikube:</span>
          <code className="mncmd">minikube addons enable metrics-server</code>
          <span className="mncmd-label" style={{ marginLeft: 16 }}>Managed clusters (AKS/EKS/GKE):</span>
          <code className="mncmd">kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml</code>
        </div>
      </div>
      <button className="metrics-notice-close" onClick={onDismiss} title="Dismiss">✕</button>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ClusterHealthPage() {
  const [data,          setData]          = useState(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [countdown,     setCountdown]     = useState(REFRESH_INTERVAL)
  const [lastSync,      setLastSync]      = useState(null)
  const [search,        setSearch]        = useState('')
  const [filters,       setFilters]       = useState(EMPTY_FILTERS)
  const [drawerOpen,    setDrawerOpen]    = useState(false)
  const [noticeDismiss, setNoticeDismiss] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/cluster/pods')
      const json = await res.json()
      setData(json)
      setLastSync(new Date())
      setError(null)
    } catch (err) { setError(err.message) }
    finally { setLoading(false); setCountdown(REFRESH_INTERVAL) }
  }, [])

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, REFRESH_INTERVAL * 1000)
    return () => clearInterval(iv)
  }, [fetchData])

  useEffect(() => {
    const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(t)
  }, [])

  // derived
  const allPods       = useMemo(() => data?.clusters.flatMap(c => c.pods) ?? [], [data])
  const allNamespaces = useMemo(() => [...new Set(allPods.map(p => p.namespace))].sort(), [allPods])
  const allClusters   = useMemo(() => data?.clusters.map(c => c.name) ?? [], [data])
  const hasMetrics    = allPods.some(p => p.hasMetrics)
  const anyGpu        = allPods.some(p => p.totalGpu > 0)

  // summary counts
  const totals = useMemo(() => allPods.reduce((acc, p) => {
    const ep = effectivePhase(p)
    acc[ep] = (acc[ep] ?? 0) + 1
    return acc
  }, {}), [allPods])

  // filtering
  const q = search.trim().toLowerCase()
  function applyFilters(pods, clusterName) {
    return pods.filter(p => {
      if (q && ![p.name, p.namespace, p.node].some(s => s?.toLowerCase().includes(q))) return false
      if (filters.phases.length     > 0 && !filters.phases.includes(effectivePhase(p)))  return false
      if (filters.namespaces.length > 0 && !filters.namespaces.includes(p.namespace))    return false
      if (filters.clusters.length   > 0 && !filters.clusters.includes(clusterName))      return false
      if (filters.hasRestarts && p.restarts  === 0) return false
      if (filters.hasGpu      && p.totalGpu === 0)  return false
      return true
    })
  }

  const filtered = useMemo(() =>
    data?.clusters.map(c => ({ ...c, visible: applyFilters(c.pods, c.name) })) ?? [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data, q, filters])

  const totalVisible = filtered.reduce((s, c) => s + c.visible.length, 0)
  const totalPods    = allPods.length
  const hasActive    = q.length > 0 || Object.values(filters).some(v => Array.isArray(v) ? v.length > 0 : v)

  const activeCount =
    (filters.phases.length     > 0 ? 1 : 0) +
    (filters.namespaces.length > 0 ? 1 : 0) +
    (filters.clusters.length   > 0 ? 1 : 0) +
    (filters.hasRestarts ? 1 : 0) + (filters.hasGpu ? 1 : 0)

  const toggle = key => val =>
    setFilters(f => ({ ...f, [key]: f[key].includes(val) ? f[key].filter(x => x !== val) : [...f[key], val] }))

  return (
    <div className="health-page">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h2>Cluster Health</h2>
          <p className="page-subtitle">Live pod state · resource usage · GPU allocation</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {lastSync && <span className="hcell-dim" style={{ fontSize: 11 }}>synced {lastSync.toLocaleTimeString()}</span>}
          <div className={`refresh-ring ${countdown <= 3 ? 'ring-imminent' : ''}`} title={`Next refresh in ${countdown}s`}>
            <svg viewBox="0 0 36 36" className="ring-svg">
              <circle cx="18" cy="18" r="15" className="ring-track" />
              <circle cx="18" cy="18" r="15" className="ring-progress"
                strokeDasharray={`${(countdown / REFRESH_INTERVAL) * 94} 94`} />
            </svg>
            <span className="ring-label">{countdown}s</span>
          </div>
          <button className="btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }}
            onClick={() => { setLoading(true); fetchData() }}>↻ Refresh</button>
        </div>
      </div>

      {/* ── Status summary bar ── */}
      {data && (
        <div className="h-summary-bar">
          {[
            ['Running',   'ss-run',  totals['Running']],
            ['Degraded',  'ss-deg',  totals['Degraded']],
            ['Pending',   'ss-pnd',  totals['Pending']],
            ['Failed',    'ss-fail', totals['Failed']],
            ['Succeeded', 'ss-done', totals['Succeeded']],
          ].filter(([,,n]) => n > 0).map(([label, cls, n]) => (
            <div key={label} className={`ss-card ${cls}`}>
              <span className="ss-num">{n}</span>
              <span className="ss-label">{label}</span>
            </div>
          ))}
          <div className="ss-card ss-total">
            <span className="ss-num">{totalPods}</span>
            <span className="ss-label">Total pods</span>
          </div>
        </div>
      )}

      {/* ── Metrics notice ── */}
      {data && !hasMetrics && !noticeDismiss && (
        <MetricsNotice onDismiss={() => setNoticeDismiss(true)} />
      )}

      {/* ── Search + filter toolbar ── */}
      {data && (
        <div className="health-toolbar">
          {hasActive && <span className="esc-match-count">{totalVisible} / {totalPods} pods</span>}
          {hasActive && (
            <button className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={() => { setSearch(''); setFilters(EMPTY_FILTERS) }}>✕ Clear</button>
          )}
          <div className="health-toolbar-right">
            <div className="health-search-wrap">
              <span className="health-search-icon">⌕</span>
              <input className="health-search" placeholder="Search pod name, namespace, node…"
                value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button className="health-search-clear" onClick={() => setSearch('')}>✕</button>}
            </div>
            <button className={`btn-filter${activeCount > 0 ? ' has-filters' : ''}`}
              onClick={() => setDrawerOpen(true)}>
              ⚙ Filters {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
            </button>
          </div>
        </div>
      )}

      {/* ── Filter drawer ── */}
      <FilterDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}
        count={activeCount} onClear={() => setFilters(EMPTY_FILTERS)}>
        <FilterSection label="Status">
          <FilterChips options={PHASE_OPTS} selected={filters.phases} onToggle={toggle('phases')} colorClass />
        </FilterSection>
        {allNamespaces.length > 1 && (
          <FilterSection label="Namespace">
            <div className="filter-check-list">
              {allNamespaces.map(ns => (
                <label key={ns} className="filter-check-item">
                  <input type="checkbox" checked={filters.namespaces.includes(ns)}
                    onChange={() => toggle('namespaces')(ns)} />
                  <span className="mono-small">{ns}</span>
                </label>
              ))}
            </div>
          </FilterSection>
        )}
        {allClusters.length > 1 && (
          <FilterSection label="Cluster">
            <div className="filter-check-list">
              {allClusters.map(cl => (
                <label key={cl} className="filter-check-item">
                  <input type="checkbox" checked={filters.clusters.includes(cl)}
                    onChange={() => toggle('clusters')(cl)} />
                  {cl}
                </label>
              ))}
            </div>
          </FilterSection>
        )}
        <FilterSection label="Quick filters">
          <div className="filter-chips">
            <button className={`filter-chip-item${filters.hasRestarts ? ' active' : ''}`}
              onClick={() => setFilters(f => ({ ...f, hasRestarts: !f.hasRestarts }))}>↺ Has restarts</button>
            {anyGpu && (
              <button className={`filter-chip-item${filters.hasGpu ? ' active' : ''}`}
                onClick={() => setFilters(f => ({ ...f, hasGpu: !f.hasGpu }))}>⬡ Has GPU</button>
            )}
          </div>
        </FilterSection>
      </FilterDrawer>

      {/* ── Loading / error ── */}
      {loading && <div className="page-loading">Loading cluster data…</div>}
      {error   && <div className="health-error">⚠ {error}</div>}

      {/* ── Cluster tables ── */}
      {filtered.map(cluster => (
        <div key={cluster.name} className="hc-block">

          {/* Cluster header */}
          <div className="hc-header">
            <div className="hc-header-left">
              <span className={`cluster-dot ${cluster.connected ? 'dot-ok' : 'dot-err'}`} />
              <span className="hc-name">{cluster.name}</span>
              <span className={`tier-badge tier-${cluster.tier}`}>{cluster.tier}</span>
              <span className="hcell-dim hc-ctx">{cluster.context}</span>
              {!cluster.connected && <span className="hc-err">{cluster.error}</span>}
            </div>
            <div className="hc-header-right">
              {hasActive
                ? <span className="hcell-dim">{cluster.visible.length} / {cluster.pods.length} pods</span>
                : <ClusterStats pods={cluster.pods} />
              }
            </div>
          </div>

          {/* Empty states */}
          {cluster.visible.length === 0 && cluster.connected && (
            <div className="hc-empty">
              {hasActive ? '⊘ No pods match the current search or filters'
                         : 'No pods in monitored namespaces'}
            </div>
          )}

          {/* Pod table */}
          {cluster.visible.length > 0 && (
            <div className="hc-table-wrap">
              <table className="hc-table">
                <thead>
                  <tr>
                    <th className="hth">Pod</th>
                    <th className="hth">Namespace</th>
                    <th className="hth">Status</th>
                    <th className="hth hth-center">Ready</th>
                    <th className="hth hth-center">Restarts</th>
                    <th className="hth">CPU</th>
                    <th className="hth" style={{ minWidth: 180 }}>Memory</th>
                    {cluster.pods.some(p => p.totalGpu > 0) && <th className="hth hth-center">GPU</th>}
                    <th className="hth">Node</th>
                    <th className="hth">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {cluster.visible.map(pod => {
                    const hasGpuCol = cluster.pods.some(p => p.totalGpu > 0)
                    const ep = effectivePhase(pod)
                    return (
                      <tr key={`${pod.namespace}/${pod.name}`} className={`htr htr-${ep.toLowerCase()}`}>

                        <td className="htd htd-pod">
                          <StatusDot phase={pod.phase} isReady={pod.isReady} />
                          <div className="pod-name-col">
                            <span className="pod-name mono-small" title={pod.name}>
                              {pod.name.length > 34 ? pod.name.slice(0, 32) + '…' : pod.name}
                            </span>
                            {pod.containers.some(c => c.reason) && (
                              <span className="pod-reason-tag">
                                {pod.containers.find(c => c.reason)?.reason}
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="htd">
                          <span className="ns-tag">{pod.namespace}</span>
                        </td>

                        <td className="htd">
                          <PhaseBadge phase={pod.phase} isReady={pod.isReady} />
                        </td>

                        <td className="htd htd-center">
                          <span className={pod.isReady ? 'ready-ok' : 'ready-no'}>{pod.ready}</span>
                        </td>

                        <td className="htd htd-center">
                          <RestartCount n={pod.restarts} />
                        </td>

                        <td className="htd">
                          {pod.cpuRaw
                            ? <span className="hcell-mono cpu-val">{pod.cpuRaw}</span>
                            : <span className="hcell-dim">—</span>}
                        </td>

                        <td className="htd">
                          <MemBar usedBytes={pod.memBytes} limitBytes={pod.totalMemLimitBytes} rawLabel={pod.memRaw} />
                        </td>

                        {hasGpuCol && (
                          <td className="htd htd-center">
                            {pod.totalGpu > 0
                              ? <span className="gpu-tag">⬡ {pod.totalGpu}</span>
                              : <span className="hcell-dim">—</span>}
                          </td>
                        )}

                        <td className="htd hcell-dim mono-small">{pod.node}</td>
                        <td className="htd hcell-dim age-cell">{fmtAge(pod.startTime)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useFilters } from '../hooks/useFilters'
import { fmtBytes, RestartCount } from '../components/health/atoms'
import ClusterManager from '../components/health/ClusterManager'
import CollapsibleSection from '../components/health/CollapsibleSection'
import AlertsTable from '../components/health/AlertsTable'
import NodeHealthView from '../components/health/NodeHealthView'
import PrometheusPodsTable from '../components/health/PrometheusPodsTable'
import AutoscalingPage from './AutoscalingPage'
import ExtensionsPage from './ExtensionsPage'

const ERRORS_REFRESH_MS  = 30_000
const METRICS_REFRESH_MS = 30_000
const NODES_REFRESH_MS   = 30_000
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

function PrometheusNotice({ onDismiss }) {
  return (
    <div className="metrics-notice metrics-notice-prom">
      <div className="metrics-notice-icon">📊</div>
      <div className="metrics-notice-body">
        <strong>Metrics from Prometheus</strong>
        <p>
          Metrics Server is not available — CPU &amp; memory values are sourced from{' '}
          <strong>Prometheus</strong> (5-minute averages). Values marked <code>~</code> are
          averages, not instantaneous readings.
        </p>
      </div>
      <button className="metrics-notice-close" onClick={onDismiss} title="Dismiss">✕</button>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ClusterHealthPage() {
  const [data,              setData]              = useState(null)
  const [loading,           setLoading]           = useState(true)
  const [error,             setError]             = useState(null)
  const [countdown,         setCountdown]         = useState(REFRESH_INTERVAL)
  const [lastSync,          setLastSync]          = useState(null)
  const [search,            setSearch]            = useState('')
  const { filters, setFilters, toggle, activeCount } = useFilters(EMPTY_FILTERS)
  const [drawerOpen,        setDrawerOpen]        = useState(false)
  const [noticeDismiss,     setNoticeDismiss]     = useState(false)
  const [promNoticeDismiss, setPromNoticeDismiss] = useState(false)
  const [errors,            setErrors]            = useState([])
  const [promPods,          setPromPods]          = useState([])
  const [promPodsLoading,   setPromPodsLoading]   = useState(false)
  const [nodeClusters,      setNodeClusters]      = useState([])
  const [nodesLoading,      setNodesLoading]      = useState(false)
  const [activeView,        setActiveView]        = useState('pods')
  const [expandedClusters,  setExpandedClusters]  = useState({})
  const [showClusterMgr,    setShowClusterMgr]    = useState(false)
  const { user } = useAuth()

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

  // Fetch Prometheus error alerts + all-pods metrics — only while the Alerts tab is
  // active. (Pod polling above stays unconditional: it feeds the status summary bar,
  // which is visible on every tab, not just the Pods view.)
  useEffect(() => {
    if (activeView !== 'alerts') return
    const fetchErrors = async () => {
      try {
        const res = await apiFetch('/api/metrics/errors')
        const json = await res.json()
        setErrors(json.errors ?? [])
      } catch { /* Prometheus unavailable — silently skip */ }
    }
    fetchErrors()
    const iv = setInterval(fetchErrors, ERRORS_REFRESH_MS)
    return () => clearInterval(iv)
  }, [activeView])

  useEffect(() => {
    if (activeView !== 'alerts') return
    const fetchPromPods = async () => {
      setPromPodsLoading(true)
      try {
        const res  = await apiFetch('/api/metrics/pods')
        const json = await res.json()
        setPromPods(json.pods ?? [])
      } catch { /* Prometheus unavailable */ }
      finally { setPromPodsLoading(false) }
    }
    fetchPromPods()
    const iv = setInterval(fetchPromPods, METRICS_REFRESH_MS)
    return () => clearInterval(iv)
  }, [activeView])

  // Fetch node health — only while the Nodes tab is active.
  useEffect(() => {
    if (activeView !== 'nodes') return
    const fetchNodes = async () => {
      setNodesLoading(true)
      try {
        const res  = await apiFetch('/api/nodes')
        const json = await res.json()
        setNodeClusters(Array.isArray(json) ? json : [])
      } catch { /* kubectl unavailable */ }
      finally { setNodesLoading(false) }
    }
    fetchNodes()
    const iv = setInterval(fetchNodes, NODES_REFRESH_MS)
    return () => clearInterval(iv)
  }, [activeView])

  // derived
  const allPods       = useMemo(() => data?.clusters.flatMap(c => c.pods) ?? [], [data])
  const allNamespaces = useMemo(() => [...new Set(allPods.map(p => p.namespace))].sort(), [allPods])
  const allClusters   = useMemo(() => data?.clusters.map(c => c.name) ?? [], [data])
  const hasMetrics          = allPods.some(p => p.hasMetrics)
  const hasPrometheusMetrics = allPods.some(p => p.metricsSource === 'prometheus')
  const anyGpu              = allPods.some(p => p.totalGpu > 0)

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

  const toggleCluster = name =>
    setExpandedClusters(p => ({ ...p, [name]: !p[name] }))

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
          {user?.role === 'admin' && (
            <button className="btn-manage-clusters" onClick={() => setShowClusterMgr(true)}>
              ⚙ Manage Clusters
            </button>
          )}
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

      {/* ── View switcher tabs ── */}
      <div className="health-view-tabs">
        <button className={`hvtab${activeView === 'pods' ? ' hvtab-active' : ''}`}
          onClick={() => setActiveView('pods')}>
          Pod Status
          <span className="hvtab-count hvtab-count-neutral">{totalPods}</span>
        </button>
        <button className={`hvtab${activeView === 'alerts' ? ' hvtab-active' : ''}`}
          onClick={() => setActiveView('alerts')}>
          ⚠ Prometheus
          {errors.length > 0 && (
            <span className={`hvtab-count ${errors.some(e => e.severity === 'critical') ? 'hvtab-count-crit' : 'hvtab-count-warn'}`}>
              {errors.length}
            </span>
          )}
        </button>
        <button className={`hvtab${activeView === 'nodes' ? ' hvtab-active' : ''}`}
          onClick={() => setActiveView('nodes')}>
          🖥 Nodes
          {nodeClusters.some(c => c.nodes.some(n => !n.isReady)) && (
            <span className="hvtab-count hvtab-count-crit">!</span>
          )}
        </button>
        <button className={`hvtab${activeView === 'autoscaling' ? ' hvtab-active' : ''}`}
          onClick={() => setActiveView('autoscaling')}>
          📈 Autoscaling
        </button>
        <button className={`hvtab${activeView === 'extensions' ? ' hvtab-active' : ''}`}
          onClick={() => setActiveView('extensions')}>
          🧩 Extensions
        </button>
      </div>

      {/* ── Pods view ── */}
      {activeView === 'pods' && (<>

        {data && !hasMetrics && !noticeDismiss && (
          <MetricsNotice onDismiss={() => setNoticeDismiss(true)} />
        )}

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

        {loading && <div className="page-loading">Loading cluster data…</div>}
        {error   && <div className="health-error">⚠ {error}</div>}

        {filtered.map(cluster => {
          const isOpen = !!expandedClusters[cluster.name]
          return (
            <div key={cluster.name} className={`hc-block${isOpen ? ' hc-block-open' : ''}`}>

              {/* Clickable header — always visible */}
              <div
                className="hc-header hc-header-clickable"
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => toggleCluster(cluster.name)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCluster(cluster.name) } }}
              >
                <div className="hc-header-left">
                  <span className={`hc-chevron${isOpen ? ' hc-chevron-open' : ''}`}>▶</span>
                  <span
                    className={`cluster-dot ${cluster.connected ? 'dot-ok' : 'dot-err'}`}
                    aria-label={cluster.connected ? 'Connected' : 'Disconnected'}
                    role="img"
                  />
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

              {/* Collapsible body */}
              {isOpen && (<>
                {cluster.visible.length === 0 && cluster.connected && (
                  <div className="hc-empty">
                    {hasActive ? '⊘ No pods match the current search or filters'
                               : 'No pods in monitored namespaces'}
                  </div>
                )}

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
                              <td className="htd"><span className="ns-tag">{pod.namespace}</span></td>
                              <td className="htd"><PhaseBadge phase={pod.phase} isReady={pod.isReady} /></td>
                              <td className="htd htd-center">
                                <span className={pod.isReady ? 'ready-ok' : 'ready-no'}>{pod.ready}</span>
                              </td>
                              <td className="htd htd-center"><RestartCount n={pod.restarts} /></td>
                              <td className="htd">
                                {pod.cpuRaw
                                  ? <span className="hcell-mono cpu-val" title={pod.metricsSource === 'prometheus' ? '5-min avg from Prometheus' : 'kubectl top'}>
                                      {pod.cpuRaw}{pod.metricsSource === 'prometheus' ? <span className="prom-tilde">~</span> : null}
                                    </span>
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
              </>)}
            </div>
          )
        })}
      </>)}

      {/* ── Cluster Manager modal ── */}
      {showClusterMgr && (
        <ClusterManager
          onClose={() => setShowClusterMgr(false)}
          onSaved={() => fetchData()}
        />
      )}

      {/* ── Alerts view ── */}
      {activeView === 'alerts' && (
        <>
          {data && hasPrometheusMetrics && !promNoticeDismiss && (
            <PrometheusNotice onDismiss={() => setPromNoticeDismiss(true)} />
          )}
          {errors.length > 0 && (
            <CollapsibleSection
              title="Issues Detected"
              badges={<>
                {errors.filter(e => e.severity === 'critical').length > 0 && (
                  <span className="ep-badge ep-crit">
                    🔴 {errors.filter(e => e.severity === 'critical').length} critical
                  </span>
                )}
                {errors.filter(e => e.severity === 'high').length > 0 && (
                  <span className="ep-badge ep-high">
                    🟠 {errors.filter(e => e.severity === 'high').length} high
                  </span>
                )}
                <span className="ep-badge ep-total">{errors.length} total</span>
              </>}
            >
              <AlertsTable errors={errors} />
            </CollapsibleSection>
          )}
          <CollapsibleSection
            title="All Pods — Prometheus Metrics"
            badges={<>
              <span className="prom-pods-count">{promPods.length} pods</span>
              {promPods.filter(p => p.errorTypes.length > 0).length > 0 && (
                <span className="prom-pods-errbadge">
                  {promPods.filter(p => p.errorTypes.length > 0).length} with issues
                </span>
              )}
              {promPods.filter(p => p.oomKilled).length > 0 && (
                <span className="prom-pods-oombadge">
                  {promPods.filter(p => p.oomKilled).length} OOM
                </span>
              )}
            </>}
          >
            <PrometheusPodsTable pods={promPods} loading={promPodsLoading} />
          </CollapsibleSection>
        </>
      )}

      {/* ── Nodes view ── */}
      {activeView === 'nodes' && (
        <NodeHealthView nodeClusters={nodeClusters} loading={nodesLoading} />
      )}

      {/* ── Autoscaling / Extensions views — full pages embedded as tabs, each owns its
          own cluster selector and data fetching (only fetches while its tab is active) ── */}
      {activeView === 'autoscaling' && <AutoscalingPage embedded />}
      {activeView === 'extensions'  && <ExtensionsPage embedded />}

    </div>
  )
}

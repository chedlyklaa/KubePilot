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

const REFRESH_OPTIONS = [
  { label: 'Off', seconds: 0 },
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '1m',  seconds: 60 },
  { label: '5m',  seconds: 300 },
]

const PHASE_OPTS = [
  { value: 'Running',   label: 'Running'   },
  { value: 'Degraded',  label: 'Degraded'  },
  { value: 'Pending',   label: 'Pending'   },
  { value: 'Failed',    label: 'Failed'    },
  { value: 'Succeeded', label: 'Succeeded' },
]
const EMPTY_FILTERS = { phases: [], hasRestarts: false, hasGpu: false }

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

function PodTable({ pods }) {
  const hasGpuCol = pods.some(p => p.totalGpu > 0)
  return (
    <div className="hc-table-wrap">
      <table className="hc-table">
        <thead>
          <tr>
            <th className="hth">Pod</th>
            <th className="hth">Status</th>
            <th className="hth hth-center">Ready</th>
            <th className="hth hth-center">Restarts</th>
            <th className="hth">CPU</th>
            <th className="hth" style={{ minWidth: 180 }}>Memory</th>
            {hasGpuCol && <th className="hth hth-center">GPU</th>}
            <th className="hth">Node</th>
            <th className="hth">Age</th>
          </tr>
        </thead>
        <tbody>
          {pods.map(pod => {
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
  const [refreshSeconds,    setRefreshSeconds]    = useState(0) // 0 = auto-refresh off by default
  const [countdown,         setCountdown]         = useState(refreshSeconds)
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
  const [expandedNs,        setExpandedNs]        = useState({}) // key: "cluster/namespace"
  const [showClusterMgr,    setShowClusterMgr]    = useState(false)
  const { user } = useAuth()

  // Streams each cluster's namespace list (NDJSON over a plain fetch) instead of
  // waiting for every cluster to respond — a slow/unreachable cluster no longer
  // blocks the ones that are already ready from showing up. Pods are NOT fetched
  // here: namespaces are cheap to list, so they load eagerly, but pods are the
  // expensive part and only load once a namespace is actually expanded — see
  // loadNamespacePods below. On refresh, previously loaded namespace pod data is
  // preserved (keyed by name) rather than being wiped back to a skeleton.
  const fetchData = useCallback(async () => {
    setError(null)
    try {
      const res = await apiFetch('/api/cluster/namespaces/stream')
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`)

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          const msg = JSON.parse(line)

          if (msg.type === 'init') {
            setData(prev => {
              const prevByName = new Map((prev?.clusters ?? []).map(c => [c.name, c]))
              return {
                clusters: msg.clusters.map(c => {
                  const old = prevByName.get(c.name)
                  return old ? { ...old, loading: true } : { ...c, connected: null, namespaces: [], loading: true }
                }),
              }
            })
            setLoading(false)
          } else if (msg.type === 'cluster') {
            setData(prev => prev && {
              ...prev,
              clusters: prev.clusters.map(c => {
                if (c.name !== msg.cluster.name) return c
                const prevNsByName = new Map((c.namespaces ?? []).map(n => [n.name, n]))
                return {
                  ...msg.cluster,
                  loading: false,
                  namespaces: (msg.cluster.namespaces ?? []).map(name => {
                    const old = prevNsByName.get(name)
                    return old ?? { name, pods: null, loading: false, loaded: false, error: null }
                  }),
                }
              }),
            })
          } else if (msg.type === 'done') {
            setLastSync(new Date())
          }
        }
      }
    } catch (err) { setError(err.message) }
    finally { setLoading(false); setCountdown(refreshSeconds) }
  }, [refreshSeconds])

  // Fetches pods for a single namespace — only called when that namespace's row is
  // expanded for the first time. This is the actual "expensive" call; everything
  // above (cluster list, namespace list) is metadata-only and loads eagerly.
  const loadNamespacePods = useCallback(async (clusterName, ns) => {
    const setNs = updater => setData(prev => prev && {
      ...prev,
      clusters: prev.clusters.map(c => c.name !== clusterName ? c : {
        ...c,
        namespaces: c.namespaces.map(n => n.name === ns ? updater(n) : n),
      }),
    })

    setNs(n => ({ ...n, loading: true, error: null }))
    try {
      const res  = await apiFetch(`/api/cluster/${encodeURIComponent(clusterName)}/namespaces/${encodeURIComponent(ns)}/pods`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
      setNs(() => ({ name: ns, pods: json.pods ?? [], loading: false, loaded: true, error: null }))
    } catch (err) {
      setNs(n => ({ ...n, loading: false, error: err.message }))
    }
  }, [])

  const toggleNamespace = (clusterName, ns) => {
    const key = `${clusterName}/${ns}`
    setExpandedNs(prev => {
      const nowOpen = !prev[key]
      if (nowOpen) {
        const nsObj = data?.clusters.find(c => c.name === clusterName)?.namespaces.find(n => n.name === ns)
        if (nsObj && !nsObj.loaded && !nsObj.loading) loadNamespacePods(clusterName, ns)
      }
      return { ...prev, [key]: nowOpen }
    })
  }

  useEffect(() => {
    fetchData()
    if (refreshSeconds <= 0) return
    const iv = setInterval(fetchData, refreshSeconds * 1000)
    return () => clearInterval(iv)
  }, [fetchData, refreshSeconds])

  useEffect(() => {
    if (refreshSeconds <= 0) return
    const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(t)
  }, [refreshSeconds])

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

  // derived — pods are only known for namespaces that have actually been opened
  // (see loadNamespacePods), so nothing here can claim to represent cluster- or
  // fleet-wide totals; it only reflects whatever's been loaded so far.
  const loadedPods = useMemo(
    () => data?.clusters.flatMap(c => c.namespaces?.flatMap(n => n.pods ?? []) ?? []) ?? [],
    [data]
  )
  const hasMetrics           = loadedPods.some(p => p.hasMetrics)
  const hasPrometheusMetrics = loadedPods.some(p => p.metricsSource === 'prometheus')
  const anyGpu               = loadedPods.some(p => p.totalGpu > 0)

  // filtering — applies within a single already-loaded namespace's pod list
  const q = search.trim().toLowerCase()
  function applyFilters(pods) {
    return pods.filter(p => {
      if (q && ![p.name, p.namespace, p.node].some(s => s?.toLowerCase().includes(q))) return false
      if (filters.phases.length > 0 && !filters.phases.includes(effectivePhase(p)))     return false
      if (filters.hasRestarts && p.restarts  === 0) return false
      if (filters.hasGpu      && p.totalGpu === 0)  return false
      return true
    })
  }
  const hasActive = q.length > 0 || filters.phases.length > 0 || filters.hasRestarts || filters.hasGpu

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
          {refreshSeconds > 0 && (
            <div className={`refresh-ring ${countdown <= 3 ? 'ring-imminent' : ''}`} title={`Next refresh in ${countdown}s`}>
              <svg viewBox="0 0 36 36" className="ring-svg">
                <circle cx="18" cy="18" r="15" className="ring-track" />
                <circle cx="18" cy="18" r="15" className="ring-progress"
                  strokeDasharray={`${(countdown / refreshSeconds) * 94} 94`} />
              </svg>
              <span className="ring-label">{countdown}s</span>
            </div>
          )}
          <select
            className="refresh-interval-select"
            value={refreshSeconds}
            title="Auto-refresh interval"
            onChange={e => setRefreshSeconds(Number(e.target.value))}
          >
            {REFRESH_OPTIONS.map(o => (
              <option key={o.seconds} value={o.seconds}>
                {o.seconds === 0 ? 'Auto-refresh: Off' : `Auto-refresh: ${o.label}`}
              </option>
            ))}
          </select>
          {user?.role === 'admin' && (
            <button className="btn-manage-clusters" onClick={() => setShowClusterMgr(true)}>
              ⚙ Manage Clusters
            </button>
          )}
          <button className="btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }}
            onClick={() => { setLoading(true); fetchData() }}>↻ Refresh</button>
        </div>
      </div>

      {/* ── View switcher tabs ── */}
      <div className="health-view-tabs">
        <button className={`hvtab${activeView === 'pods' ? ' hvtab-active' : ''}`}
          onClick={() => setActiveView('pods')}>
          Pod Status
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

        {loadedPods.length > 0 && !hasMetrics && !noticeDismiss && (
          <MetricsNotice onDismiss={() => setNoticeDismiss(true)} />
        )}

        {data && (
          <div className="health-toolbar">
            {hasActive && (
              <button className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={() => { setSearch(''); setFilters(EMPTY_FILTERS) }}>✕ Clear</button>
            )}
            <div className="health-toolbar-right">
              <div className="health-search-wrap">
                <span className="health-search-icon">⌕</span>
                <input className="health-search" placeholder="Search pod name, node…"
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

        {(data?.clusters ?? []).map(cluster => {
          const isOpen    = !!expandedClusters[cluster.name]
          const isPending = cluster.connected == null // namespace stream hasn't reported this cluster yet
          return (
            <div key={cluster.name}
              className={`hc-block${isOpen ? ' hc-block-open' : ''}${cluster.loading && !isPending ? ' hc-refreshing' : ''}`}>

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
                    className={`cluster-dot ${isPending ? 'dot-pending' : cluster.connected ? 'dot-ok' : 'dot-err'}`}
                    aria-label={isPending ? 'Connecting' : cluster.connected ? 'Connected' : 'Disconnected'}
                    role="img"
                  />
                  <span className="hc-name">{cluster.name}</span>
                  <span className={`tier-badge tier-${cluster.tier}`}>{cluster.tier}</span>
                  <span className="hcell-dim hc-ctx">{cluster.context}</span>
                </div>
                <div className="hc-header-right">
                  {isPending
                    ? <span className="hc-loading-tag">◌ Connecting…</span>
                    : cluster.connected
                      ? <span className="hcell-dim">{cluster.namespaces.length} namespace{cluster.namespaces.length === 1 ? '' : 's'}</span>
                      : <span className="hc-err">⚠ Disconnected</span>
                  }
                </div>
              </div>

              {/* Collapsible body — lists namespaces; pods are fetched lazily per namespace below */}
              {isOpen && (<>
                {isPending && <div className="hc-empty">◌ Connecting to cluster…</div>}

                {!isPending && !cluster.connected && (
                  <div className="hc-empty">⚠ {cluster.error ?? 'Failed to connect'}</div>
                )}

                {!isPending && cluster.connected && cluster.namespaces.length === 0 && (
                  <div className="hc-empty">No namespaces found</div>
                )}

                {!isPending && cluster.connected && cluster.namespaces.map(ns => {
                  const nsKey     = `${cluster.name}/${ns.name}`
                  const nsIsOpen  = !!expandedNs[nsKey]
                  const visible   = ns.loaded ? applyFilters(ns.pods) : []
                  return (
                    <div key={ns.name} className={`hc-ns-block${nsIsOpen ? ' hc-ns-block-open' : ''}`}>
                      <div
                        className="hc-ns-header"
                        role="button"
                        tabIndex={0}
                        aria-expanded={nsIsOpen}
                        onClick={() => toggleNamespace(cluster.name, ns.name)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNamespace(cluster.name, ns.name) } }}
                      >
                        <span className={`hc-chevron hc-ns-chevron${nsIsOpen ? ' hc-chevron-open' : ''}`}>▶</span>
                        <span className="ns-tag">{ns.name}</span>
                        <div className="hc-ns-right">
                          {ns.loading
                            ? <span className="hc-loading-tag">◌ Loading pods…</span>
                            : ns.error
                              ? <span className="hc-err">⚠ {ns.error}</span>
                              : ns.loaded
                                ? (hasActive
                                    ? <span className="hcell-dim">{visible.length} / {ns.pods.length} pods</span>
                                    : <ClusterStats pods={ns.pods} />)
                                : null
                          }
                        </div>
                      </div>

                      {nsIsOpen && (<>
                        {ns.loaded && visible.length === 0 && (
                          <div className="hc-empty">
                            {hasActive ? '⊘ No pods match the current search or filters'
                                       : 'No pods in this namespace'}
                          </div>
                        )}
                        {ns.loaded && visible.length > 0 && <PodTable pods={visible} />}
                      </>)}
                    </div>
                  )
                })}
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

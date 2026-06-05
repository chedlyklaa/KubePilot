import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

const ERRORS_REFRESH_MS = 30_000
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

const ALERT_LABELS = {
  OOMKilled:       'OOM Killed',
  HighRestarts:    'High Restarts',
  CPUThrottling:   'CPU Throttling',
  MemNearLimit:    'Memory Near Limit',
  ImagePullFailed: 'Image Pull Failed',
  NodePressure:    'Node Pressure',
}
const ALERT_SUGGESTIONS = {
  increase_memory:    { icon: '↑',  label: 'Increase memory limit'                      },
  increase_cpu_limit: { icon: '⚡', label: 'Increase CPU limit or requests'              },
  investigate_logs:   { icon: '📋', label: 'Check pod logs for crash cause'              },
  fix_image:          { icon: '📦', label: 'Fix image reference or pull credentials'     },
  check_node:         { icon: '🖥',  label: 'Inspect node resources'                     },
  check_config:       { icon: '⚙',  label: 'Check entrypoint, env vars or security context' },
  check_image:        { icon: '🔎', label: 'Binary not found — verify image entrypoint'  },
}

// "my-deploy-6c8fb8d957-xk2p9" → "my-deploy"
function podToWorkload(name) {
  if (!name) return name
  const parts = name.split('-')
  return parts.length > 2 ? parts.slice(0, -2).join('-') : name
}

function MiniBar({ pct, cls }) {
  return (
    <div className="alert-mbar">
      <div className="alert-mbar-track">
        <div className={`alert-mbar-fill ${cls}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
    </div>
  )
}

function AlertCard({ alert: e }) {
  const icon    = e.severity === 'critical' ? '🔴' : '🟠'
  const memCls  = e.memPct > 95 ? 'mf-danger' : e.memPct > 85 ? 'mf-warn' : 'mf-ok'
  const sug     = e.suggestion ? ALERT_SUGGESTIONS[e.suggestion] : null
  const workload = e.pod ? podToWorkload(e.pod) : null
  const hasDetails = e.container || e.exitCode != null ||
    (e.restartRate != null && e.restartRate > 0) || e.cpuMillicores != null

  return (
    <div className={`alert-card alert-card-${e.severity}`}>

      {/* Row 1 — type label + count/rate badge */}
      <div className="alert-card-top">
        <span className="alert-icon">{icon}</span>
        <span className="alert-type-label">{ALERT_LABELS[e.type] ?? e.type}</span>
        {e.type === 'HighRestarts' && (
          <span className="alert-count-badge">
            {e.count} restarts
            {e.restartRate > 0 && <span className="restart-rate"> · ~{e.restartRate}/hr</span>}
          </span>
        )}
        {e.type === 'CPUThrottling'   && <span className="alert-count-badge">{e.throttlePct}% throttled</span>}
        {e.type === 'MemNearLimit'    && <span className="alert-count-badge">{e.memPct}% of limit</span>}
        {e.type === 'NodePressure'    && <span className="alert-count-badge">{e.condition}</span>}
        {e.type === 'ImagePullFailed' && <span className="alert-count-badge">{e.reason}</span>}
      </div>

      {/* Row 2 — workload name (short) + full pod hash */}
      {e.node && <div className="alert-target"><span className="alert-node mono-small">{e.node}</span></div>}
      {e.namespace && e.pod && (
        <div className="alert-target">
          <span className="alert-ns">{e.namespace}</span>
          <span className="alert-sep"> / </span>
          <span className="alert-workload">{workload}</span>
          {workload !== e.pod && (
            <span className="alert-pod-hash mono-small"> ···{e.pod.slice(-8)}</span>
          )}
        </div>
      )}

      {/* Row 3 — detail chips: container · exit code · restart rate · CPU */}
      {hasDetails && (
        <div className="alert-details">
          {e.container && (
            <span className="adet"><span className="adet-lbl">ctr</span>{e.container}</span>
          )}
          {e.exitCode != null && (
            <span className={`adet${e.exitCode !== 0 ? ' adet-exit-bad' : ''}`}>
              <span className="adet-lbl">exit</span>{e.exitCode}
            </span>
          )}
          {e.restartRate > 0 && (
            <span className="adet"><span className="adet-lbl">rate</span>~{e.restartRate}/hr</span>
          )}
          {e.cpuMillicores != null && (
            <span className="adet"><span className="adet-lbl">cpu</span>{e.cpuMillicores}m</span>
          )}
        </div>
      )}

      {/* Row 4 — memory bar + last exit reason */}
      <div className="alert-metrics">
        {e.memUsedMi != null && e.memLimitMi != null && (
          <div className="alert-metric-row">
            <span className="alert-metric-lbl">mem</span>
            <MiniBar pct={e.memPct} cls={memCls} />
            <span className="alert-metric-val">
              {e.memUsedMi}Mi / {e.memLimitMi}Mi
              <span className={`alert-pct${e.memPct > 85 ? ' pct-danger' : ''}`}> ({e.memPct}%)</span>
            </span>
          </div>
        )}
        {e.type === 'CPUThrottling' && e.throttlePct != null && (
          <div className="alert-metric-row">
            <span className="alert-metric-lbl">throttle</span>
            <MiniBar pct={e.throttlePct} cls="mf-danger" />
            <span className="alert-metric-val">
              <span className="alert-pct pct-danger">{e.throttlePct}%</span>
            </span>
          </div>
        )}
        {e.lastTermReason && e.lastTermReason !== 'Completed' && (
          <div className="alert-metric-row">
            <span className="alert-metric-lbl">last exit</span>
            <span className={`alert-term-tag ${e.lastTermReason === 'OOMKilled' ? 'term-oom' : 'term-err'}`}>
              {e.lastTermReason}
            </span>
          </div>
        )}
      </div>

      {/* Row 5 — suggestion */}
      {sug && (
        <div className="alert-suggestion">
          <span className="sug-icon">{sug.icon}</span>
          <span>{sug.label}</span>
        </div>
      )}
    </div>
  )
}

function ErrorsPanel({ errors }) {
  const [collapsed, setCollapsed] = useState(false)
  if (!errors?.length) return null
  const critCount = errors.filter(e => e.severity === 'critical').length
  const highCount = errors.filter(e => e.severity === 'high').length
  return (
    <div className="errors-panel">
      <div className="errors-panel-header" onClick={() => setCollapsed(c => !c)}>
        <span className="errors-panel-title">⚠ Prometheus Alerts</span>
        <div className="ep-summary">
          {critCount > 0 && <span className="ep-badge ep-crit">🔴 {critCount} critical</span>}
          {highCount > 0 && <span className="ep-badge ep-high">🟠 {highCount} high</span>}
          <span className="ep-badge ep-total">{errors.length} total</span>
        </div>
        <span className="ep-toggle">{collapsed ? '▼' : '▲'}</span>
      </div>
      {!collapsed && (
        <div className="errors-panel-list">
          {errors.map((e, i) => (
            <AlertCard key={`${e.type}-${e.namespace}-${e.pod ?? e.node}-${i}`} alert={e} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── ClusterManager modal ─────────────────────────────────────────────────────
function ClusterManager({ onClose, onSaved }) {
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

// ── AlertRow ─────────────────────────────────────────────────────────────────
function AlertRow({ alert: e }) {
  const icon     = e.severity === 'critical' ? '🔴' : '🟠'
  const workload = e.pod ? podToWorkload(e.pod) : null
  const memCls   = e.memPct > 95 ? 'mf-danger' : e.memPct > 85 ? 'mf-warn' : 'mf-ok'
  const sug      = e.suggestion ? ALERT_SUGGESTIONS[e.suggestion] : null

  return (
    <tr className={`at-row at-${e.severity}`}>

      <td className="at-td at-td-sev">
        <span title={e.severity}>{icon}</span>
      </td>

      <td className="at-td">
        <span className="at-type-label">{ALERT_LABELS[e.type] ?? e.type}</span>
      </td>

      <td className="at-td at-td-target">
        {e.node && <span className="at-workload mono-small">{e.node}</span>}
        {e.namespace && e.pod && (
          <>
            <div>
              <span className="at-ns">{e.namespace}</span>
              <span className="at-sep"> / </span>
              <span className="at-workload">{workload}</span>
            </div>
            {workload !== e.pod && (
              <div className="at-pod-hash mono-small">···{e.pod.slice(-10)}</div>
            )}
          </>
        )}
      </td>

      <td className="at-td at-td-ctr">
        {e.container && <div className="at-ctr-name">{e.container}</div>}
        {e.exitCode != null && (
          <span className={`at-exit${e.exitCode !== 0 ? ' at-exit-bad' : ''}`}>exit {e.exitCode}</span>
        )}
        {!e.container && e.exitCode == null && <span className="hcell-dim">—</span>}
      </td>

      <td className="at-td at-td-mem">
        {e.memUsedMi != null && e.memLimitMi != null ? (
          <div className="at-mem-wrap">
            <MiniBar pct={e.memPct} cls={memCls} />
            <span className="at-mem-text">
              {e.memUsedMi}Mi / {e.memLimitMi}Mi
              <span className={`at-mem-pct${e.memPct > 85 ? ' pct-danger' : ''}`}> ({e.memPct}%)</span>
            </span>
          </div>
        ) : e.type === 'CPUThrottling' && e.throttlePct != null ? (
          <div className="at-mem-wrap">
            <MiniBar pct={e.throttlePct} cls="mf-danger" />
            <span className="at-mem-text pct-danger">{e.throttlePct}% throttled</span>
          </div>
        ) : (
          <span className="hcell-dim">—</span>
        )}
      </td>

      <td className="at-td at-td-rate">
        {e.type === 'HighRestarts' ? (
          <>
            <span className="at-restart-count">{e.count}</span>
            {e.restartRate > 0 && <div className="at-restart-rate">~{e.restartRate}/hr</div>}
          </>
        ) : (
          <span className="hcell-dim">—</span>
        )}
      </td>

      <td className="at-td">
        {e.lastTermReason && e.lastTermReason !== 'Completed'
          ? <span className={`alert-term-tag ${e.lastTermReason === 'OOMKilled' ? 'term-oom' : 'term-err'}`}>{e.lastTermReason}</span>
          : e.condition
          ? <span className="alert-term-tag term-err">{e.condition}</span>
          : e.reason
          ? <span className="alert-term-tag term-err">{e.reason}</span>
          : <span className="hcell-dim">—</span>}
      </td>

      <td className="at-td at-td-action">
        {sug
          ? <span className="at-suggestion">{sug.icon} {sug.label}</span>
          : <span className="hcell-dim">—</span>}
      </td>
    </tr>
  )
}

// ── AlertsTable ───────────────────────────────────────────────────────────────
function AlertsTable({ errors }) {
  if (!errors?.length) return (
    <div className="alerts-empty">
      <span style={{ fontSize: 28 }}>✓</span>
      <span>No Prometheus alerts — all pods healthy</span>
    </div>
  )
  return (
    <div className="alerts-table-wrap">
      <table className="alerts-table">
        <thead>
          <tr>
            <th className="at-th at-th-sev"></th>
            <th className="at-th">Type</th>
            <th className="at-th">Target</th>
            <th className="at-th">Container / Exit</th>
            <th className="at-th" style={{ minWidth: 170 }}>Memory / CPU</th>
            <th className="at-th">Restarts</th>
            <th className="at-th">Last Exit</th>
            <th className="at-th">Suggested Action</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e, i) => (
            <AlertRow key={`${e.type}-${e.namespace}-${e.pod ?? e.node}-${i}`} alert={e} />
          ))}
        </tbody>
      </table>
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
  const [filters,           setFilters]           = useState(EMPTY_FILTERS)
  const [drawerOpen,        setDrawerOpen]        = useState(false)
  const [noticeDismiss,     setNoticeDismiss]     = useState(false)
  const [promNoticeDismiss, setPromNoticeDismiss] = useState(false)
  const [errors,            setErrors]            = useState([])
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

  // Fetch Prometheus error alerts (OOMKilled, high restarts)
  useEffect(() => {
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
  }, [])

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

  const activeCount =
    (filters.phases.length     > 0 ? 1 : 0) +
    (filters.namespaces.length > 0 ? 1 : 0) +
    (filters.clusters.length   > 0 ? 1 : 0) +
    (filters.hasRestarts ? 1 : 0) + (filters.hasGpu ? 1 : 0)

  const toggle = key => val =>
    setFilters(f => ({ ...f, [key]: f[key].includes(val) ? f[key].filter(x => x !== val) : [...f[key], val] }))

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
              <div className="hc-header hc-header-clickable" onClick={() => toggleCluster(cluster.name)}>
                <div className="hc-header-left">
                  <span className={`hc-chevron${isOpen ? ' hc-chevron-open' : ''}`}>▶</span>
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
          <AlertsTable errors={errors} />
        </>
      )}

    </div>
  )
}

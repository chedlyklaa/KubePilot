import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { apiFetch } from '../lib/api'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine,
} from 'recharts'

const REFRESH_MS = 60_000
const PHASE_CLASS = { Running: 'cp-phase-running', Pending: 'cp-phase-pending', Succeeded: 'cp-phase-ok', Failed: 'cp-phase-fail', Unknown: 'cp-phase-unknown' }
const LEVEL_CLASS = { CRITICAL: 'cp-lvl-crit', HIGH: 'cp-lvl-high', WARNING: 'cp-lvl-warn', OK: 'cp-lvl-ok' }

function parseTimeInput(input) {
  const str = input.trim().toLowerCase()
  const match = str.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/)
  if (!match) return null
  const num = parseInt(match[1], 10)
  const unit = match[2][0]
  if (unit === 'm') return num / 60
  if (unit === 'h') return num
  if (unit === 'd') return num * 24
  return null
}

function TimeRangePicker({ value, onChange }) {
  const [showCustom, setShowCustom] = useState(false)
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('now')
  const [error, setError] = useState('')
  const dropRef = useRef(null)

  const PRESETS = [
    { value: 1,    label: '1h' },
    { value: 6,    label: '6h' },
    { value: 12,   label: '12h' },
    { value: 24,   label: '24h' },
    { value: 48,   label: '2d' },
    { value: 168,  label: '7d' },
  ]

  useEffect(() => {
    function handleClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) setShowCustom(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function applyCustom() {
    const fromHours = parseTimeInput(fromInput)
    if (fromHours == null || fromHours <= 0) {
      setError('Invalid "from" value. Use e.g. 30m, 6h, 2d')
      return
    }
    if (toInput.trim().toLowerCase() !== 'now') {
      const toHours = parseTimeInput(toInput)
      if (toHours == null || toHours < 0) {
        setError('Invalid "to" value. Use "now" or e.g. 1h, 30m')
        return
      }
      const range = fromHours - toHours
      if (range <= 0) {
        setError('"From" must be greater than "to"')
        return
      }
      onChange({ hours: fromHours, offsetHours: toHours })
    } else {
      onChange({ hours: fromHours, offsetHours: 0 })
    }
    setError('')
    setShowCustom(false)
  }

  const activePreset = PRESETS.find(p => p.value === (typeof value === 'number' ? value : value?.hours))
  const displayLabel = activePreset
    ? activePreset.label
    : typeof value === 'object'
      ? `${value.hours}h${value.offsetHours ? ` → -${value.offsetHours}h` : ''}`
      : `${value}h`

  return (
    <div className="cp-time-picker" ref={dropRef}>
      <div className="cp-time-presets">
        {PRESETS.map(p => (
          <button key={p.value}
            className={`filter-chip ${activePreset?.value === p.value ? 'active' : ''}`}
            onClick={() => { onChange(p.value); setShowCustom(false) }}>
            {p.label}
          </button>
        ))}
        <button
          className={`filter-chip cp-custom-btn ${!activePreset ? 'active' : ''}`}
          onClick={() => setShowCustom(s => !s)}>
          {!activePreset ? displayLabel : 'Custom'}
        </button>
      </div>

      {showCustom && (
        <div className="cp-time-dropdown">
          <div className="cp-time-dropdown-title">Custom time range</div>
          <div className="cp-time-row">
            <label>From (ago)</label>
            <input
              className="cp-time-input"
              placeholder="e.g. 6h, 30m, 2d"
              value={fromInput}
              onChange={e => setFromInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyCustom()}
            />
          </div>
          <div className="cp-time-row">
            <label>To</label>
            <input
              className="cp-time-input"
              placeholder="now (or e.g. 1h)"
              value={toInput}
              onChange={e => setToInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyCustom()}
            />
          </div>
          {error && <div className="cp-time-error">{error}</div>}
          <div className="cp-time-actions">
            <button className="btn-primary cp-time-apply" onClick={applyCustom}>Apply</button>
          </div>
          <div className="cp-time-hints">
            <span>Examples: 30m, 1h, 6h, 12h, 2d, 7d</span>
          </div>
        </div>
      )}
    </div>
  )
}

function pct(v) { return v != null ? `${v}%` : '—' }
function fmtMem(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(0)}Ki`
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(0)}Mi`
  return `${(bytes / 1024 ** 3).toFixed(2)}Gi`
}
function fmtEta(h) {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 24) return `${h.toFixed(1)}h`
  if (h < 168) return `${(h / 24).toFixed(1)}d`
  return `${(h / 168).toFixed(1)}w`
}

// ── Bar component ─────────────────────────────────────────────────────────
function Bar({ value, label, size = 'md' }) {
  const v = value ?? 0
  const color = v >= 90 ? 'var(--danger)' : v >= 75 ? 'var(--warn)' : 'var(--success)'
  return (
    <div className={`cp-bar cp-bar-${size}`}>
      <div className="cp-bar-track">
        <div className="cp-bar-fill" style={{ width: `${Math.min(100, v)}%`, background: color }} />
      </div>
      <span className="cp-bar-label">{label ?? `${v}%`}</span>
    </div>
  )
}

export default function CapacityPage() {
  const [clusters, setClusters]             = useState([])
  const [selectedCluster, setSelectedCluster] = useState('')
  const [data, setData]                     = useState(null)
  const [loading, setLoading]               = useState(false)
  const [podFilter, setPodFilter]           = useState('all')
  const [podSearch, setPodSearch]           = useState('')
  const [forecastFilter, setForecastFilter] = useState(null)
  const [lastUpdated, setLastUpdated]       = useState(null)
  const [chartData, setChartData]           = useState([])
  const [chartRange, setChartRange]         = useState(24)
  const [bucketMin, setBucketMin]           = useState(5)
  const chartTimer = useRef(null)

  const chartHours = typeof chartRange === 'number' ? chartRange : chartRange?.hours ?? 24

  const BUCKET_STEPS = [
    { value: 0.5, label: '30s' },
    { value: 1,   label: '1m' },
    { value: 2,   label: '2m' },
    { value: 5,   label: '5m' },
    { value: 10,  label: '10m' },
    { value: 15,  label: '15m' },
    { value: 30,  label: '30m' },
    { value: 60,  label: '1h' },
  ]
  const bucketIdx = BUCKET_STEPS.findIndex(s => s.value === bucketMin)
  const bucketLabel = BUCKET_STEPS[bucketIdx >= 0 ? bucketIdx : 3].label

  const loadChart = useCallback(async (cluster, nodesArr, hours, bktMin) => {
    if (!cluster || !nodesArr?.length) return
    try {
      const allPoints = []
      await Promise.all(nodesArr.map(async (n) => {
        const r = await apiFetch(
          `/api/capacity/history?cluster=${encodeURIComponent(cluster)}&target=node:${encodeURIComponent(n.name)}&hours=${hours}`
        )
        const { snapshots } = await r.json()
        for (const s of (snapshots ?? [])) {
          allPoints.push({
            time:    new Date(s.createdAt).getTime(),
            cpuPct:  s.cpuPct,
            memPct:  s.memPct,
            node:    n.name,
          })
        }
      }))
      // Add the current live point from kubectl top
      const now = Date.now()
      for (const n of nodesArr) {
        if (n.cpuPct != null || n.memPct != null) {
          allPoints.push({ time: now, cpuPct: n.cpuPct, memPct: n.memPct, node: n.name })
        }
      }
      allPoints.sort((a, b) => a.time - b.time)

      const BUCKET = bktMin * 60_000
      const buckets = new Map()
      for (const p of allPoints) {
        const key = Math.round(p.time / BUCKET) * BUCKET
        if (!buckets.has(key)) buckets.set(key, { cpuSum: 0, memSum: 0, count: 0 })
        const b = buckets.get(key)
        if (p.cpuPct != null) { b.cpuSum += p.cpuPct; b.count++ }
        if (p.memPct != null) b.memSum += p.memPct
      }
      const series = [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, b]) => ({
          time:   t,
          cpuPct: b.count ? +(b.cpuSum / b.count).toFixed(1) : null,
          memPct: b.count ? +(b.memSum / b.count).toFixed(1) : null,
        }))
      setChartData(series)
    } catch {
      setChartData([])
    }
  }, [])

  useEffect(() => {
    apiFetch('/api/kube/contexts').then(r => r.json()).then(d => {
      const list = d.contexts ?? []
      setClusters(list)
      if (list.length > 0) setSelectedCluster(list[0].name)
    }).catch(() => {})
  }, [])

  const load = useCallback(async (cluster) => {
    if (!cluster) return
    setLoading(true)
    try {
      const r = await apiFetch(`/api/capacity/overview?cluster=${encodeURIComponent(cluster)}`)
      setData(await r.json())
      setLastUpdated(new Date())
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!selectedCluster) return
    load(selectedCluster)
    const id = setInterval(() => load(selectedCluster), REFRESH_MS)
    return () => clearInterval(id)
  }, [selectedCluster, load])

  useEffect(() => {
    if (!data?.nodes?.length || !selectedCluster) return
    loadChart(selectedCluster, data.nodes, chartHours, bucketMin)
    clearInterval(chartTimer.current)
    chartTimer.current = setInterval(() => loadChart(selectedCluster, data.nodes, chartHours, bucketMin), REFRESH_MS)
    return () => clearInterval(chartTimer.current)
  }, [data?.nodes, selectedCluster, chartHours, bucketMin, loadChart])

  const s = data?.summary ?? {}
  const nodes = data?.nodes ?? []
  const pods = data?.pods ?? []

  // Pod filtering
  const filteredPods = useMemo(() => {
    let list = pods
    if (podFilter === 'running')  list = list.filter(p => p.phase === 'Running' && p.isReady)
    if (podFilter === 'failing')  list = list.filter(p => p.phase !== 'Running' || !p.isReady || p.restarts >= 5)
    if (podFilter === 'pending')  list = list.filter(p => p.phase === 'Pending')
    if (podSearch) {
      const q = podSearch.toLowerCase()
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.namespace.toLowerCase().includes(q))
    }
    return list
  }, [pods, podFilter, podSearch])

  // Forecast items
  const forecastItems = useMemo(() => {
    if (!data?.forecast) return []
    const all = []
    for (const items of Object.values(data.forecast.pods ?? {})) all.push(...items)
    for (const items of Object.values(data.forecast.nodes ?? {})) all.push(...items)
    for (const items of Object.values(data.forecast.namespaces ?? {})) all.push(...items)
    if (forecastFilter) return all.filter(f => f.alertLevel === forecastFilter)
    return all
  }, [data?.forecast, forecastFilter])

  const fSummary = data?.forecast?.summary

  return (
    <div className="cp-page">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h2>Capacity</h2>
          <p className="page-subtitle">
            Live cluster resources, pod states & projections
            {lastUpdated && <> · updated {lastUpdated.toLocaleTimeString()}</>}
          </p>
        </div>
        <div className="cp-controls">
          <select value={selectedCluster} onChange={e => setSelectedCluster(e.target.value)}>
            {clusters.map(c => <option key={c.name} value={c.name}>{c.config?.name ?? c.name}</option>)}
          </select>
          <button className="btn-primary" onClick={() => load(selectedCluster)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {!data && loading && <div className="cp-empty">Loading…</div>}
      {!data && !loading && <div className="cp-empty">Select a cluster to view capacity data</div>}

      {data && (<>
        {/* ── Summary cards ──────────────────────────────────────────── */}
        <div className="cp-summary">
          <div className="cp-card cp-card-accent">
            <div className="cp-card-value">{s.totalPods}</div>
            <div className="cp-card-label">Total Pods</div>
            <div className="cp-card-sub">{s.running} running · {s.failing} failing</div>
          </div>
          <div className="cp-card">
            <div className="cp-card-value">{s.totalNodes}</div>
            <div className="cp-card-label">Nodes</div>
            <div className="cp-card-sub">{s.totalCpu} vCPU · {s.totalMemGi}Gi</div>
          </div>
          <div className="cp-card">
            <div className="cp-card-value">{pct(s.avgCpuPct)}</div>
            <div className="cp-card-label">Avg CPU</div>
            <Bar value={s.avgCpuPct} size="sm" />
          </div>
          <div className="cp-card">
            <div className="cp-card-value">{pct(s.avgMemPct)}</div>
            <div className="cp-card-label">Avg Memory</div>
            <Bar value={s.avgMemPct} size="sm" />
          </div>
        </div>

        {/* ── Nodes ─────────────────────────────────────────────────── */}
        <div className="cp-section">
          <h3 className="cp-section-title">Nodes</h3>
          <div className="cp-nodes-grid">
            {nodes.map(n => (
              <div key={n.name} className={`cp-node-card ${!n.ready ? 'cp-node-notready' : ''}`}>
                <div className="cp-node-head">
                  <span className="cp-node-name">{n.name}</span>
                  <span className={`cp-node-status ${n.ready ? 'cp-status-ok' : 'cp-status-err'}`}>
                    {n.ready ? 'Ready' : 'NotReady'}
                  </span>
                </div>
                <div className="cp-node-resources">
                  <div className="cp-node-res">
                    <span className="cp-node-res-label">CPU</span>
                    <Bar value={n.cpuPct} label={`${n.cpuUsed ?? '—'} / ${n.cpuCores} cores (${pct(n.cpuPct)})`} />
                  </div>
                  <div className="cp-node-res">
                    <span className="cp-node-res-label">Memory</span>
                    <Bar value={n.memPct} label={`${n.memUsed ?? '—'} / ${n.memGi}Gi (${pct(n.memPct)})`} />
                  </div>
                </div>
                <div className="cp-node-footer">
                  <span className="cp-azure-tag">{n.azureSku}</span>
                  <span className="cp-azure-cost">${n.azureMonthly}/mo</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Usage Charts ──────────────────────────────────────────── */}
        <div className="cp-section">
          <div className="cp-section-header">
            <h3 className="cp-section-title">Resource Usage Over Time</h3>
            <div className="cp-chart-controls">
              <div className="cp-bucket-slider">
                <span className="cp-bucket-label">Interval: <strong>{bucketLabel}</strong></span>
                <input
                  type="range"
                  min={0}
                  max={BUCKET_STEPS.length - 1}
                  step={1}
                  value={bucketIdx >= 0 ? bucketIdx : 3}
                  onChange={e => setBucketMin(BUCKET_STEPS[+e.target.value].value)}
                  className="cp-slider"
                />
                <div className="cp-bucket-ticks">
                  {BUCKET_STEPS.map((s, i) => (
                    <span key={i} className={`cp-tick ${bucketIdx === i ? 'active' : ''}`}>{s.label}</span>
                  ))}
                </div>
              </div>
              <TimeRangePicker value={chartRange} onChange={setChartRange} />
            </div>
          </div>
          {chartData.length < 2
            ? <div className="cp-empty">
                Not enough snapshot data yet for charts.
                <br/><span className="text-dim">Data accumulates as the cluster agent runs. Current live values are shown above.</span>
              </div>
            : (
              <div className="cp-charts-grid">
                {/* CPU Chart */}
                <div className="cp-chart-card">
                  <div className="cp-chart-title">CPU Usage (%)</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                      <defs>
                        <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#6366f1" stopOpacity={0.03} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        dataKey="time" type="number" domain={['dataMin', 'dataMax']} scale="time"
                        tickFormatter={t => {
                          const d = new Date(t)
                          return chartHours <= 24
                            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                        }}
                        tick={{ fontSize: 11, fill: 'var(--text-dim)' }}
                        stroke="var(--border)"
                        minTickGap={40}
                      />
                      <YAxis
                        domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
                        tickFormatter={v => `${v}%`}
                        tick={{ fontSize: 11, fill: 'var(--text-dim)' }}
                        stroke="var(--border)"
                        width={42}
                      />
                      <Tooltip
                        contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                        labelFormatter={t => new Date(t).toLocaleString()}
                        formatter={(v) => [`${v}%`, 'CPU']}
                      />
                      <ReferenceLine y={75} stroke="#f59e0b" strokeDasharray="6 3" label={{ value: 'WARN 75%', position: 'right', fill: '#f59e0b', fontSize: 10 }} />
                      <ReferenceLine y={85} stroke="#f97316" strokeDasharray="6 3" label={{ value: 'HIGH 85%', position: 'right', fill: '#f97316', fontSize: 10 }} />
                      <ReferenceLine y={92} stroke="#ef4444" strokeDasharray="6 3" label={{ value: 'CRIT 92%', position: 'right', fill: '#ef4444', fontSize: 10 }} />
                      <Area
                        type="monotone" dataKey="cpuPct" name="CPU"
                        stroke="#6366f1" strokeWidth={2}
                        fill="url(#cpuGrad)" dot={false}
                        connectNulls
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Memory Chart */}
                <div className="cp-chart-card">
                  <div className="cp-chart-title">Memory Usage (%)</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                      <defs>
                        <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#22c55e" stopOpacity={0.03} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        dataKey="time" type="number" domain={['dataMin', 'dataMax']} scale="time"
                        tickFormatter={t => {
                          const d = new Date(t)
                          return chartHours <= 24
                            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                        }}
                        tick={{ fontSize: 11, fill: 'var(--text-dim)' }}
                        stroke="var(--border)"
                        minTickGap={40}
                      />
                      <YAxis
                        domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
                        tickFormatter={v => `${v}%`}
                        tick={{ fontSize: 11, fill: 'var(--text-dim)' }}
                        stroke="var(--border)"
                        width={42}
                      />
                      <Tooltip
                        contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                        labelFormatter={t => new Date(t).toLocaleString()}
                        formatter={(v) => [`${v}%`, 'Memory']}
                      />
                      <ReferenceLine y={80} stroke="#f59e0b" strokeDasharray="6 3" label={{ value: 'WARN 80%', position: 'right', fill: '#f59e0b', fontSize: 10 }} />
                      <ReferenceLine y={90} stroke="#f97316" strokeDasharray="6 3" label={{ value: 'HIGH 90%', position: 'right', fill: '#f97316', fontSize: 10 }} />
                      <ReferenceLine y={95} stroke="#ef4444" strokeDasharray="6 3" label={{ value: 'CRIT 95%', position: 'right', fill: '#ef4444', fontSize: 10 }} />
                      <Area
                        type="monotone" dataKey="memPct" name="Memory"
                        stroke="#22c55e" strokeWidth={2}
                        fill="url(#memGrad)" dot={false}
                        connectNulls
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )
          }
        </div>

        {/* ── Pods ──────────────────────────────────────────────────── */}
        <div className="cp-section">
          <div className="cp-section-header">
            <h3 className="cp-section-title">Pods ({filteredPods.length})</h3>
            <div className="cp-pod-controls">
              <input className="cp-search" placeholder="Search pod or namespace…" value={podSearch}
                onChange={e => setPodSearch(e.target.value)} />
              <div className="filter-chips">
                {[['all', 'All'], ['running', 'Running'], ['failing', 'Failing'], ['pending', 'Pending']].map(([k, l]) => (
                  <button key={k} className={`filter-chip ${podFilter === k ? 'active' : ''}`} onClick={() => setPodFilter(k)}>{l}</button>
                ))}
              </div>
            </div>
          </div>
          {filteredPods.length === 0
            ? <div className="cp-empty">No pods match the current filter</div>
            : (
              <div className="table-wrap">
                <table className="data-table cp-pod-table">
                  <thead>
                    <tr>
                      <th>Pod</th><th>Namespace</th><th>Phase</th><th>Ready</th>
                      <th>Restarts</th><th>CPU</th><th>Memory</th><th>Node</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPods.map(p => (
                      <tr key={`${p.namespace}/${p.name}`}>
                        <td className="fw-500 mono-small">{p.name}</td>
                        <td className="text-dim">{p.namespace}</td>
                        <td><span className={`cp-phase ${PHASE_CLASS[p.phase] ?? 'cp-phase-unknown'}`}>{p.phase}</span></td>
                        <td>{p.ready}</td>
                        <td className={p.restarts >= 5 ? 'cp-restart-warn' : ''}>{p.restarts}</td>
                        <td className="mono-small">{p.cpuRaw ?? '—'}</td>
                        <td className="mono-small">{p.memRaw ?? fmtMem(p.memBytes)}</td>
                        <td className="text-dim">{p.node}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </div>

        {/* ── Forecast alerts ───────────────────────────────────────── */}
        <div className="cp-section">
          <div className="cp-section-header">
            <h3 className="cp-section-title">Forecast & Projections</h3>
            {fSummary && (
              <div className="cp-forecast-badges">
                {[['CRITICAL', fSummary.criticalCount], ['HIGH', fSummary.highCount], ['WARNING', fSummary.warningCount], ['OK', fSummary.okCount]].map(([lvl, cnt]) => (
                  <button key={lvl}
                    className={`cp-fbadge ${LEVEL_CLASS[lvl]} ${forecastFilter === lvl ? 'cp-fbadge-active' : ''}`}
                    onClick={() => setForecastFilter(f => f === lvl ? null : lvl)}>
                    {cnt} {lvl}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!data.forecast
            ? <div className="cp-empty">
                No forecast data yet. Enable with <code>CAPACITY_FORECAST_ENABLED=true</code>.
                <br/><span className="text-dim">Forecasts appear after the ClusterAgent collects enough snapshots.</span>
              </div>
            : forecastItems.length === 0
              ? <div className="cp-empty">No forecasts match the current filter. <button className="link-btn" onClick={() => setForecastFilter(null)}>Clear</button></div>
              : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Level</th><th>Target</th><th>Namespace</th><th>Resource</th>
                        <th>Current</th><th>Trend</th><th>Exhaustion ETA</th><th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forecastItems.map((fc, i) => (
                        <tr key={i} className={`cp-fc-row-${fc.alertLevel.toLowerCase()}`}>
                          <td><span className={`badge ${LEVEL_CLASS[fc.alertLevel]}`}>{fc.alertLevel}</span></td>
                          <td className="fw-500 mono-small">{fc.target.replace(/^(pod|node|namespace):/, '')}</td>
                          <td className="text-dim">{fc.namespace || '—'}</td>
                          <td>{fc.resource}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <Bar value={fc.currentPct} size="sm" />
                              <span className="mono-small">{fc.currentPct}%</span>
                            </div>
                          </td>
                          <td className="mono-small">{fc.slope > 0 ? '+' : ''}{fc.slope?.toFixed(2) ?? '—'}%/h</td>
                          <td className={fc.hoursToExhaustion != null && fc.hoursToExhaustion < 24 ? 'cp-eta-urgent' : ''}>
                            {fmtEta(fc.hoursToExhaustion)}
                          </td>
                          <td><span className={`cp-conf cp-conf-${(fc.confidence ?? 'LOW').toLowerCase()}`}>{fc.confidence ?? '—'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          }
        </div>

        {/* ── Azure Cost Breakdown ──────────────────────────────────── */}
        <div className="cp-section">
          <h3 className="cp-section-title">Azure Cost Estimation</h3>
          <p className="cp-section-sub">Compute, storage, load balancers & network egress — estimated monthly cost on AKS</p>

          {/* ── Total cost banner ────────────────────────────────────── */}
          {s.totalMonthly != null && (
            <div className="cp-total-banner">
              <div className="cp-total-banner-label">Estimated Total Monthly Cost</div>
              <div className="cp-total-banner-value">${s.totalMonthly?.toFixed(2)}</div>
              <div className="cp-total-banner-breakdown">
                <span>Compute ${s.provisionedAzure?.toFixed(2)}</span>
                <span className="cp-total-sep">+</span>
                <span>Disk ${s.diskMonthly?.toFixed(2) ?? '0.00'}</span>
                <span className="cp-total-sep">+</span>
                <span>LB ${s.lbMonthly?.toFixed(2) ?? '0.00'}</span>
                <span className="cp-total-sep">+</span>
                <span>Egress ${s.egressMonthly?.toFixed(2) ?? '0.00'}</span>
              </div>
            </div>
          )}

          {/* ── Compute cost cards ──────────────────────────────────── */}
          <div className="cp-cost-subtitle">Compute</div>
          <div className="cp-cost-cards">
            <div className="cp-cost-box">
              <div className="cp-cost-box-label">Workload-Based (right-sized)</div>
              <div className="cp-cost-box-value">${s.azureMonthly?.toFixed(2)}<span className="text-dim">/mo</span></div>
              <div className="cp-cost-box-detail">
                {s.workloadCpu ?? '?'} vCPU + {s.workloadMemGi ?? '?'}Gi requested → <span className="cp-azure-tag">{s.azureSku}</span>
              </div>
            </div>
            <div className="cp-cost-box cp-cost-box-dim">
              <div className="cp-cost-box-label">Provisioned (full node capacity)</div>
              <div className="cp-cost-box-value">${s.provisionedAzure?.toFixed(2)}<span className="text-dim">/mo</span></div>
              <div className="cp-cost-box-detail">
                {nodes.length} node(s) × {nodes[0]?.cpuCores ?? '?'} vCPU, {nodes[0]?.memGi ?? '?'}Gi each
              </div>
            </div>
          </div>
          {nodes.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data-table">
                <thead><tr><th>Node</th><th>vCPU</th><th>Memory</th><th>CPU Used</th><th>Mem Used</th><th>Azure VM SKU</th><th>Monthly</th></tr></thead>
                <tbody>
                  {nodes.map(n => (
                    <tr key={n.name}>
                      <td className="fw-500">{n.name}</td>
                      <td>{n.cpuCores}</td>
                      <td>{n.memGi} Gi</td>
                      <td>{pct(n.cpuPct)}</td>
                      <td>{pct(n.memPct)}</td>
                      <td><span className="cp-azure-tag">{n.azureSku}</span></td>
                      <td className="fw-500">${n.azureMonthly.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Disk cost ───────────────────────────────────────────── */}
          <div className="cp-cost-subtitle" style={{ marginTop: 20 }}>Persistent Storage</div>
          <div className="cp-cost-cards">
            <div className="cp-cost-box" style={{ borderLeftColor: '#8b5cf6' }}>
              <div className="cp-cost-box-label">Managed Disks Total</div>
              <div className="cp-cost-box-value" style={{ color: '#8b5cf6' }}>
                ${s.diskMonthly?.toFixed(2) ?? '0.00'}<span className="text-dim">/mo</span>
              </div>
              <div className="cp-cost-box-detail">
                {data.disks?.length ?? 0} volume(s)
              </div>
            </div>
          </div>
          {data.disks?.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data-table">
                <thead><tr><th>Volume</th><th>Size</th><th>Storage Class</th><th>Status</th><th>Claim</th><th>Rate</th><th>Monthly</th></tr></thead>
                <tbody>
                  {data.disks.map(d => (
                    <tr key={d.name}>
                      <td className="fw-500 mono-small">{d.name}</td>
                      <td>{d.sizeGi} Gi</td>
                      <td><span className="cp-azure-tag">{d.storageClass}</span></td>
                      <td><span className={`cp-phase ${d.status === 'Bound' ? 'cp-phase-running' : 'cp-phase-pending'}`}>{d.status}</span></td>
                      <td className="text-dim mono-small">{d.claim ?? '—'}</td>
                      <td className="text-dim">${d.ratePerGi}/Gi</td>
                      <td className="fw-500">${d.monthly.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Load Balancer cost ──────────────────────────────────── */}
          <div className="cp-cost-subtitle" style={{ marginTop: 20 }}>Load Balancers</div>
          <div className="cp-cost-cards">
            <div className="cp-cost-box" style={{ borderLeftColor: '#f59e0b' }}>
              <div className="cp-cost-box-label">Azure Load Balancers Total</div>
              <div className="cp-cost-box-value" style={{ color: '#f59e0b' }}>
                ${s.lbMonthly?.toFixed(2) ?? '0.00'}<span className="text-dim">/mo</span>
              </div>
              <div className="cp-cost-box-detail">
                {data.loadBalancers?.length ?? 0} load balancer(s)
              </div>
            </div>
          </div>
          {data.loadBalancers?.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data-table">
                <thead><tr><th>Service</th><th>Ports</th><th>External IP</th><th>Monthly</th></tr></thead>
                <tbody>
                  {data.loadBalancers.map(lb => (
                    <tr key={lb.name}>
                      <td className="fw-500 mono-small">{lb.name}</td>
                      <td>{lb.ports}</td>
                      <td className="mono-small">{lb.externalIPs?.join(', ') || '—'}</td>
                      <td className="fw-500">${lb.monthly.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Network Egress cost ─────────────────────────────────── */}
          <div className="cp-cost-subtitle" style={{ marginTop: 20 }}>Network Egress</div>
          <div className="cp-cost-cards">
            <div className="cp-cost-box" style={{ borderLeftColor: '#06b6d4' }}>
              <div className="cp-cost-box-label">Estimated Egress Total</div>
              <div className="cp-cost-box-value" style={{ color: '#06b6d4' }}>
                ${s.egressMonthly?.toFixed(2) ?? '0.00'}<span className="text-dim">/mo</span>
              </div>
              <div className="cp-cost-box-detail">
                Based on Prometheus node_network_transmit_bytes
                {!data.egressDetails?.length && ' — no Prometheus data available'}
              </div>
            </div>
          </div>
          {data.egressDetails?.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data-table">
                <thead><tr><th>Node</th><th>Current Rate</th><th>Projected Monthly</th><th>Estimated Cost</th></tr></thead>
                <tbody>
                  {data.egressDetails.map(e => (
                    <tr key={e.instance}>
                      <td className="fw-500 mono-small">{e.instance}</td>
                      <td className="mono-small">{(e.bytesPerSec / 1024).toFixed(1)} KB/s</td>
                      <td>{e.monthlyGi} Gi</td>
                      <td className="fw-500">${e.monthly.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>)}
    </div>
  )
}

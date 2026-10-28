import { useState, useEffect, useMemo, Fragment } from 'react'
import { apiFetch, openSSE } from '../lib/api'
import { fmtDT } from '../utils/format'
import { WORKFLOW_STEP, WORKFLOW_STEP_ORDER } from '../constants'

// Outcome badge
function OutcomeBadge({ finishedAt, outcome }) {
  if (!finishedAt) return <span className="issue-badge issue-badge-info">In progress</span>
  const color = outcome === 'fixed' ? 'success' : outcome === 'escalated' ? 'danger' : outcome === 'blocked' ? 'warn' : 'dim'
  return <span className={`issue-badge issue-badge-${color}`}>{outcome ?? 'finished'}</span>
}

// Render a step's output fields
function StepOutput({ output }) {
  const entries = Object.entries(output ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (entries.length === 0) return <span className="hcell-dim">(no additional output)</span>
  return (
    <div className="live-step-fields">
      {entries.map(([k, v]) => (
        <div key={k} className="live-step-field">
          <span className="live-step-field-key">{k}</span>
          <span className="live-step-field-val">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
        </div>
      ))}
    </div>
  )
}

// Get the dispatch key of an incident
function dispatchKeyOf(incident) {
  return incident.steps.find(s => s.component === 'orchestrator')?.output?.dispatchKey ?? null
}

// Step trail of one incident
function IncidentDetail({ incident }) {
  const r = incident.resource ?? {}
  const meta = WORKFLOW_STEP[incident.currentStep] ?? { icon: '•', label: incident.currentStep ?? '—' }
  return (
    <div className="live-incident-block">
      <div className="live-incident-head">
        <span>{meta.icon} {meta.label}</span>
        <span className="mono-small">{r.kind ?? '—'}</span>
        <span className="mono-small">{r.clusterName ?? '—'}</span>
        <span className="mono-small">{r.namespace ?? '—'}</span>
        <span className="mono-small">{r.name ?? '—'}</span>
        <OutcomeBadge finishedAt={incident.finishedAt} outcome={incident.outcome} />
      </div>

      <div className="live-step-order">
        {WORKFLOW_STEP_ORDER.map(step => {
          const reached = incident.steps.some(s => s.component === step)
          const isCurrent = incident.currentStep === step && !incident.finishedAt
          return (
            <span key={step} className={`live-step-chip${reached ? ' live-step-chip-done' : ''}${isCurrent ? ' live-step-chip-current' : ''}`}>
              {WORKFLOW_STEP[step]?.icon} {WORKFLOW_STEP[step]?.label}
            </span>
          )
        })}
      </div>

      <div className="issue-timeline">
        {incident.steps.map((s, i) => {
          const m = WORKFLOW_STEP[s.component] ?? { icon: '•', label: s.component }
          return (
            <div key={i} className="live-step-row">
              <div className="issue-tl-row">
                <span className="issue-tl-icon tl-info">{m.icon}</span>
                <span className="issue-tl-time hcell-dim">{fmtDT(s.ts)}</span>
                <span className="issue-tl-label">{m.label}</span>
                {s.durationMs != null && <span className="hcell-dim"> ({s.durationMs}ms)</span>}
              </div>
              <StepOutput output={s.output} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// One workflow row
function WorkflowRow({ workflow, expanded, onToggle }) {
  const clusters = [...new Set(workflow.incidents.map(i => i.resource?.clusterName).filter(Boolean))]
  return (
    <Fragment>
      <tr className="issue-row" onClick={onToggle}>
        <td>
          <span className={`hc-chevron issue-row-chevron${expanded ? ' hc-chevron-open' : ''}`}>▶</span>
          <span className="issue-id-chip" title={workflow.workflowId}>{workflow.workflowId.slice(0, 8)}</span>
        </td>
        <td className="mono-small">{workflow.dispatchKey ?? '—'}</td>
        <td className="mono-small">{clusters.join(', ') || '—'}</td>
        <td>{workflow.incidents.length}</td>
        <td><OutcomeBadge finishedAt={workflow.finishedAt} outcome={workflow.outcome} /></td>
        <td className="hcell-dim">{fmtDT(workflow.startedAt)}</td>
        <td className="hcell-dim">{fmtDT(workflow.updatedAt)}</td>
      </tr>
      {expanded && (
        <tr className="issue-detail-row">
          <td colSpan={7}>
            <div className="issue-detail">
              {workflow.incidents.map(incident => (
                <IncidentDetail key={incident.incidentKey} incident={incident} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

// Format a TTL in seconds
function fmtTTLsec(sec) {
  if (sec == null || sec === -2) return 'expired'
  if (sec === -1) return 'no expiry'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  return `${Math.round(sec / 3600)}h`
}
function fmtTTLms(ms) { return ms == null ? '—' : fmtTTLsec(Math.round(ms / 1000)) }

// Short Memory state section
function ShortMemorySection() {
  const [state, setState]     = useState(null)
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const fetchState = () => apiFetch('/api/live-workflows/short-memory')
      .then(r => r.json())
      .then(d => { if (!cancelled) { setState(d); setError(null) } })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    fetchState()
    const id = setInterval(fetchState, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (loading) return <div className="page-loading">Loading Short Memory…</div>
  if (error)   return <div className="health-error">⚠ {error}</div>
  if (!state?.ready) return <div className="empty-page"><span>Short Memory is offline — Redis is unreachable (dedup/queue/locks disabled)</span></div>

  return (
    <div className="live-shortmem">
      <div className="issue-subsection">
        <div className="issue-subsection-title">Dispatch queue ({state.queue.length}) — waiting to become a workflow</div>
        {state.queue.length === 0 ? <span className="hcell-dim">empty</span> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Dispatch key</th><th>Priority</th></tr></thead>
              <tbody>
                {state.queue.map(q => (
                  <tr key={q.dispatchKey}><td className="mono-small">{q.dispatchKey}</td><td>{q.priority}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="issue-subsection">
        <div className="issue-subsection-title">Active workflows ({state.activeWorkflows.length}) — occupying a concurrency slot</div>
        {state.activeWorkflows.length === 0 ? <span className="hcell-dim">none</span> : (
          <div className="live-chip-list">
            {state.activeWorkflows.map(id => <span key={id} className="issue-id-chip" title={id}>{id.slice(0, 8)}</span>)}
          </div>
        )}
      </div>

      <div className="issue-subsection">
        <div className="issue-subsection-title">Groups ({state.groups.length}) — resources bundled per dispatch key, not yet dispatched</div>
        {state.groups.length === 0 ? <span className="hcell-dim">empty</span> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Dispatch key</th><th>Members</th></tr></thead>
              <tbody>
                {state.groups.map(g => (
                  <tr key={g.dispatchKey}><td className="mono-small">{g.dispatchKey}</td><td className="mono-small">{g.members.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="issue-subsection">
        <div className="issue-subsection-title">Incidents ({state.incidents.length}) — last known state per resource, 24h TTL</div>
        {state.incidents.length === 0 ? <span className="hcell-dim">empty</span> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Resource key</th><th>Type</th><th>Severity</th><th>Cluster</th><th>TTL</th></tr></thead>
              <tbody>
                {state.incidents.map(inc => (
                  <tr key={inc.key}>
                    <td className="mono-small">{inc.key}</td>
                    <td>{inc.incident?.type ?? '—'}</td>
                    <td>{inc.incident?.severity ?? '—'}</td>
                    <td className="mono-small">{inc.incident?.clusterName ?? '—'}</td>
                    <td className="hcell-dim">{fmtTTLsec(inc.ttlSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="issue-subsection">
        <div className="issue-subsection-title">Attempts ({state.attempts.length}) — retry counters per resource</div>
        {state.attempts.length === 0 ? <span className="hcell-dim">empty</span> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Resource key</th><th>Attempts</th><th>TTL</th></tr></thead>
              <tbody>
                {state.attempts.map(a => (
                  <tr key={a.key}><td className="mono-small">{a.key}</td><td>{a.count}</td><td className="hcell-dim">{fmtTTLsec(a.ttlSec)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="issue-subsection">
        <div className="issue-subsection-title">Cooldowns ({state.cooldowns.length}) — resources on hold, won't be reclassified yet</div>
        {state.cooldowns.length === 0 ? <span className="hcell-dim">none</span> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Resource key</th><th>Remaining</th></tr></thead>
              <tbody>
                {state.cooldowns.map(c => (
                  <tr key={c.key}><td className="mono-small">{c.key}</td><td className="hcell-dim">{fmtTTLms(c.ttlMs)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="issue-subsection">
        <div className="issue-subsection-title">Locks ({state.locks.length}) — dispatch keys currently owned by an in-flight workflow</div>
        {state.locks.length === 0 ? <span className="hcell-dim">none</span> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Dispatch key</th><th>Owning workflow</th><th>Remaining</th></tr></thead>
              <tbody>
                {state.locks.map(l => (
                  <tr key={l.key}>
                    <td className="mono-small">{l.key}</td>
                    <td className="issue-id-chip" title={l.workflowId}>{l.workflowId?.slice(0, 8) ?? '—'}</td>
                    <td className="hcell-dim">{fmtTTLms(l.ttlMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// Live workflow page
export default function LiveWorkflowPage() {
  const [incidents, setIncidents] = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [search, setSearch]       = useState('')
  const [expanded, setExpanded]   = useState(null)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/live-workflows')
      .then(r => r.json())
      .then(d => { if (!cancelled) { if (d.error) setError(d.error); else setIncidents(d.items ?? []) } })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let es, cancelled = false
    openSSE('/api/live-workflows/stream').then(s => {
      if (cancelled) { s.close(); return }
      es = s
      es.onmessage = e => {
        const ev = JSON.parse(e.data)
        if (!ev.incident) return
        setIncidents(prev => {
          const exists = prev.some(x => x.incidentKey === ev.incident.incidentKey)
          if (exists) return prev.map(x => x.incidentKey === ev.incident.incidentKey ? ev.incident : x)
          return [ev.incident, ...prev]
        })
      }
    })
    return () => { cancelled = true; es?.close() }
  }, [])

  const q = search.trim().toLowerCase()
  const filteredIncidents = useMemo(() => !q ? incidents : incidents.filter(it =>
    [it.incidentKey, it.workflowId, it.resource?.kind, it.resource?.clusterName, it.resource?.namespace, it.resource?.name]
      .some(s => s?.toLowerCase().includes(q))
  ), [incidents, q])

  const workflows = useMemo(() => {
    const byId = new Map()
    for (const incident of filteredIncidents) {
      let wf = byId.get(incident.workflowId)
      if (!wf) {
        wf = { workflowId: incident.workflowId, dispatchKey: dispatchKeyOf(incident), startedAt: incident.startedAt, updatedAt: incident.updatedAt, finishedAt: incident.finishedAt, outcome: incident.outcome, incidents: [] }
        byId.set(incident.workflowId, wf)
      }
      if (new Date(incident.startedAt) < new Date(wf.startedAt)) wf.startedAt = incident.startedAt
      if (new Date(incident.updatedAt) > new Date(wf.updatedAt)) wf.updatedAt = incident.updatedAt
      if (incident.finishedAt && !wf.finishedAt) { wf.finishedAt = incident.finishedAt; wf.outcome = incident.outcome }
      wf.incidents.push(incident)
    }
    return [...byId.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  }, [filteredIncidents])

  return (
    <div className="issues-page">
      <div className="page-header">
        <div>
          <h2>Live Pipeline</h2>
          <p className="page-subtitle">Every workflow currently running (or recently finished) and exactly which incidents it contains — in-memory only, not saved anywhere</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {!loading && !error && <span className="esc-match-count">{workflows.length} workflow{workflows.length !== 1 ? 's' : ''} · {filteredIncidents.length} incident{filteredIncidents.length !== 1 ? 's' : ''}</span>}
          <div className="health-search-wrap">
            <span className="health-search-icon">⌕</span>
            <input className="health-search" placeholder="Search workflow, cluster, namespace, resource…"
              value={search} onChange={e => setSearch(e.target.value)} />
            {search && <button className="health-search-clear" onClick={() => setSearch('')}>✕</button>}
          </div>
        </div>
      </div>

      {loading && incidents.length === 0 && <div className="page-loading">Loading…</div>}
      {error && <div className="health-error">⚠ {error}</div>}

      {!loading && !error && workflows.length === 0 && (
        <div className="empty-page"><span style={{ fontSize: 48, opacity: .2 }}>✓</span><span>Nothing in flight — the pipeline is idle</span></div>
      )}

      {workflows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Dispatch key</th>
                <th>Clusters</th>
                <th>Incidents</th>
                <th>Outcome</th>
                <th>Started</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map(wf => (
                <WorkflowRow
                  key={wf.workflowId}
                  workflow={wf}
                  expanded={expanded === wf.workflowId}
                  onToggle={() => setExpanded(x => x === wf.workflowId ? null : wf.workflowId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="page-header" style={{ marginTop: 28 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>Short Memory</h2>
          <p className="page-subtitle">Redis-backed dispatch state — queue, locks, attempts, cooldowns — driving which incidents become a workflow above</p>
        </div>
      </div>
      <ShortMemorySection />
    </div>
  )
}

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, openSSE } from '../lib/api'
import { fmtDT } from '../utils/format'
import { ISSUE_STATUS } from '../constants'

const PAGE_SIZE = 25

const STATUS_FILTER_OPTS = [
  { value: '', label: 'All' },
  { value: 'awaiting_approval', label: 'Awaiting Approval' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'failed', label: 'Retrying' },
  { value: 'fixed', label: 'Fixed' },
]

// ── Timeline stage → icon/label ──────────────────────────────────────────────
function stageMeta(entry) {
  switch (entry.stage) {
    case 'detected':          return { icon: '●', cls: 'tl-info',    label: 'Detected' }
    case 'investigated':      return { icon: '🔎', cls: 'tl-info',    label: 'Investigated' }
    case 'awaiting_approval': return { icon: '⏳', cls: 'tl-warn',    label: 'Awaiting approval' }
    case 'approved':          return { icon: '✓', cls: 'tl-primary', label: 'Approved' }
    case 'escalated':         return { icon: '🚨', cls: 'tl-danger',  label: 'Escalated' }
    case 'resolved':          return { icon: '✓', cls: 'tl-success', label: 'Resolved' }
    case 'progress':
      if (entry.outcome === 'success') return { icon: '✓', cls: 'tl-primary', label: `Fix applied${entry.action ? `: ${entry.action}` : ''}` }
      if (entry.outcome === 'failed')  return { icon: '✗', cls: 'tl-danger',  label: `Fix failed${entry.action ? `: ${entry.action}` : ''}` }
      if (entry.outcome === 'blocked') return { icon: '⛔', cls: 'tl-warn',   label: `Blocked${entry.action ? `: ${entry.action}` : ''}` }
      if (entry.outcome === 'skipped') return { icon: '⤼', cls: 'tl-dim',    label: `Skipped${entry.action ? `: ${entry.action}` : ''}` }
      return { icon: '•', cls: 'tl-dim', label: entry.outcome ?? 'Progress' }
    default: return { icon: '•', cls: 'tl-dim', label: entry.stage ?? 'Update' }
  }
}

function StatusBadge({ status }) {
  const meta = ISSUE_STATUS[status] ?? { label: status ?? '—', color: 'dim' }
  return <span className={`issue-badge issue-badge-${meta.color}`}>{meta.label}</span>
}

// ── Detail panel — fetched lazily the first time a row is expanded ──────────
function IssueDetail({ id }) {
  const [detail,  setDetail]  = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [showLogs, setShowLogs] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    apiFetch(`/api/issues/${id}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { if (d.error) setError(d.error); else setDetail(d) } })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  if (loading) return <div className="issue-detail-loading">◌ Loading timeline…</div>
  if (error)   return <div className="issue-detail-loading">⚠ {error}</div>
  if (!detail) return null

  return (
    <div className="issue-detail">
      {detail.rca?.suspected_cause && (
        <div className="issue-rca">
          <strong>Root cause:</strong> {detail.rca.suspected_cause}
          {detail.rca.confidence != null && <span className="hcell-dim"> (confidence: {detail.rca.confidence})</span>}
        </div>
      )}

      <div className="issue-timeline">
        {detail.timeline.map((entry, i) => {
          const meta = stageMeta(entry)
          return (
            <div key={i} className="issue-tl-row">
              <span className={`issue-tl-icon ${meta.cls}`}>{meta.icon}</span>
              <span className="issue-tl-time hcell-dim">{fmtDT(entry.at)}</span>
              <span className="issue-tl-label">{meta.label}</span>
              {entry.note && <span className="issue-tl-note hcell-dim">— {entry.note}</span>}
            </div>
          )
        })}
      </div>

      {detail.approvals?.length > 0 && (
        <div className="issue-subsection">
          <div className="issue-subsection-title">Approval decisions</div>
          {detail.approvals.map((a, i) => (
            <div key={i} className="issue-subrow">
              <span className={`issue-decision issue-decision-${a.decision}`}>{a.decision}</span>
              <span className="hcell-dim">{a.decidedBy?.name ?? a.decidedBy?.email ?? 'system'}</span>
              <span className="hcell-dim">{fmtDT(a.createdAt)}</span>
              {a.adminNote && <span className="issue-tl-note hcell-dim">— {a.adminNote}</span>}
            </div>
          ))}
        </div>
      )}

      {detail.escalations?.length > 0 && (
        <div className="issue-subsection">
          <div className="issue-subsection-title">Escalations</div>
          {detail.escalations.map((e, i) => (
            <div key={i} className="issue-subrow">
              <span className="issue-decision issue-decision-escalated">{e.status}</span>
              {e.assignedTo?.name && <span className="hcell-dim">assigned to {e.assignedTo.name}</span>}
              <span className="hcell-dim">{fmtDT(e.createdAt ?? e.escalatedAt)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="issue-subsection">
        <button className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={() => setShowLogs(s => !s)}>
          {showLogs ? '▾' : '▸'} Related agent logs ({detail.relatedLogs?.length ?? 0})
        </button>
        {showLogs && (
          <pre className="issue-log-dump">
            {(detail.relatedLogs ?? []).length === 0
              ? 'No matching log lines found in the current buffer.'
              : detail.relatedLogs.map(l => `[${l.level}] ${fmtDT(l.timestamp)}  ${l.message}`).join('\n')}
          </pre>
        )}
      </div>
    </div>
  )
}

// ── Deep-linked issue — landed here via a link elsewhere (e.g. an approval card's
// issue id chip) with ?open=<seq>. Shown as its own pinned panel above the regular
// list/filters so the target issue is always visible regardless of what page, status
// tab, or search term the list underneath happens to be on. ─────────────────────
function DeepLinkedIssue({ seq, onDismiss }) {
  const [item,  setItem]  = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setItem(null); setError(null)
    apiFetch(`/api/issues/${seq}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { if (d.error) setError(d.error); else setItem(d) } })
      .catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [seq])

  return (
    <div className="issue-deeplink">
      <div className="issue-deeplink-head">
        <span className="issue-id-chip">#{seq}</span>
        {item && <StatusBadge status={item.status} />}
        {item && <span className="hcell-dim">{item.issueType ?? 'Unknown'} · {item.cluster ?? '—'}</span>}
        <button className="issue-deeplink-dismiss" onClick={onDismiss}>✕ Close</button>
      </div>
      {error
        ? <div className="issue-detail-loading">⚠ {error}</div>
        : <IssueDetail id={seq} />
      }
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function IssuesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const openSeq = searchParams.get('open')

  const [issues,   setIssues]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [total,    setTotal]    = useState(0)
  const [page,     setPage]     = useState(1)
  const [status,   setStatus]   = useState('')
  const [search,   setSearch]   = useState('')
  const [expanded, setExpanded] = useState(null) // seq of the currently open row

  const fetchIssues = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
      if (status) params.set('status', status)
      const res  = await apiFetch(`/api/issues?${params}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      setIssues(json.items ?? [])
      setTotal(json.total ?? 0)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }, [page, status])

  useEffect(() => { fetchIssues() }, [fetchIssues])

  // Live updates — upsert by seq. New/updated issues can arrive out of band while
  // the page is open; we merge them into the current page rather than refetching.
  useEffect(() => {
    let es, cancelled = false
    openSSE('/api/issues/stream').then(s => {
      if (cancelled) { s.close(); return }
      es = s
      es.onmessage = e => {
        const ev = JSON.parse(e.data)
        if (!ev.issue) return
        setIssues(prev => {
          const exists = prev.some(x => x.seq === ev.issue.seq)
          if (exists) return prev.map(x => x.seq === ev.issue.seq ? ev.issue : x)
          return page === 1 ? [ev.issue, ...prev].slice(0, PAGE_SIZE) : prev
        })
      }
    })
    return () => { cancelled = true; es?.close() }
  }, [page])

  const q = search.trim().toLowerCase()
  const visible = useMemo(() => !q ? issues : issues.filter(it =>
    [it.issueKey, it.issueType, it.cluster, it.namespace, it.resource].some(s => s?.toLowerCase().includes(q))
  ), [issues, q])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="issues-page">
      <div className="page-header">
        <div>
          <h2>Issue Tracking</h2>
          <p className="page-subtitle">Every detected error, its id, and what the agent did about it</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {!loading && !error && <span className="esc-match-count">{total} issue{total !== 1 ? 's' : ''}</span>}
          <div className="health-search-wrap">
            <span className="health-search-icon">⌕</span>
            <input className="health-search" placeholder="Search id, type, cluster, resource…"
              value={search} onChange={e => setSearch(e.target.value)} />
            {search && <button className="health-search-clear" onClick={() => setSearch('')}>✕</button>}
          </div>
          <button className="btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }}
            onClick={fetchIssues}>↻ Refresh</button>
        </div>
      </div>

      {openSeq && (
        <DeepLinkedIssue seq={openSeq} onDismiss={() => setSearchParams({}, { replace: true })} />
      )}

      <div className="health-view-tabs">
        {STATUS_FILTER_OPTS.map(o => (
          <button key={o.value}
            className={`hvtab${status === o.value ? ' hvtab-active' : ''}`}
            onClick={() => { setStatus(o.value); setPage(1) }}>
            {o.label}
          </button>
        ))}
      </div>

      {loading && issues.length === 0 && <div className="page-loading">Loading issues…</div>}
      {error && <div className="health-error">⚠ {error}</div>}

      {!loading && !error && visible.length === 0 && (
        <div className="empty-page"><span style={{ fontSize: 48, opacity: .2 }}>✓</span><span>No issues match</span></div>
      )}

      {visible.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Cluster</th>
                <th>Namespace</th>
                <th>Resource</th>
                <th>Status</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(it => (
                <Fragment key={it.seq}>
                  <tr className="issue-row" onClick={() => setExpanded(x => x === it.seq ? null : it.seq)}>
                    <td>
                      <span className={`hc-chevron issue-row-chevron${expanded === it.seq ? ' hc-chevron-open' : ''}`}>▶</span>
                      <span className="issue-id-chip">#{it.seq}</span>
                    </td>
                    <td>{it.issueType ?? '—'}</td>
                    <td>{it.cluster ?? '—'}</td>
                    <td className="mono-small">{it.namespace ?? '—'}</td>
                    <td className="mono-small">{it.resource ?? '—'}</td>
                    <td><StatusBadge status={it.status} /></td>
                    <td className="hcell-dim">{fmtDT(it.updatedAt ?? it.createdAt)}</td>
                  </tr>
                  {expanded === it.seq && (
                    <tr className="issue-detail-row">
                      <td colSpan={7}><IssueDetail id={it.seq} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && !q && (
        <div className="issue-pager">
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span className="hcell-dim">Page {page} / {totalPages}</span>
          <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}
    </div>
  )
}

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { sseUrl, apiFetch } from '../lib/api'
import { LOG_LEVELS } from '../constants'
import { LogRow } from '../components/Row'
import ApprovalCard from '../components/ApprovalCard'
import EscalationClaimCard from '../components/EscalationClaimCard'
import CommandChat from '../components/CommandChat'

const AGENT_DEFS = [
  { key: 'planner',    label: 'Planner',    icon: '🧠', color: 'primary' },
  { key: 'guardian',   label: 'Guardian',   icon: '🛡',  color: 'warn'    },
  { key: 'reflection', label: 'Reflection', icon: '💡', color: 'success' },
]
function fmtN(n) { return (n ?? 0).toLocaleString() }

export default function DashboardPage({ onCountsChange }) {
  const { user }                      = useAuth()
  const notify                        = useNotify()
  const [logs, setLogs]               = useState([])
  const [approvals, setApprovals]     = useState([])
  const [escalations, setEscalations] = useState([])
  const [connected, setConnected]     = useState(false)
  const [filter, setFilter]           = useState('ALL')
  const [search, setSearch]           = useState('')
  const [autoScroll, setAutoScroll]   = useState(true)
  const [rightTab, setRightTab]       = useState('approvals')
  const [tokens, setTokens]           = useState(null)
  const logEndRef    = useRef(null)
  const logScrollRef = useRef(null)
  const escSseReady  = useRef(false)

  // ── Logs SSE ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource(sseUrl('/api/logs/stream'))
    es.onopen    = () => setConnected(true)
    es.onerror   = () => setConnected(false)
    es.onmessage = e => {
      const entry = JSON.parse(e.data)
      setLogs(p => { const n = [...p, entry]; return n.length > 2000 ? n.slice(-2000) : n })
    }
    return () => es.close()
  }, [])

  // ── Approvals SSE ──────────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource(sseUrl('/api/approvals/stream'))
    es.onmessage = e => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'init')       setApprovals(ev.approvals)
      else if (ev.type === 'added')    { setApprovals(p => [...p, ev.approval]); notify('warn', `Approval needed: ${ev.approval.payload?.issueKey}`); if (user.role === 'admin') setRightTab('approvals') }
      else if (ev.type === 'resolved') setApprovals(p => p.filter(a => a.id !== ev.id))
    }
    return () => es.close()
  }, [notify, user.role])

  // ── Escalations SSE + HTTP fallback ───────────────────────────────────────
  useEffect(() => {
    apiFetch('/api/escalations').then(r => r.json()).then(data => {
      if (Array.isArray(data) && !escSseReady.current) setEscalations(data)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const es = new EventSource(sseUrl('/api/escalations/stream'))
    es.onmessage = e => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'init') {
        escSseReady.current = true
        setEscalations(ev.escalations)
      }
      else if (ev.type === 'added') {
        setEscalations(p => [...p, ev.escalation])
        notify('error', `Escalated: ${ev.escalation.issueKey}`)
        setRightTab('escalations')
      }
      else if (ev.type === 'updated') setEscalations(p => {
        const exists = p.some(x => x.id === ev.escalation.id)
        return exists ? p.map(x => x.id === ev.escalation.id ? ev.escalation : x) : [...p, ev.escalation]
      })
      else if (ev.type === 'resolved') setEscalations(p => p.filter(x => x.id !== ev.id))
    }
    return () => es.close()
  }, [notify])

  // ── Auto-scroll logs ───────────────────────────────────────────────────────
  useEffect(() => {
    if (autoScroll && logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const onLogScroll = useCallback(() => {
    const el = logScrollRef.current
    if (el) setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }, [])

  // ── Token usage polling ────────────────────────────────────────────────────
  const fetchTokens = useCallback(() => {
    apiFetch('/api/tokens').then(r => r.json()).then(setTokens).catch(() => {})
  }, [])
  useEffect(() => {
    fetchTokens()
    const id = setInterval(fetchTokens, 15_000)
    return () => clearInterval(id)
  }, [fetchTokens])

  const settleApproval = useCallback(id => setApprovals(p => p.filter(a => a.id !== id)), [])
  const removeEsc      = useCallback(id => setEscalations(p => p.filter(x => x.id !== id)), [])
  const pendingEsc     = escalations.filter(e => e.status === 'pending')

  useEffect(() => {
    onCountsChange?.({ approvals: approvals.length, unclaimed: pendingEsc.length })
  }, [approvals.length, pendingEsc.length, onCountsChange])

  const byLevel    = filter === 'ALL' ? logs : logs.filter(l => l.level === filter)
  const filtered   = search ? byLevel.filter(l => l.message.toLowerCase().includes(search.toLowerCase())) : byLevel
  const warnCount  = logs.filter(l => l.level === 'WARN').length
  const errorCount = logs.filter(l => l.level === 'ERROR').length

  return (
    <div className="dashboard-wrap">

      {/* ── Two-panel area ── */}
      <div className="body">

        {/* Left: logs */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Agent Logs</span>
            <div className="panel-actions">
              <span className="badge">{logs.length}</span>
              {warnCount  > 0 && <span className="badge warn">{warnCount}W</span>}
              {errorCount > 0 && <span className="badge error">{errorCount}E</span>}
              {!autoScroll && <button className="btn" onClick={() => setAutoScroll(true)}>↓ Follow</button>}
              <button className="btn" onClick={() => setLogs([])}>Clear</button>
            </div>
          </div>
          <div className="filter-bar">
            {LOG_LEVELS.map(lvl => (
              <button key={lvl} className={`filter-chip ${filter === lvl ? `active ${lvl}` : ''}`} onClick={() => setFilter(lvl)}>
                {lvl}
                {lvl === 'WARN'  && warnCount  > 0 && <span className="chip-count">{warnCount}</span>}
                {lvl === 'ERROR' && errorCount > 0 && <span className="chip-count">{errorCount}</span>}
              </button>
            ))}
            <div className="log-search-wrap">
              <span className="log-search-icon">⌕</span>
              <input
                className="log-search-input"
                placeholder="Search logs…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && <button className="log-search-clear" onClick={() => setSearch('')}>×</button>}
              {search && <span className="log-search-count">{filtered.length}</span>}
            </div>
          </div>
          <div className="log-scroll" ref={logScrollRef} onScroll={onLogScroll}>
            {filtered.length === 0
              ? <div className="log-empty">{search ? `No results for "${search}"` : `No ${filter === 'ALL' ? '' : filter + ' '}log entries yet…`}</div>
              : filtered.map(e => <LogRow key={e.id} entry={e} search={search} />)
            }
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Right: approvals / escalations / orders */}
        <div className="panel">
          <div className="tab-bar">
            <button className={`tab ${rightTab === 'approvals' ? 'active' : ''}`} onClick={() => setRightTab('approvals')}>
              Approvals {approvals.length > 0 && <span className="tab-badge warn">{approvals.length}</span>}
            </button>
            <button className={`tab ${rightTab === 'escalations' ? 'active' : ''}`} onClick={() => setRightTab('escalations')}>
              Unclaimed {pendingEsc.length > 0 && <span className="tab-badge danger">{pendingEsc.length}</span>}
            </button>
            <button className={`tab ${rightTab === 'chat' ? 'active' : ''}`} onClick={() => setRightTab('chat')}>
              Orders
            </button>
          </div>

          {rightTab === 'approvals' && (
            <div className="approvals-scroll">
              {approvals.length === 0
                ? <div className="approval-empty"><span className="approval-empty-icon">✓</span>No pending approvals</div>
                : approvals.map(a => <ApprovalCard key={a.id} approval={a} onSettle={settleApproval} />)
              }
            </div>
          )}

          {rightTab === 'escalations' && (
            <div className="approvals-scroll">
              {pendingEsc.length === 0
                ? <div className="approval-empty"><span className="approval-empty-icon">✓</span>No unclaimed escalations</div>
                : pendingEsc.map(x => <EscalationClaimCard key={x.id} item={x} onTake={removeEsc} />)
              }
            </div>
          )}

          {rightTab === 'chat' && <CommandChat />}
        </div>
      </div>

      {/* ── Token usage bar ── */}
      <TokenBar tokens={tokens} onRefresh={fetchTokens} isAdmin={user.role === 'admin'} />

    </div>
  )
}

// ── TokenBar component ────────────────────────────────────────────────────────
function TokenBar({ tokens, onRefresh, isAdmin }) {
  const [expanded, setExpanded] = useState(false)

  if (!tokens) return (
    <div className="token-bar">
      <span className="token-bar-title">⚡ Tokens</span>
      <span className="token-loading">loading…</span>
    </div>
  )

  const { agents, total } = tokens

  function handleReset() {
    if (!confirm('Reset token counters?')) return
    fetch('/api/tokens/reset', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('k8s_token')}` },
    }).then(() => onRefresh())
  }

  return (
    <div className="token-bar">
      <button className="token-bar-toggle" onClick={() => setExpanded(p => !p)}
        title={expanded ? 'Hide breakdown' : 'Show prompt / completion breakdown'}>
        ⚡ Tokens {expanded ? '▲' : '▼'}
      </button>

      {AGENT_DEFS.map(({ key, label, icon, color }) => {
        const c = agents[key] ?? { total: 0, calls: 0, prompt: 0, completion: 0 }
        return (
          <div key={key} className={`token-chip token-chip-${color}`}>
            <span className="token-chip-icon">{icon}</span>
            <span className="token-chip-name">{label}</span>
            <span className="token-chip-total">{fmtN(c.total)}</span>
            {expanded && <span className="token-chip-detail">{fmtN(c.prompt)}↑ {fmtN(c.completion)}↓</span>}
            <span className="token-chip-calls">{c.calls} calls</span>
          </div>
        )
      })}

      <div className="token-chip token-chip-grand">
        <span className="token-chip-icon">⊕</span>
        <span className="token-chip-name">Total</span>
        <span className="token-chip-total">{fmtN(total.total)}</span>
        {expanded && <span className="token-chip-detail">{fmtN(total.prompt)}↑ {fmtN(total.completion)}↓</span>}
        <span className="token-chip-calls">{total.calls} calls</span>
      </div>

      <div className="token-bar-actions">
        <button className="token-refresh-btn" onClick={onRefresh} title="Refresh now">↺</button>
        {isAdmin && <button className="token-reset-btn" onClick={handleReset}>Reset</button>}
      </div>
    </div>
  )
}

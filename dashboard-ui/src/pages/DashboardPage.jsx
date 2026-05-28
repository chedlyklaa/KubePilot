import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { sseUrl } from '../lib/api'
import { LOG_LEVELS } from '../constants'
import { LogRow } from '../components/Row'
import ApprovalCard from '../components/ApprovalCard'
import EscalationClaimCard from '../components/EscalationClaimCard'
import CommandChat from '../components/CommandChat'

export default function DashboardPage() {
  const { user }                      = useAuth()
  const notify                        = useNotify()
  const [logs, setLogs]               = useState([])
  const [approvals, setApprovals]     = useState([])
  const [escalations, setEscalations] = useState([])
  const [connected, setConnected]     = useState(false)
  const [filter, setFilter]           = useState('ALL')
  const [autoScroll, setAutoScroll]   = useState(true)
  const [rightTab, setRightTab]       = useState('approvals')
  const logEndRef    = useRef(null)
  const logScrollRef = useRef(null)

  useEffect(() => {
    const es = new EventSource(sseUrl('/api/logs/stream'))
    es.onopen  = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = e => {
      const entry = JSON.parse(e.data)
      setLogs(p => { const n = [...p, entry]; return n.length > 2000 ? n.slice(-2000) : n })
    }
    return () => es.close()
  }, [])

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

  useEffect(() => {
    const es = new EventSource(sseUrl('/api/escalations/stream'))
    es.onmessage = e => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'init')       setEscalations(ev.escalations)
      else if (ev.type === 'added')    { setEscalations(p => [...p, ev.escalation]); notify('error', `Escalated: ${ev.escalation.issueKey}`); setRightTab('escalations') }
      else if (ev.type === 'updated')  setEscalations(p => p.map(x => x.id === ev.escalation.id ? ev.escalation : x))
      else if (ev.type === 'resolved') setEscalations(p => p.filter(x => x.id !== ev.id))
    }
    return () => es.close()
  }, [notify])

  useEffect(() => {
    if (autoScroll && logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const onLogScroll = useCallback(() => {
    const el = logScrollRef.current
    if (el) setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }, [])

  const settleApproval = useCallback(id => setApprovals(p => p.filter(a => a.id !== id)), [])
  const removeEsc      = useCallback(id => setEscalations(p => p.filter(x => x.id !== id)), [])
  const pendingEsc     = escalations.filter(e => e.status === 'pending')
  const filtered       = filter === 'ALL' ? logs : logs.filter(l => l.level === filter)
  const warnCount      = logs.filter(l => l.level === 'WARN').length
  const errorCount     = logs.filter(l => l.level === 'ERROR').length

  return (
    <div className="body">
      {/* ── Left panel: logs ── */}
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
        </div>
        <div className="log-scroll" ref={logScrollRef} onScroll={onLogScroll}>
          {filtered.length === 0
            ? <div className="log-empty">No {filter === 'ALL' ? '' : filter + ' '}log entries yet…</div>
            : filtered.map(e => <LogRow key={e.id} entry={e} />)
          }
          <div ref={logEndRef} />
        </div>
      </div>

      {/* ── Right panel: approvals / escalations / orders ── */}
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
  )
}

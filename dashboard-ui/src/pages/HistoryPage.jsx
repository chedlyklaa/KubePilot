import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import { STATE_LABEL } from '../constants'
import AssignCell from '../components/AssignCell'
import FilterDrawer, { FilterSection, FilterChips, FilterUserList, FilterDateRange } from '../components/FilterDrawer'

const ALL_STATUSES   = ['pending', 'need_help', 'not_fixed', 'in_progress', 'acknowledged', 'fixed']
const STATUS_OPTS    = ALL_STATUSES.map(s => ({ value: s, label: STATE_LABEL[s] ?? s }))
const DECISION_OPTS  = [{ value: 'approved', label: 'Approved' }, { value: 'denied', label: 'Denied' }, { value: 'timeout', label: 'Timeout' }]
const RISK_OPTS      = [{ value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }]

const toDate  = () => new Date().toISOString().slice(0, 10)
const daysAgo = n => new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10)

const EMPTY_APPR = { decisions: [], risks: [], userIds: [], dateFrom: '', dateTo: '' }
const EMPTY_ESC  = { statuses: [],  userIds: [], dateFrom: '', dateTo: '' }

export default function HistoryPage() {
  const { user }                          = useAuth()
  const [tab,         setTab]             = useState('approvals')
  const [approvals,   setApprovals]       = useState([])
  const [escalations, setEscalations]     = useState([])
  const [users,       setUsers]           = useState([])
  const [loading,     setLoading]         = useState(true)
  const [drawerOpen,  setDrawerOpen]      = useState(false)

  // Approval filters
  const [apprFilters,     setApprFilters]     = useState(EMPTY_APPR)
  const [apprDatePreset,  setApprDatePreset]  = useState('all')
  // Escalation filters
  const [escFilters,      setEscFilters]      = useState(EMPTY_ESC)
  const [escDatePreset,   setEscDatePreset]   = useState('all')

  useEffect(() => {
    setLoading(true)
    const reqs = [
      apiFetch('/api/history/approvals').then(r => r.json()),
      apiFetch('/api/history/escalations').then(r => r.json()),
    ]
    if (user.role === 'admin') reqs.push(apiFetch('/api/users').then(r => r.json()))
    Promise.all(reqs).then(([a, e, u]) => {
      setApprovals(a); setEscalations(e)
      if (u) setUsers(u.filter(x => x.active))
      setLoading(false)
    })
  }, [user.role])

  function updateAssigned(recordId, assignedTo) {
    setEscalations(p => p.map(e => e._id === recordId ? { ...e, assignedTo } : e))
  }

  // ── Generic toggle helper ─────────────────────────────────────────────────
  const toggleAppr = key => val =>
    setApprFilters(f => ({ ...f, [key]: f[key].includes(val) ? f[key].filter(x => x !== val) : [...f[key], val] }))

  const toggleEsc = key => val =>
    setEscFilters(f => ({ ...f, [key]: f[key].includes(val) ? f[key].filter(x => x !== val) : [...f[key], val] }))

  // ── Date preset helpers ───────────────────────────────────────────────────
  function applyApprPreset(preset) {
    setApprDatePreset(preset)
    if      (preset === 'today') setApprFilters(f => ({ ...f, dateFrom: toDate(),    dateTo: toDate() }))
    else if (preset === '7d')    setApprFilters(f => ({ ...f, dateFrom: daysAgo(7),  dateTo: toDate() }))
    else if (preset === '30d')   setApprFilters(f => ({ ...f, dateFrom: daysAgo(30), dateTo: toDate() }))
    else                         setApprFilters(f => ({ ...f, dateFrom: '',          dateTo: '' }))
  }
  function setApprDateFrom(val) { setApprDatePreset('custom'); setApprFilters(f => ({ ...f, dateFrom: val })) }
  function setApprDateTo(val)   { setApprDatePreset('custom'); setApprFilters(f => ({ ...f, dateTo:   val })) }

  function applyEscPreset(preset) {
    setEscDatePreset(preset)
    if      (preset === 'today') setEscFilters(f => ({ ...f, dateFrom: toDate(),    dateTo: toDate() }))
    else if (preset === '7d')    setEscFilters(f => ({ ...f, dateFrom: daysAgo(7),  dateTo: toDate() }))
    else if (preset === '30d')   setEscFilters(f => ({ ...f, dateFrom: daysAgo(30), dateTo: toDate() }))
    else                         setEscFilters(f => ({ ...f, dateFrom: '',          dateTo: '' }))
  }
  function setEscDateFrom(val) { setEscDatePreset('custom'); setEscFilters(f => ({ ...f, dateFrom: val })) }
  function setEscDateTo(val)   { setEscDatePreset('custom'); setEscFilters(f => ({ ...f, dateTo:   val })) }

  // ── Active filter counts ──────────────────────────────────────────────────
  const apprActiveCount =
    (apprFilters.decisions.length > 0 ? 1 : 0) +
    (apprFilters.risks.length     > 0 ? 1 : 0) +
    (apprFilters.userIds.length   > 0 ? 1 : 0) +
    ((apprFilters.dateFrom || apprFilters.dateTo) ? 1 : 0)

  const escActiveCount =
    (escFilters.statuses.length > 0 ? 1 : 0) +
    (escFilters.userIds.length  > 0 ? 1 : 0) +
    ((escFilters.dateFrom || escFilters.dateTo) ? 1 : 0)

  const activeCount = tab === 'approvals' ? apprActiveCount : escActiveCount

  function clearFilters() {
    if (tab === 'approvals') { setApprFilters(EMPTY_APPR); setApprDatePreset('all') }
    else                     { setEscFilters(EMPTY_ESC);   setEscDatePreset('all') }
  }

  // ── Filtered data ─────────────────────────────────────────────────────────
  const visibleApprovals = useMemo(() => {
    let r = approvals
    if (apprFilters.decisions.length > 0) r = r.filter(a => apprFilters.decisions.includes(a.decision))
    if (apprFilters.risks.length     > 0) r = r.filter(a => apprFilters.risks.includes(a.diagnosis?.risk))
    if (apprFilters.userIds.length   > 0) r = r.filter(a => apprFilters.userIds.includes(a.decidedBy?.userId ?? '__unassigned__'))
    if (apprFilters.dateFrom) r = r.filter(a => new Date(a.createdAt).toISOString().slice(0, 10) >= apprFilters.dateFrom)
    if (apprFilters.dateTo)   r = r.filter(a => new Date(a.createdAt).toISOString().slice(0, 10) <= apprFilters.dateTo)
    return r
  }, [approvals, apprFilters])

  const visibleEscalations = useMemo(() => {
    let r = escalations
    if (escFilters.statuses.length > 0) r = r.filter(e => escFilters.statuses.includes(e.status))
    if (escFilters.userIds.length  > 0) r = r.filter(e => escFilters.userIds.includes(e.assignedTo?.userId ?? '__unassigned__'))
    if (escFilters.dateFrom) r = r.filter(e => new Date(e.escalatedAt).toISOString().slice(0, 10) >= escFilters.dateFrom)
    if (escFilters.dateTo)   r = r.filter(e => new Date(e.escalatedAt).toISOString().slice(0, 10) <= escFilters.dateTo)
    return r
  }, [escalations, escFilters])

  const totalShown = tab === 'approvals' ? approvals.length    : escalations.length
  const nowShown   = tab === 'approvals' ? visibleApprovals.length : visibleEscalations.length

  if (loading) return <div className="page-loading">Loading history…</div>

  return (
    <div className="history-page">
      <div className="page-header">
        <div><h2>History</h2><p className="page-subtitle">Full audit trail of all agent decisions</p></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {activeCount > 0 && (
            <span className="esc-match-count">{nowShown} / {totalShown} shown</span>
          )}
          <button
            className={`btn-filter${activeCount > 0 ? ' has-filters' : ''}`}
            onClick={() => setDrawerOpen(true)}
          >
            ⚙ Filters {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
          </button>
        </div>
      </div>

      {/* ── Filter drawer ───────────────────────────────────────────────── */}
      <FilterDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} count={activeCount} onClear={clearFilters}>
        {tab === 'approvals' ? (
          <>
            <FilterSection label="Decision">
              <FilterChips options={DECISION_OPTS} selected={apprFilters.decisions} onToggle={toggleAppr('decisions')} />
            </FilterSection>
            <FilterSection label="Risk">
              <FilterChips options={RISK_OPTS} selected={apprFilters.risks} onToggle={toggleAppr('risks')} colorClass />
            </FilterSection>
            {user.role === 'admin' && (
              <FilterSection label="Decided By">
                <FilterUserList
                  users={users}
                  selectedIds={apprFilters.userIds}
                  onToggle={toggleAppr('userIds')}
                  onClearAll={() => setApprFilters(f => ({ ...f, userIds: [] }))}
                />
              </FilterSection>
            )}
            <FilterSection label="Period">
              <FilterDateRange
                preset={apprDatePreset} onPreset={applyApprPreset}
                dateFrom={apprFilters.dateFrom} dateTo={apprFilters.dateTo}
                onDateFrom={setApprDateFrom}    onDateTo={setApprDateTo}
              />
            </FilterSection>
          </>
        ) : (
          <>
            <FilterSection label="Status">
              <FilterChips options={STATUS_OPTS} selected={escFilters.statuses} onToggle={toggleEsc('statuses')} colorClass />
            </FilterSection>
            {user.role === 'admin' && (
              <FilterSection label="Handled By">
                <FilterUserList
                  users={users}
                  selectedIds={escFilters.userIds}
                  onToggle={toggleEsc('userIds')}
                  onClearAll={() => setEscFilters(f => ({ ...f, userIds: [] }))}
                />
              </FilterSection>
            )}
            <FilterSection label="Period">
              <FilterDateRange
                preset={escDatePreset} onPreset={applyEscPreset}
                dateFrom={escFilters.dateFrom} dateTo={escFilters.dateTo}
                onDateFrom={setEscDateFrom}    onDateTo={setEscDateTo}
              />
            </FilterSection>
          </>
        )}
      </FilterDrawer>

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="tab-bar-flat">
        <button className={`tab-flat${tab === 'approvals' ? ' active' : ''}`} onClick={() => setTab('approvals')}>
          Approvals ({approvals.length})
        </button>
        <button className={`tab-flat${tab === 'escalations' ? ' active' : ''}`} onClick={() => setTab('escalations')}>
          Escalations ({escalations.length})
        </button>
      </div>

      {/* ── Approvals table ─────────────────────────────────────────────── */}
      {tab === 'approvals' && (
        <div className="table-wrap">
          {approvals.length === 0
            ? <div className="empty-state">No approval history yet</div>
            : visibleApprovals.length === 0
              ? <div className="empty-page"><span style={{ fontSize: 32, opacity: .2 }}>⊘</span><span>No approvals match the current filters</span></div>
              : <table className="data-table">
                  <thead><tr><th>Issue</th><th>Action</th><th>Risk</th><th>Decision</th><th>Decided By</th><th>When</th></tr></thead>
                  <tbody>
                    {visibleApprovals.map(a => (
                      <tr key={a._id}>
                        <td className="mono-small">{a.issueKey}</td>
                        <td>{a.diagnosis?.action ?? '—'}</td>
                        <td><span className={`card-risk ${a.diagnosis?.risk}`}>{a.diagnosis?.risk ?? '—'}</span></td>
                        <td><span className={`decision-badge decision-${a.decision}`}>{a.decision}</span></td>
                        <td>
                          {a.decidedBy
                            ? <span>{a.decidedBy.name} <span className={`role-badge role-${a.decidedBy.role}`}>{a.decidedBy.role}</span></span>
                            : <span className="text-dim">timeout</span>
                          }
                        </td>
                        <td className="text-dim">{fmtDT(a.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          }
        </div>
      )}

      {/* ── Escalations table ───────────────────────────────────────────── */}
      {tab === 'escalations' && (
        <div className="table-wrap">
          {escalations.length === 0
            ? <div className="empty-state">No escalation history yet</div>
            : visibleEscalations.length === 0
              ? <div className="empty-page"><span style={{ fontSize: 32, opacity: .2 }}>⊘</span><span>No escalations match the current filters</span></div>
              : <table className="data-table">
                  <thead>
                    <tr>
                      <th>Issue</th><th>Attempts</th><th>Status</th>
                      <th>Handled By {user.role === 'admin' && <span className="col-hint"> (click to change)</span>}</th>
                      <th>Escalated At</th><th>Last Update</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEscalations.map(e => (
                      <tr key={e._id}>
                        <td className="mono-small">{e.issueKey}</td>
                        <td style={{ textAlign: 'center' }}>{e.attempts}</td>
                        <td><span className={`state-badge state-${e.status}`}>{STATE_LABEL[e.status] ?? e.status}</span></td>
                        <td><AssignCell record={e} users={users} onAssigned={updateAssigned} /></td>
                        <td className="text-dim">{fmtDT(e.escalatedAt)}</td>
                        <td className="text-dim">
                          {e.stateUpdatedAt
                            ? <span>{fmtDT(e.stateUpdatedAt)}{e.stateUpdatedBy?.name && <span className="update-by"> by {e.stateUpdatedBy.name}</span>}</span>
                            : '—'
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          }
        </div>
      )}
    </div>
  )
}

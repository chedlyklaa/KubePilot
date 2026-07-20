import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import { STATE_LABEL } from '../constants'
import AssignCell from '../components/AssignCell'
import FilterDrawer, { FilterSection, FilterChips, FilterUserList, FilterDateRange } from '../components/FilterDrawer'
import { useFilters } from '../hooks/useFilters'

const ALL_STATUSES   = ['pending', 'need_help', 'not_fixed', 'in_progress', 'acknowledged', 'fixed']
const STATUS_OPTS    = ALL_STATUSES.map(s => ({ value: s, label: STATE_LABEL[s] ?? s }))
const DECISION_OPTS  = [{ value: 'approved', label: 'Approved' }, { value: 'denied', label: 'Denied' }, { value: 'silenced', label: 'Silenced' }, { value: 'timeout', label: 'Timeout' }]
const RISK_OPTS      = [{ value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }]

const EMPTY_APPR = { decisions: [], risks: [], userIds: [], dateFrom: '', dateTo: '' }
const EMPTY_ESC  = { statuses: [],  userIds: [], dateFrom: '', dateTo: '' }
const PAGE_SIZE  = 20

export default function HistoryPage() {
  const { user }                          = useAuth()
  const [tab,         setTab]             = useState('approvals')
  const [data,        setData]            = useState(null)   // { docs, total, page, pages } for the active tab
  const [users,       setUsers]           = useState([])
  const [loading,     setLoading]         = useState(true)
  const [drawerOpen,  setDrawerOpen]      = useState(false)
  const [page,        setPage]            = useState(1)
  // True totals per tab, independent of filters/page — fixes the tab badge showing
  // only the current (paginated) fetch size instead of the real record count.
  const [counts,      setCounts]          = useState({ approvals: 0, escalations: 0 })

  // Approval filters
  const {
    filters: apprFilters, setFilters: setApprFilters, toggle: toggleAppr, clear: clearApprFilters,
    activeCount: apprActiveCount, datePreset: apprDatePreset, applyPreset: applyApprPreset,
    setDateFrom: setApprDateFrom, setDateTo: setApprDateTo,
  } = useFilters(EMPTY_APPR, { withDatePreset: true })
  // Escalation filters
  const {
    filters: escFilters, setFilters: setEscFilters, toggle: toggleEsc, clear: clearEscFilters,
    activeCount: escActiveCount, datePreset: escDatePreset, applyPreset: applyEscPreset,
    setDateFrom: setEscDateFrom, setDateTo: setEscDateTo,
  } = useFilters(EMPTY_ESC, { withDatePreset: true })

  useEffect(() => {
    apiFetch('/api/users/members').then(r => r.json()).then(u => setUsers(Array.isArray(u) ? u : [])).catch(() => {})
    apiFetch('/api/history/counts').then(r => r.json()).then(setCounts).catch(() => {})
  }, [])

  // Reset to page 1 whenever the tab or the active filter set changes — otherwise
  // switching tabs or narrowing a filter could strand the user on a now-empty page.
  useEffect(() => { setPage(1) }, [tab, apprFilters, escFilters])

  const load = useCallback(() => {
    setLoading(true)
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
    if (tab === 'approvals') {
      apprFilters.decisions.forEach(v => qs.append('decision', v))
      apprFilters.risks.forEach(v => qs.append('risk', v))
      apprFilters.userIds.forEach(v => qs.append('userId', v))
      if (apprFilters.dateFrom) qs.set('dateFrom', apprFilters.dateFrom)
      if (apprFilters.dateTo)   qs.set('dateTo', apprFilters.dateTo)
    } else {
      escFilters.statuses.forEach(v => qs.append('status', v))
      escFilters.userIds.forEach(v => qs.append('userId', v))
      if (escFilters.dateFrom) qs.set('dateFrom', escFilters.dateFrom)
      if (escFilters.dateTo)   qs.set('dateTo', escFilters.dateTo)
    }
    apiFetch(`/api/history/${tab}?${qs}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [tab, page, apprFilters, escFilters])

  useEffect(() => { load() }, [load])

  function updateAssigned(recordId, assignedTo) {
    setData(d => d ? { ...d, docs: d.docs.map(e => e._id === recordId ? { ...e, assignedTo } : e) } : d)
  }

  const activeCount = tab === 'approvals' ? apprActiveCount : escActiveCount

  function clearFilters() {
    if (tab === 'approvals') clearApprFilters()
    else                     clearEscFilters()
  }

  const docs       = data?.docs ?? []
  const totalPages = data?.pages ?? 1
  const nowShown   = data?.total ?? 0
  const totalShown = tab === 'approvals' ? counts.approvals : counts.escalations

  if (loading && !data) return <div className="page-loading">Loading history…</div>

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
            <FilterSection label="Decided By">
              <FilterUserList
                users={users}
                selectedIds={apprFilters.userIds}
                onToggle={toggleAppr('userIds')}
                onClearAll={() => setApprFilters(f => ({ ...f, userIds: [] }))}
              />
            </FilterSection>
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
            <FilterSection label="Handled By">
              <FilterUserList
                users={users}
                selectedIds={escFilters.userIds}
                onToggle={toggleEsc('userIds')}
                onClearAll={() => setEscFilters(f => ({ ...f, userIds: [] }))}
              />
            </FilterSection>
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
          Approvals ({counts.approvals})
        </button>
        <button className={`tab-flat${tab === 'escalations' ? ' active' : ''}`} onClick={() => setTab('escalations')}>
          Escalations ({counts.escalations})
        </button>
      </div>

      {/* ── Approvals table ─────────────────────────────────────────────── */}
      {tab === 'approvals' && (
        <div className="table-wrap">
          {counts.approvals === 0
            ? <div className="empty-state">No approval history yet</div>
            : docs.length === 0
              ? <div className="empty-page"><span style={{ fontSize: 32, opacity: .2 }}>⊘</span><span>No approvals match the current filters</span></div>
              : <>
                  <table className="data-table">
                    <thead><tr><th>Issue</th><th>Action</th><th>Risk</th><th>Decision</th><th>Decided By</th><th>When</th></tr></thead>
                    <tbody>
                      {docs.map(a => (
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
                  <div className="nc-pagination">
                    <button className="nc-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
                    <span className="nc-page-info">Page {page} of {totalPages} ({nowShown} total)</span>
                    <button className="nc-page-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next ›</button>
                  </div>
                </>
          }
        </div>
      )}

      {/* ── Escalations table ───────────────────────────────────────────── */}
      {tab === 'escalations' && (
        <div className="table-wrap">
          {counts.escalations === 0
            ? <div className="empty-state">No escalation history yet</div>
            : docs.length === 0
              ? <div className="empty-page"><span style={{ fontSize: 32, opacity: .2 }}>⊘</span><span>No escalations match the current filters</span></div>
              : <>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Issue</th><th>Attempts</th><th>Status</th>
                        <th>Handled By {user.role === 'admin' && <span className="col-hint"> (click to change)</span>}</th>
                        <th>Escalated At</th><th>Last Update</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docs.map(e => (
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
                  <div className="nc-pagination">
                    <button className="nc-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
                    <span className="nc-page-info">Page {page} of {totalPages} ({nowShown} total)</span>
                    <button className="nc-page-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next ›</button>
                  </div>
                </>
          }
        </div>
      )}
    </div>
  )
}

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch, sseUrl } from '../lib/api'
import { STATE_LABEL } from '../constants'
import EscalationRow from '../components/EscalationRow'
import FilterDrawer, { FilterSection, FilterChips, FilterUserList, FilterDateRange } from '../components/FilterDrawer'

const STATUS_ORDER = { pending: 0, need_help: 1, not_fixed: 2, in_progress: 3, acknowledged: 4, fixed: 5 }
const ALL_STATUSES = ['pending', 'need_help', 'not_fixed', 'in_progress', 'acknowledged', 'fixed']
const STATUS_OPTS  = ALL_STATUSES.map(s => ({ value: s, label: STATE_LABEL[s] ?? s }))

const toDate   = () => new Date().toISOString().slice(0, 10)
const daysAgo  = n  => new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10)

const EMPTY_FILTERS = { statuses: [], userIds: [], dateFrom: '', dateTo: '' }

export default function EscalationsPage() {
  const { user }                      = useAuth()
  const notify                        = useNotify()
  const [escalations, setEscalations] = useState([])
  const [users,  setUsers]            = useState([])
  const [sort,   setSort]             = useState({ key: null, dir: 'asc' })
  const [filters, setFilters]         = useState(EMPTY_FILTERS)
  const [datePreset, setDatePreset]   = useState('all')
  const [drawerOpen, setDrawerOpen]   = useState(false)
  const escSseReady = useRef(false)

  useEffect(() => {
    // HTTP pre-load while SSE is connecting — skipped if SSE init already fired.
    apiFetch('/api/escalations').then(r => r.json()).then(d => {
      if (Array.isArray(d) && !escSseReady.current) setEscalations(d)
    })
    if (user.role === 'admin') {
      apiFetch('/api/users').then(r => r.json()).then(d => { if (Array.isArray(d)) setUsers(d.filter(u => u.active)) })
    }
  }, [user.role])

  useEffect(() => {
    const es = new EventSource(sseUrl('/api/escalations/stream'))
    es.onmessage = e => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'init') {
        escSseReady.current = true
        setEscalations(ev.escalations)
      }
      else if (ev.type === 'added')    { setEscalations(p => [...p, ev.escalation]); notify('error', `New escalation: ${ev.escalation.issueKey}`) }
      else if (ev.type === 'updated')  setEscalations(p => {
        // Upsert: if the item arrived before our init (reconnect scenario), add it
        const exists = p.some(x => x.id === ev.escalation.id)
        return exists ? p.map(x => x.id === ev.escalation.id ? ev.escalation : x) : [...p, ev.escalation]
      })
      else if (ev.type === 'resolved') setEscalations(p => p.filter(x => x.id !== ev.id))
    }
    return () => es.close()
  }, [notify])

  const remove   = useCallback(id => setEscalations(p => p.filter(x => x.id !== id)), [])
  const pending  = escalations.filter(e => e.status === 'pending').length
  const needHelp = escalations.filter(e => e.status === 'need_help').length

  // ── Sort ──────────────────────────────────────────────────────────────────
  function toggleSort(key) {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' })
  }

  // ── Filter helpers ────────────────────────────────────────────────────────
  const toggle = key => val =>
    setFilters(f => ({ ...f, [key]: f[key].includes(val) ? f[key].filter(x => x !== val) : [...f[key], val] }))

  function applyPreset(preset) {
    setDatePreset(preset)
    if      (preset === 'today') setFilters(f => ({ ...f, dateFrom: toDate(),    dateTo: toDate() }))
    else if (preset === '7d')    setFilters(f => ({ ...f, dateFrom: daysAgo(7),  dateTo: toDate() }))
    else if (preset === '30d')   setFilters(f => ({ ...f, dateFrom: daysAgo(30), dateTo: toDate() }))
    else                         setFilters(f => ({ ...f, dateFrom: '',          dateTo: '' }))
  }

  function setDateFrom(val) { setDatePreset('custom'); setFilters(f => ({ ...f, dateFrom: val })) }
  function setDateTo(val)   { setDatePreset('custom'); setFilters(f => ({ ...f, dateTo:   val })) }

  function clearFilters() { setFilters(EMPTY_FILTERS); setDatePreset('all') }

  const activeCount =
    (filters.statuses.length > 0 ? 1 : 0) +
    (filters.userIds.length  > 0 ? 1 : 0) +
    ((filters.dateFrom || filters.dateTo) ? 1 : 0)

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const visibleEscalations = useMemo(() => {
    let result = escalations
    if (filters.statuses.length > 0) result = result.filter(e => filters.statuses.includes(e.status))
    if (filters.userIds.length  > 0) result = result.filter(e => filters.userIds.includes(e.assignedTo?.userId ?? '__unassigned__'))
    if (filters.dateFrom) result = result.filter(e => new Date(e.createdAt).toISOString().slice(0, 10) >= filters.dateFrom)
    if (filters.dateTo)   result = result.filter(e => new Date(e.createdAt).toISOString().slice(0, 10) <= filters.dateTo)

    if (!sort.key) return result
    return [...result].sort((a, b) => {
      let va, vb
      if (sort.key === 'status')   { va = STATUS_ORDER[a.status] ?? 99; vb = STATUS_ORDER[b.status] ?? 99 }
      if (sort.key === 'assignee') { va = (a.assignedTo?.name ?? '').toLowerCase(); vb = (b.assignedTo?.name ?? '').toLowerCase() }
      if (sort.key === 'date')     { va = new Date(a.createdAt).getTime(); vb = new Date(b.createdAt).getTime() }
      return va < vb ? (sort.dir === 'asc' ? -1 : 1) : va > vb ? (sort.dir === 'asc' ? 1 : -1) : 0
    })
  }, [escalations, filters, sort])

  const SortIcon = ({ col }) => sort.key === col
    ? <span className="sort-active">{sort.dir === 'asc' ? '▲' : '▼'}</span>
    : <span className="sort-idle">⇅</span>

  return (
    <div className="escalations-page">
      <div className="page-header">
        <div>
          <h2>Escalations</h2>
          <p className="page-subtitle">Manage issues the agent could not resolve automatically</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {activeCount > 0 && (
            <span className="esc-match-count">{visibleEscalations.length} / {escalations.length} shown</span>
          )}
          {pending  > 0 && <span className="stat-chip chip-warn">{pending} Unclaimed</span>}
          {needHelp > 0 && <span className="stat-chip chip-danger">{needHelp} Need Help</span>}
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
        <FilterSection label="Status">
          <FilterChips options={STATUS_OPTS} selected={filters.statuses} onToggle={toggle('statuses')} colorClass />
        </FilterSection>

        {user.role === 'admin' && (
          <FilterSection label="Handled By">
            <FilterUserList
              users={users}
              selectedIds={filters.userIds}
              onToggle={toggle('userIds')}
              onClearAll={() => setFilters(f => ({ ...f, userIds: [] }))}
            />
          </FilterSection>
        )}

        <FilterSection label="Period">
          <FilterDateRange
            preset={datePreset}
            onPreset={applyPreset}
            dateFrom={filters.dateFrom}
            dateTo={filters.dateTo}
            onDateFrom={setDateFrom}
            onDateTo={setDateTo}
          />
        </FilterSection>
      </FilterDrawer>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      {escalations.length === 0
        ? <div className="empty-page"><span style={{ fontSize: 48, opacity: .2 }}>✓</span><span>No active escalations</span></div>
        : visibleEscalations.length === 0
          ? <div className="empty-page"><span style={{ fontSize: 32, opacity: .2 }}>⊘</span><span>No escalations match the current filters</span></div>
          : <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Namespace</th>
                    <th>Attempts</th>
                    <th className="th-sortable" onClick={() => toggleSort('status')}>Status <SortIcon col="status" /></th>
                    <th className="th-sortable" onClick={() => toggleSort('assignee')}>Handled By <SortIcon col="assignee" /></th>
                    {user.role === 'admin' && <th>Reassign</th>}
                    <th className="th-sortable" onClick={() => toggleSort('date')}>Escalated At <SortIcon col="date" /></th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEscalations.map(e => (
                    <EscalationRow key={e.id} item={e} onRemove={remove} users={users} />
                  ))}
                </tbody>
              </table>
            </div>
      }
    </div>
  )
}

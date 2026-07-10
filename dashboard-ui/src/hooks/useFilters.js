import { useState, useCallback } from 'react'

// Extracted from EscalationsPage.jsx, HistoryPage.jsx (used twice, once per tab), and
// ClusterHealthPage.jsx, which each hand-rolled their own near-identical copy of this
// filter-state management (~150 duplicated lines total).

const toDate  = () => new Date().toISOString().slice(0, 10)
const daysAgo = n  => new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10)

/**
 * Generic filter-state hook: toggling array-valued fields, an active-filter count, and
 * (opt-in) date-range preset helpers.
 *
 * @param {object} emptyState - the filters object's initial/cleared shape.
 * @param {object} [opts]
 * @param {boolean} [opts.withDatePreset] - also return datePreset state plus
 *   applyPreset/setDateFrom/setDateTo, operating on `dateFrom`/`dateTo` fields.
 *
 * Array-valued fields are toggled via toggle(key)(value); anything else (booleans,
 * plain values) can be set directly via the returned setFilters.
 */
export function useFilters(emptyState, { withDatePreset = false } = {}) {
  const [filters, setFilters] = useState(emptyState)
  const [datePreset, setDatePreset] = useState('all')

  const toggle = useCallback(key => val =>
    setFilters(f => ({
      ...f,
      [key]: f[key].includes(val) ? f[key].filter(x => x !== val) : [...f[key], val],
    })), [])

  const applyPreset = useCallback(preset => {
    setDatePreset(preset)
    if      (preset === 'today') setFilters(f => ({ ...f, dateFrom: toDate(),   dateTo: toDate() }))
    else if (preset === '7d')    setFilters(f => ({ ...f, dateFrom: daysAgo(7),  dateTo: toDate() }))
    else if (preset === '30d')   setFilters(f => ({ ...f, dateFrom: daysAgo(30), dateTo: toDate() }))
    else                         setFilters(f => ({ ...f, dateFrom: '',         dateTo: '' }))
  }, [])

  const setDateFrom = useCallback(val => { setDatePreset('custom'); setFilters(f => ({ ...f, dateFrom: val })) }, [])
  const setDateTo   = useCallback(val => { setDatePreset('custom'); setFilters(f => ({ ...f, dateTo:   val })) }, [])

  const clear = useCallback(() => { setFilters(emptyState); setDatePreset('all') }, [emptyState])

  // Sums how many filter fields are "active": a non-empty array counts as 1, a truthy
  // scalar (boolean/string) counts as 1, dateFrom/dateTo together count as at most 1.
  const activeCount = Object.entries(filters).reduce((count, [key, val]) => {
    if (key === 'dateFrom' || key === 'dateTo') return count // handled once below
    if (Array.isArray(val)) return count + (val.length > 0 ? 1 : 0)
    return count + (val ? 1 : 0)
  }, 0) + (withDatePreset && (filters.dateFrom || filters.dateTo) ? 1 : 0)

  return {
    filters, setFilters, toggle, clear, activeCount,
    ...(withDatePreset ? { datePreset, applyPreset, setDateFrom, setDateTo } : {}),
  }
}

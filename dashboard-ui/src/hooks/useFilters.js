import { useState, useCallback } from 'react'

// Today's date as YYYY-MM-DD
const toDate  = () => new Date().toISOString().slice(0, 10)
const daysAgo = n  => new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10)

// Manage filter state and date presets
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

  const activeCount = Object.entries(filters).reduce((count, [key, val]) => {
    if (key === 'dateFrom' || key === 'dateTo') return count
    if (Array.isArray(val)) return count + (val.length > 0 ? 1 : 0)
    return count + (val ? 1 : 0)
  }, 0) + (withDatePreset && (filters.dateFrom || filters.dateTo) ? 1 : 0)

  return {
    filters, setFilters, toggle, clear, activeCount,
    ...(withDatePreset ? { datePreset, applyPreset, setDateFrom, setDateTo } : {}),
  }
}

import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'

// Extracted from AutoscalingPage.jsx, ExtensionsPage.jsx, PoliciesPage.jsx, CapacityPage.jsx,
// and RbacPage.jsx, which each hand-rolled their own near-identical copy of "fetch clusters,
// pick a default" — and inconsistently: some defaulted to the first cluster in the list
// regardless of what's actually active, and some didn't filter out unmonitored contexts.
//
// This hook standardizes both: only clusters KubePilot actually monitors are ever offered
// (an unmanaged context showing up in a picker isn't actionable — there's no agent watching
// it), and the default selection is whichever context is currently active in kubectl
// (isCurrent), not just whichever happens to sort first.
export function useMonitoredClusters() {
  const [clusters, setClusters] = useState([])
  const [selected, setSelected] = useState('')

  const reload = useCallback(() => {
    return apiFetch('/api/kube/contexts').then(r => r.json()).then(d => {
      const list = (d.contexts ?? []).filter(c => c.isMonitored)
      setClusters(list)
      setSelected(prev => {
        if (prev && list.some(c => (c.config?.name ?? c.name) === prev)) return prev
        const pick = list.find(c => c.isCurrent) ?? list[0]
        return pick ? (pick.config?.name ?? pick.name) : ''
      })
    }).catch(() => {})
  }, [])

  useEffect(() => { reload() }, [reload])

  return { clusters, selected, setSelected, reload }
}

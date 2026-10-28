import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'

// Load the list of monitored clusters
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

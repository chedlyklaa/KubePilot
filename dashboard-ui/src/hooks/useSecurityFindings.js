import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useNotify } from '../contexts/NotifyContext'

// Shared data layer for every security-finding page (RBAC posture, Workload
// Hardening, and future families) — load/accept/rescan/escalate all hit the
// same generic /api/security/findings/:id/* routes regardless of `kind`, so
// there's nothing family-specific to duplicate per page.
export function useSecurityFindings(cluster, kind) {
  const notify = useNotify()
  const [findings, setFindings] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [busyId,   setBusyId]   = useState(null)

  const load = useCallback(async () => {
    if (!cluster) return
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ cluster })
      if (kind) params.set('kind', kind)
      const r = await apiFetch(`/api/security/findings?${params}`)
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setFindings(Array.isArray(d) ? d : [])
    } catch (err) { setError(err.message); setFindings([]) }
    finally { setLoading(false) }
  }, [cluster, kind])

  useEffect(() => { load() }, [load])

  async function accept(finding, reason) {
    try {
      const r = await apiFetch(`/api/security/findings/${finding._id}/accept`, {
        method: 'POST', body: { reason },
      })
      const d = await r.json()
      if (d.error) { notify('error', d.error); return false }
      notify('success', 'Marked as accepted risk')
      load()
      return true
    } catch (err) { notify('error', err.message); return false }
  }

  async function rescan(finding) {
    setBusyId(finding._id)
    try {
      const r = await apiFetch(`/api/security/findings/${finding._id}/rescan`, { method: 'POST' })
      const d = await r.json()
      if (d.error) notify('error', d.error)
      else notify('success', d.scanned ? `Re-scanned — ${d.newCount} new, ${d.openCount} open` : `Scan skipped: ${d.reason}`)
      load()
    } catch (err) { notify('error', err.message) }
    finally { setBusyId(null) }
  }

  async function escalate(finding) {
    setBusyId(finding._id)
    try {
      const r = await apiFetch(`/api/security/findings/${finding._id}/escalate`, { method: 'POST' })
      const d = await r.json()
      if (d.error) notify('error', d.error)
      else notify('success', 'Escalated — visible in the Escalations queue')
    } catch (err) { notify('error', err.message) }
    finally { setBusyId(null) }
  }

  return { findings, loading, error, busyId, reload: load, accept, rescan, escalate }
}

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch, sseUrl } from '../lib/api'
import EscalationRow from '../components/EscalationRow'

export default function EscalationsPage() {
  const { user }                      = useAuth()
  const notify                        = useNotify()
  const [escalations, setEscalations] = useState([])
  const [users, setUsers]             = useState([])

  useEffect(() => {
    apiFetch('/api/escalations').then(r => r.json()).then(d => { if (Array.isArray(d)) setEscalations(d) })
    if (user.role === 'admin') {
      apiFetch('/api/users').then(r => r.json()).then(d => { if (Array.isArray(d)) setUsers(d.filter(u => u.active)) })
    }
  }, [user.role])

  useEffect(() => {
    const es = new EventSource(sseUrl('/api/escalations/stream'))
    es.onmessage = e => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'init')       setEscalations(ev.escalations)
      else if (ev.type === 'added')    { setEscalations(p => [...p, ev.escalation]); notify('error', `New escalation: ${ev.escalation.issueKey}`) }
      else if (ev.type === 'updated')  setEscalations(p => p.map(x => x.id === ev.escalation.id ? ev.escalation : x))
      else if (ev.type === 'resolved') setEscalations(p => p.filter(x => x.id !== ev.id))
    }
    return () => es.close()
  }, [notify])

  const remove   = useCallback(id => setEscalations(p => p.filter(x => x.id !== id)), [])
  const pending  = escalations.filter(e => e.status === 'pending').length
  const needHelp = escalations.filter(e => e.status === 'need_help').length

  return (
    <div className="escalations-page">
      <div className="page-header">
        <div>
          <h2>Escalations</h2>
          <p className="page-subtitle">Manage issues the agent could not resolve automatically</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {pending  > 0 && <span className="stat-chip chip-warn">{pending} Unclaimed</span>}
          {needHelp > 0 && <span className="stat-chip chip-danger">{needHelp} Need Help</span>}
        </div>
      </div>

      {escalations.length === 0
        ? <div className="empty-page"><span style={{ fontSize: 48, opacity: .2 }}>✓</span><span>No active escalations</span></div>
        : <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Namespace</th>
                  <th>Attempts</th>
                  <th>Status</th>
                  <th>Handled By</th>
                  {user.role === 'admin' && <th>Reassign</th>}
                  <th>Escalated At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {escalations.map(e => (
                  <EscalationRow key={e.id} item={e} onRemove={remove} users={users} />
                ))}
              </tbody>
            </table>
          </div>
      }
    </div>
  )
}

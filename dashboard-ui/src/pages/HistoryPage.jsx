import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import { STATE_LABEL } from '../constants'
import AssignCell from '../components/AssignCell'

export default function HistoryPage() {
  const { user }                          = useAuth()
  const [tab, setTab]                     = useState('approvals')
  const [approvals, setApprovals]         = useState([])
  const [escalations, setEscalations]     = useState([])
  const [users, setUsers]                 = useState([])
  const [loading, setLoading]             = useState(true)

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

  if (loading) return <div className="page-loading">Loading history…</div>

  return (
    <div className="history-page">
      <div className="page-header">
        <div><h2>History</h2><p className="page-subtitle">Full audit trail of all agent decisions</p></div>
      </div>

      <div className="tab-bar-flat">
        <button className={`tab-flat ${tab === 'approvals' ? 'active' : ''}`} onClick={() => setTab('approvals')}>
          Approvals ({approvals.length})
        </button>
        <button className={`tab-flat ${tab === 'escalations' ? 'active' : ''}`} onClick={() => setTab('escalations')}>
          Escalations ({escalations.length})
        </button>
      </div>

      {tab === 'approvals' && (
        <div className="table-wrap">
          {approvals.length === 0
            ? <div className="empty-state">No approval history yet</div>
            : <table className="data-table">
                <thead><tr><th>Issue</th><th>Action</th><th>Risk</th><th>Decision</th><th>Decided By</th><th>When</th></tr></thead>
                <tbody>
                  {approvals.map(a => (
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

      {tab === 'escalations' && (
        <div className="table-wrap">
          {escalations.length === 0
            ? <div className="empty-state">No escalation history yet</div>
            : <table className="data-table">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Attempts</th>
                    <th>Status</th>
                    <th>
                      Handled By
                      {user.role === 'admin' && <span className="col-hint"> (click to change)</span>}
                    </th>
                    <th>Escalated At</th>
                    <th>Last Update</th>
                  </tr>
                </thead>
                <tbody>
                  {escalations.map(e => (
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

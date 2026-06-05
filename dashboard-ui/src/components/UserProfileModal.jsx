import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import { EscalationList, ApprovalList } from '../pages/ProfilePage'
import { StatCard, ActivityChart } from './ProfileShared'

export default function UserProfileModal({ userId, onClose }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [actTab,  setActTab]  = useState('escalations')

  useEffect(() => {
    apiFetch(`/api/users/${userId}/profile`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [userId])

  const initials = data?.user?.name
    ? (data.user.name.split(' ').map(p => p[0] ?? '').join('').slice(0, 2).toUpperCase() || '?')
    : '?'

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <h3>User Profile</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {loading && <div className="upm-loading">Loading profile…</div>}
        {error   && <div className="upm-error">Failed to load: {error}</div>}

        {data && (
          <div className="upm-body">
            {/* Header */}
            <div className="upm-header">
              <div className="profile-avatar-lg upm-avatar">{initials}</div>
              <div className="upm-info">
                <div className="upm-name">{data.user.name}</div>
                <div className="upm-email">{data.user.email}</div>
                <div className="upm-meta">
                  <span className={`role-badge role-${data.user.role}`}>{data.user.role}</span>
                  <span className={`status-pill ${data.user.active ? 'active' : 'inactive'}`}>
                    {data.user.active ? 'Active' : 'Inactive'}
                  </span>
                  <span className="upm-since">Since {fmtDT(data.user.createdAt)}</span>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="upm-stats">
              <StatCard icon="🔺" label="Handled"  value={data.stats.escalationsHandled} color="danger"  small />
              <StatCard icon="✓"  label="Fixed"    value={data.stats.escalationsFixed}   color="success" small />
              <StatCard icon="✅" label="Approvals" value={data.stats.approvalsDecided}   color="warn"    small />
              <StatCard icon="💬" label="Chats"    value={data.stats.chatMessages}       color="primary" small />
              <StatCard icon="⌘"  label="Commands" value={data.stats.commandsRun}        color="info"    small />
            </div>

            {/* 30-day chart */}
            {data.stats.daily && <ActivityChart daily={data.stats.daily} />}

            {/* Activity lists */}
            <div className="activity-tabs">
              <button className={`activity-tab ${actTab === 'escalations' ? 'active' : ''}`} onClick={() => setActTab('escalations')}>
                Escalations
                {data.activity.escalations?.length > 0 && <span className="tab-count">{data.activity.escalations.length}</span>}
              </button>
              <button className={`activity-tab ${actTab === 'approvals' ? 'active' : ''}`} onClick={() => setActTab('approvals')}>
                Approvals
                {data.activity.approvals?.length > 0 && <span className="tab-count">{data.activity.approvals.length}</span>}
              </button>
            </div>

            {actTab === 'escalations'
              ? <EscalationList items={data.activity.escalations} />
              : <ApprovalList   items={data.activity.approvals}   />
            }
          </div>
        )}
      </div>
    </div>
  )
}

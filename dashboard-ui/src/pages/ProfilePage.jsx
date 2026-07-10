import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { fmtDT } from '../utils/format'
import { StatCard, ActivityChart } from '../components/ProfileShared'

// ── Decision badge ─────────────────────────────────────────────────────────────
function DecisionBadge({ d }) {
  const cls = d === 'approved' ? 'badge-approved' : d === 'denied' ? 'badge-denied' : 'badge-timeout'
  return <span className={`decision-badge ${cls}`}>{d}</span>
}

// ── Password-change section ───────────────────────────────────────────────────
function PasswordSection({ emailAvailable, userId }) {
  const notify = useNotify()
  const [open,          setOpen]          = useState(false)
  const [method,        setMethod]        = useState('password') // 'password' | 'email'
  const [otpSent,       setOtpSent]       = useState(false)
  const [sendingOtp,    setSendingOtp]    = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [form, setForm] = useState({ currentPassword: '', otp: '', newPassword: '', confirmPassword: '' })

  function f(key, val) { setForm(p => ({ ...p, [key]: val })) }

  async function sendCode() {
    setSendingOtp(true)
    try {
      const r = await apiFetch('/api/profile/request-otp', { method: 'POST' })
      if (r.ok) { setOtpSent(true); notify('success', 'Verification code sent to your email') }
      else { const d = await r.json(); notify('error', d.error || 'Failed to send code') }
    } catch { notify('error', 'Network error') }
    finally   { setSendingOtp(false) }
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!form.newPassword) { notify('error', 'New password is required'); return }
    if (form.newPassword !== form.confirmPassword) { notify('error', 'Passwords do not match'); return }
    if (method === 'password' && !form.currentPassword) { notify('error', 'Enter your current password'); return }
    if (method === 'email'    && !form.otp)              { notify('error', 'Enter the verification code'); return }

    setSaving(true)
    try {
      const body = { password: form.newPassword }
      if (method === 'password') body.currentPassword = form.currentPassword
      else                       body.otp             = form.otp

      const r = await apiFetch('/api/profile', {
        method: 'PUT',
        body:   body,
      })
      if (r.ok) {
        notify('success', 'Password changed successfully')
        setOpen(false)
        setForm({ currentPassword: '', otp: '', newPassword: '', confirmPassword: '' })
        setOtpSent(false)
      } else {
        const d = await r.json()
        notify('error', d.error || 'Failed to change password')
      }
    } catch { notify('error', 'Network error') }
    finally  { setSaving(false) }
  }

  if (!open) {
    return (
      <button className="btn-change-password" onClick={() => setOpen(true)}>
        🔒 Change Password
      </button>
    )
  }

  return (
    <form className="password-section" onSubmit={handleSave}>
      <div className="password-section-header">
        <span className="password-section-title">Change Password</span>
        <button type="button" className="btn-link" onClick={() => { setOpen(false); setOtpSent(false) }}>Cancel</button>
      </div>

      {/* Method selector */}
      <div className="pw-method-row">
        <span className="pw-method-label">Verify via:</span>
        <label className={`pw-method-opt ${method === 'password' ? 'pw-method-active' : ''}`}>
          <input type="radio" name="pwmethod" value="password" checked={method === 'password'}
            onChange={() => { setMethod('password'); setOtpSent(false) }} />
          Current Password
        </label>
        <label className={`pw-method-opt ${method === 'email' ? 'pw-method-active' : ''} ${!emailAvailable ? 'pw-method-disabled' : ''}`}
          title={!emailAvailable ? 'Email service not configured on this server' : ''}>
          <input type="radio" name="pwmethod" value="email" checked={method === 'email'}
            onChange={() => setMethod('email')} disabled={!emailAvailable} />
          Email Code {!emailAvailable && <span className="pw-method-na">(not available)</span>}
        </label>
      </div>

      <div className="profile-edit-grid">
        {method === 'password' && (
          <div className="form-group">
            <label className="form-label">Current Password</label>
            <input className="form-input" type="password" value={form.currentPassword}
              onChange={e => f('currentPassword', e.target.value)} placeholder="Enter current password" />
          </div>
        )}

        {method === 'email' && (
          <div className="form-group">
            <label className="form-label">Email Code</label>
            {!otpSent ? (
              <button type="button" className="btn-send-otp" onClick={sendCode} disabled={sendingOtp}>
                {sendingOtp ? 'Sending…' : '📧 Send Code to Email'}
              </button>
            ) : (
              <div className="otp-input-row">
                <input className="form-input otp-input" value={form.otp}
                  onChange={e => f('otp', e.target.value)} placeholder="6-digit code" maxLength={6} />
                <button type="button" className="btn-link" onClick={sendCode} disabled={sendingOtp}>
                  {sendingOtp ? '…' : 'Resend'}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="form-group">
          <label className="form-label">New Password</label>
          <input className="form-input" type="password" value={form.newPassword}
            onChange={e => f('newPassword', e.target.value)} placeholder="New password" />
        </div>
        <div className="form-group">
          <label className="form-label">Confirm Password</label>
          <input className="form-input" type="password" value={form.confirmPassword}
            onChange={e => f('confirmPassword', e.target.value)} placeholder="Repeat new password" />
        </div>
      </div>

      <div className="profile-edit-footer">
        <button type="submit" className="btn-profile-save" disabled={saving || (method === 'email' && !otpSent)}>
          {saving ? 'Saving…' : 'Change Password'}
        </button>
      </div>
    </form>
  )
}

// ── Escalation activity list ──────────────────────────────────────────────────
export function EscalationList({ items }) {
  if (!items?.length) return <div className="activity-empty">No escalations yet</div>
  return (
    <div className="activity-table-wrap">
      <table className="activity-table">
        <thead><tr><th>Issue Key</th><th>Status</th><th>Cluster</th><th>Attempts</th><th>Acknowledged</th><th>Updated</th></tr></thead>
        <tbody>
          {items.map(e => (
            <tr key={e._id}>
              <td className="fw-500">{e.issueKey}</td>
              <td><span className={`state-badge state-${e.status}`}>{e.status}</span></td>
              <td className="text-dim">{e.issue?.clusterName ?? '—'}</td>
              <td className="text-center">{e.attempts ?? '—'}</td>
              <td className="text-dim">{e.acknowledgedAt ? fmtDT(e.acknowledgedAt) : '—'}</td>
              <td className="text-dim">{e.stateUpdatedAt ? fmtDT(e.stateUpdatedAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Approval activity list ────────────────────────────────────────────────────
export function ApprovalList({ items }) {
  if (!items?.length) return <div className="activity-empty">No approvals yet</div>
  return (
    <div className="activity-table-wrap">
      <table className="activity-table">
        <thead><tr><th>Issue Key</th><th>Decision</th><th>Risk</th><th>Cluster</th><th>Date</th></tr></thead>
        <tbody>
          {items.map(a => (
            <tr key={a._id}>
              <td className="fw-500">{a.issueKey}</td>
              <td><DecisionBadge d={a.decision} /></td>
              <td><span className={`risk-pill risk-${(a.issue?.risk ?? '').toLowerCase()}`}>{a.issue?.risk ?? '—'}</span></td>
              <td className="text-dim">{a.issue?.clusterName ?? '—'}</td>
              <td className="text-dim">{fmtDT(a.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main profile page ─────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { user, updateUser } = useAuth()
  const notify               = useNotify()
  const [stats,    setStats]    = useState(null)
  const [activity, setActivity] = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [editing,  setEditing]  = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [emailAvailable, setEmailAvailable] = useState(false)
  const [actTab,   setActTab]   = useState('escalations') // 'escalations' | 'approvals'
  const [form, setForm] = useState({ name: user.name })

  useEffect(() => {
    Promise.all([
      apiFetch('/api/profile/stats').then(r => r.json()),
      apiFetch('/api/profile/activity').then(r => r.json()),
      apiFetch('/api/profile/email-available').then(r => r.json()),
    ]).then(([s, a, e]) => {
      setStats(s); setActivity(a); setEmailAvailable(e.available ?? false)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  function toggleEdit() {
    setEditing(p => !p)
    setForm({ name: user.name })
  }

  async function handleSaveName(e) {
    e.preventDefault()
    if (!form.name.trim()) { notify('error', 'Name cannot be empty'); return }
    setSaving(true)
    try {
      const r = await apiFetch('/api/profile', {
        method: 'PUT',
        body:   { name: form.name.trim() },
      })
      if (r.ok) {
        const d = await r.json()
        updateUser({ name: d.name })
        notify('success', 'Name updated')
        setEditing(false)
      } else {
        const d = await r.json()
        notify('error', d.error || 'Failed to update')
      }
    } catch { notify('error', 'Network error') }
    finally  { setSaving(false) }
  }

  const initials = (user.name || '?').split(' ').map(p => p[0] ?? '').join('').slice(0, 2).toUpperCase() || '?'

  return (
    <div className="profile-page">

      {/* ── Header card ── */}
      <div className="profile-header-card">
        <div className="profile-avatar-lg">{initials}</div>
        <div className="profile-header-info">
          <h1 className="profile-display-name">{user.name}</h1>
          <div className="profile-email">{user.email}</div>
          <span className={`role-badge role-${user.role}`}>{user.role}</span>
        </div>
        <button className={`btn ${editing ? 'btn-outline-active' : 'btn-outline'}`} onClick={toggleEdit}>
          {editing ? '✕ Cancel' : '✎ Edit Name'}
        </button>
      </div>

      {/* ── Edit name form ── */}
      {editing && (
        <form className="profile-edit-form" onSubmit={handleSaveName}>
          <div className="profile-edit-grid">
            <div className="form-group">
              <label className="form-label">Display Name</label>
              <input className="form-input" value={form.name}
                onChange={e => setForm({ name: e.target.value })} placeholder="Your name" />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input form-input-disabled" value={user.email} disabled />
            </div>
          </div>
          <div className="profile-edit-footer">
            <button type="submit" className="btn-profile-save" disabled={saving}>
              {saving ? 'Saving…' : 'Save Name'}
            </button>
          </div>
        </form>
      )}

      {/* ── Password change ── */}
      <PasswordSection emailAvailable={emailAvailable} />

      {/* ── Stats ── */}
      <div className="profile-section-title">Activity Overview</div>
      <div className="profile-stats">
        <StatCard icon="🔺" label="Escalations Handled" value={loading ? '…' : (stats?.escalationsHandled ?? 0)} color="danger"  />
        <StatCard icon="✓"  label="Escalations Fixed"   value={loading ? '…' : (stats?.escalationsFixed   ?? 0)} color="success" />
        <StatCard icon="✅" label="Approvals Decided"   value={loading ? '…' : (stats?.approvalsDecided   ?? 0)} color="warn"    />
        <StatCard icon="💬" label="Chat Messages"       value={loading ? '…' : (stats?.chatMessages       ?? 0)} color="primary" />
        <StatCard icon="⌘"  label="Commands Run"        value={loading ? '…' : (stats?.commandsRun        ?? 0)} color="info"    />
      </div>

      {/* ── Chart ── */}
      {stats?.daily && <ActivityChart daily={stats.daily} />}

      {/* ── Activity lists ── */}
      <div className="profile-section-title">Work History</div>
      <div className="activity-tabs">
        <button className={`activity-tab ${actTab === 'escalations' ? 'active' : ''}`} onClick={() => setActTab('escalations')}>
          Escalations Handled
          {activity?.escalations?.length > 0 && <span className="tab-count">{activity.escalations.length}</span>}
        </button>
        <button className={`activity-tab ${actTab === 'approvals' ? 'active' : ''}`} onClick={() => setActTab('approvals')}>
          Approvals Decided
          {activity?.approvals?.length > 0 && <span className="tab-count">{activity.approvals.length}</span>}
        </button>
      </div>

      {loading
        ? <div className="activity-empty">Loading…</div>
        : actTab === 'escalations'
          ? <EscalationList items={activity?.escalations} />
          : <ApprovalList   items={activity?.approvals}   />
      }
    </div>
  )
}

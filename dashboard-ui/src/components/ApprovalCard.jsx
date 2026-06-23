import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNotify } from '../contexts/NotifyContext'
import { apiFetch } from '../lib/api'
import { fmtTime } from '../utils/format'
import { Row } from './Row'
import RcaCard from './RcaCard'

const REASON_TAGS = [
  'Wrong diagnosis',
  'Too risky for this cluster',
  'Prefer scale_down instead',
  'Prefer restart instead',
  'Wrong timing (business hours)',
  'Insufficient confidence score',
  'Already handled manually',
  'Needs more context first',
]

const PREFERRED_ACTIONS = ['restart', 'scale_down', 'cordon_node', 'noop', 'manual intervention']

const SILENCE_DURATIONS = [
  { label: '1 hour',   ms: 3_600_000 },
  { label: '4 hours',  ms: 14_400_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days',   ms: 604_800_000 },
]

export default function ApprovalCard({ approval, onSettle }) {
  const { user }   = useAuth()
  const notify     = useNotify()
  const [busy, setBusy]                       = useState(false)
  // denyMode: null | 'choose' | 'silence' | 'override'
  const [denyMode, setDenyMode]               = useState(null)
  const [selectedReasons, setSelectedReasons] = useState([])
  const [preferredAction, setPreferredAction] = useState('')
  const [adminNote, setAdminNote]             = useState('')
  const [silenceDuration, setSilenceDuration] = useState(SILENCE_DURATIONS[0].ms)
  const [silenceReason, setSilenceReason]     = useState('')

  const { id, payload, createdAt } = approval
  const { issue, diagnosis, rca }  = payload

  // Key that matches the agent's _handle key format
  const silenceKey = `${issue?.type}:${issue?.deployment ?? issue?.podName}:${issue?.namespace ?? 'default'}`

  function toggleReason(reason) {
    setSelectedReasons(prev =>
      prev.includes(reason) ? prev.filter(r => r !== reason) : [...prev, reason]
    )
  }

  function resetDenyState() {
    setDenyMode(null)
    setSelectedReasons([])
    setPreferredAction('')
    setAdminNote('')
    setSilenceDuration(SILENCE_DURATIONS[0].ms)
    setSilenceReason('')
  }

  async function handleApprove() {
    setBusy(true)
    await apiFetch(`/api/approvals/${id}/approve`, { method: 'POST' })
    notify('success', `Approved: ${payload.issueKey}`)
    onSettle(id)
  }

  async function submitDeny(withFeedback) {
    setBusy(true)
    const body = withFeedback
      ? { overrideReasons: selectedReasons, preferredAction, adminNote: adminNote.trim() }
      : {}
    await apiFetch(`/api/approvals/${id}/deny`, { method: 'POST', body })
    notify('warn', `Denied: ${payload.issueKey}`)
    onSettle(id)
  }

  async function submitSilence() {
    setBusy(true)
    await apiFetch('/api/silences', {
      method: 'POST',
      body: { key: silenceKey, durationMs: silenceDuration, reason: silenceReason.trim() },
    })
    await apiFetch(`/api/approvals/${id}/silence`, { method: 'POST' })
    const label = SILENCE_DURATIONS.find(d => d.ms === silenceDuration)?.label ?? 'custom'
    notify('info', `Silenced for ${label}: ${payload.issueKey}`)
    onSettle(id)
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-type">{issue?.type ?? 'Unknown'}</span>
        <span className="card-time">{fmtTime(createdAt)}</span>
      </div>
      <div className="card-body">
        <Row label="Cluster"    val={issue?.clusterName ?? '—'} />
        <Row label="Namespace"  val={issue?.namespace ?? 'default'} />
        <Row label="Deployment" val={issue?.deployment ?? '—'} />
        <Row label="Pod"        val={issue?.podName ?? '—'} />
        <Row label="Action"     val={diagnosis?.action ?? '—'} />
        <div className="card-row">
          <span className="card-label">Risk</span>
          <span className={`card-risk ${diagnosis?.risk ?? 'HIGH'}`}>{diagnosis?.risk ?? 'HIGH'}</span>
          {diagnosis?.risk === 'UNCERTAIN' && (
            <span className="uncertain-hint">Evidence insufficient — manual review needed</span>
          )}
        </div>
        {diagnosis?.rootCause && <div className="card-diagnosis">{diagnosis.rootCause}</div>}
      </div>

      {rca && <RcaCard rca={rca} />}

      {/* ── Deny mode state machine ─────────────────────────────────────── */}
      {user.role === 'admin' && denyMode === 'choose' && (
        <div className="override-panel">
          <div className="override-section-label">What do you want to do?</div>
          <div className="silence-options">
            <button className="silence-option" onClick={() => setDenyMode('silence')}>
              <span className="silence-option-icon">🔕</span>
              <div>
                <div className="silence-option-title">Silence this error</div>
                <div className="silence-option-desc">Stop the agent from acting on this issue for a set period</div>
              </div>
            </button>
            <button className="silence-option" onClick={() => setDenyMode('override')}>
              <span className="silence-option-icon">✕</span>
              <div>
                <div className="silence-option-title">Deny with feedback</div>
                <div className="silence-option-desc">Reject the action and tell the agent why</div>
              </div>
            </button>
          </div>
          <div className="override-footer">
            <button className="btn-override-skip" onClick={resetDenyState}>Cancel</button>
          </div>
        </div>
      )}

      {user.role === 'admin' && denyMode === 'silence' && (
        <div className="override-panel">
          <div className="override-section-label">Silence duration</div>
          <div className="silence-pills">
            {SILENCE_DURATIONS.map(d => (
              <button
                key={d.ms}
                className={`silence-pill${silenceDuration === d.ms ? ' selected' : ''}`}
                onClick={() => setSilenceDuration(d.ms)}
              >{d.label}</button>
            ))}
          </div>

          <div className="override-section-label">Reason (optional)</div>
          <textarea
            className="override-note"
            placeholder="e.g. Known issue, tracked in ticket #123"
            maxLength={200}
            value={silenceReason}
            onChange={e => setSilenceReason(e.target.value)}
            rows={2}
          />
          <div className="override-note-count">{silenceReason.length}/200</div>

          <div className="silence-key-hint">
            Silencing: <code>{silenceKey}</code>
          </div>

          <div className="override-footer">
            <button className="btn-override-skip" disabled={busy} onClick={() => setDenyMode('choose')}>
              Back
            </button>
            <button className="btn-silence-confirm" disabled={busy} onClick={submitSilence}>
              {busy ? 'Silencing…' : 'Confirm Silence'}
            </button>
          </div>
        </div>
      )}

      {user.role === 'admin' && denyMode === 'override' && (
        <div className="override-panel">
          <div className="override-section-label">Why are you rejecting this action?</div>
          <div className="override-tags">
            {REASON_TAGS.map(tag => (
              <button
                key={tag}
                className={`override-tag${selectedReasons.includes(tag) ? ' selected' : ''}`}
                onClick={() => toggleReason(tag)}
              >{tag}</button>
            ))}
          </div>

          <div className="override-section-label">Preferred action</div>
          <div className="override-actions">
            {PREFERRED_ACTIONS.map(action => (
              <button
                key={action}
                className={`override-action-pill${preferredAction === action ? ' selected' : ''}`}
                onClick={() => setPreferredAction(prev => prev === action ? '' : action)}
              >{action}</button>
            ))}
          </div>

          <textarea
            className="override-note"
            placeholder="Additional context (optional)"
            maxLength={300}
            value={adminNote}
            onChange={e => setAdminNote(e.target.value)}
            rows={2}
          />
          <div className="override-note-count">{adminNote.length}/300</div>

          <div className="override-footer">
            <button className="btn-override-skip" disabled={busy} onClick={() => setDenyMode('choose')}>
              Back
            </button>
            <button className="btn-override-skip" disabled={busy} onClick={() => submitDeny(false)}>
              Skip feedback
            </button>
            <button className="btn-override-confirm" disabled={busy} onClick={() => submitDeny(true)}>
              {busy ? 'Rejecting…' : 'Reject & save feedback'}
            </button>
          </div>
        </div>
      )}

      {/* ── Default action bar ──────────────────────────────────────────── */}
      {denyMode === null && (
        <div className="card-actions">
          {user.role === 'admin'
            ? <>
                <button className="btn-approve" disabled={busy} onClick={handleApprove}>Approve</button>
                <button className="btn-deny"    disabled={busy} onClick={() => setDenyMode('choose')}>Deny</button>
              </>
            : <div className="card-readonly">Awaiting admin approval</div>
          }
        </div>
      )}
    </div>
  )
}

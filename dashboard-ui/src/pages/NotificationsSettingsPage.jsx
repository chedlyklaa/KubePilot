import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'

// ── Constants ──────────────────────────────────────────────────────────────────
const CATEGORIES = [
  'Cluster Health', 'Resource Usage', 'Security', 'Deployments',
  'Cost Optimization', 'Autoscaling', 'Incidents', 'Agent Actions',
  'Recommendations', 'Reports',
]
const SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'CRITICAL']
const SEV_COLOR  = { INFO: '#2563eb', WARNING: '#d97706', ERROR: '#ea580c', CRITICAL: '#dc2626' }
const STATUS_COLOR = { SENT: '#059669', FAILED: '#dc2626', RETRYING: '#d97706', PENDING: '#6b7280' }

// Channels available for personal subscription (not system-config channels)
const PERSONAL_CHANNELS = [
  { type: 'inApp', label: 'In-App',  icon: '🔔', alwaysOn: true },
  { type: 'email', label: 'Email',   icon: '📧' },
]

// System channels (admin config: webhook URLs, SMTP, etc.)
const SYSTEM_CHANNELS = [
  { type: 'teams',    label: 'Microsoft Teams',  icon: '🟦', phase: 1,
    fields: [{ key: 'webhookUrl', label: 'Team Webhook URL', secret: true,
               placeholder: 'https://…webhook.office.com/…',
               hint: 'Incoming Webhook for the team channel — all members receive alerts here' }] },
  { type: 'slack',    label: 'Slack',            icon: '💬', phase: 1,
    fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true,
               placeholder: 'https://hooks.slack.com/services/…' }] },
  { type: 'email',    label: 'Email (SMTP)',      icon: '📧', phase: 1,
    fields: [
      { key: 'smtpHost',   label: 'SMTP Host',   placeholder: 'smtp.gmail.com' },
      { key: 'smtpPort',   label: 'SMTP Port',   placeholder: '587' },
      { key: 'smtpUser',   label: 'Username',    placeholder: 'alerts@example.com' },
      { key: 'smtpPass',   label: 'Password',    secret: true, placeholder: '••••••••' },
      { key: 'smtpFrom',   label: 'From Name',   placeholder: '"KubePilot" <alerts@example.com>' },
      { key: 'recipients', label: 'Default Recipients', placeholder: 'admin@example.com, ops@example.com' },
    ] },
  { type: 'telegram', label: 'Telegram',         icon: '✈️',  phase: 2,
    fields: [
      { key: 'botToken', label: 'Bot Token', secret: true, placeholder: '123456:ABC-…' },
      { key: 'chatId',   label: 'Chat ID',   placeholder: '-1001234567890' },
    ] },
  { type: 'discord',  label: 'Discord',          icon: '🎮', phase: 2,
    fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true,
               placeholder: 'https://discord.com/api/webhooks/…' }] },
  { type: 'webhook',  label: 'Generic Webhook',  icon: '🔗', phase: 2,
    fields: [
      { key: 'webhookUrl', label: 'Target URL',     placeholder: 'https://example.com/hook' },
      { key: 'method',     label: 'Method',         placeholder: 'POST' },
      { key: 'headers',    label: 'Headers (JSON)', placeholder: '{"Authorization":"Bearer …"}' },
    ] },
]

// ── Channel setup guides ───────────────────────────────────────────────────────
const CHANNEL_GUIDES = {
  inApp: {
    title: 'In-App Notifications',
    icon: '🔔',
    intro: 'In-app notifications appear inside KubePilot directly — no external setup needed.',
    steps: [
      { text: 'In-app is always available and requires no configuration.' },
      { text: 'Notifications appear in the bell icon (🔔) at the top-right of the dashboard.' },
      { text: 'Use the Categories section below to filter which events you receive.' },
    ],
    note: 'In-app notifications are stored in the database and can be read at any time from the notification panel.',
  },
  email: {
    title: 'Email Notifications',
    icon: '📧',
    intro: 'Receive KubePilot alerts directly in your inbox. The admin must first configure the SMTP server under Team Channels.',
    steps: [
      { text: 'Enable the Email toggle above.' },
      { text: 'Enter the email address where you want to receive notifications (defaults to your account email if left blank).' },
      { text: 'Click Send Test to verify you receive the test email.' },
      { text: 'Save your preferences.' },
    ],
    note: 'If you do not receive the test email, ask your admin to verify the SMTP configuration under Team Channels → Email.',
  },
  teams: {
    title: 'Microsoft Teams — Incoming Webhook',
    icon: '🟦',
    intro: 'Send KubePilot alerts to a Teams channel using an Incoming Webhook connector.',
    steps: [
      { text: 'Open Microsoft Teams and go to the channel you want to use for alerts.' },
      { text: 'Click the ⋯ menu next to the channel name → Manage channel.' },
      { text: 'Go to the Connectors tab → Edit → search for "Incoming Webhook".' },
      { text: 'Click Add → then Configure.' },
      { text: 'Give it a name (e.g. "KubePilot") and optionally upload an icon.' },
      { text: 'Click Create — a webhook URL will appear.' },
      { text: 'Copy the URL and paste it into the Webhook URL field above.' },
      { text: 'Click Test Connection to verify, then Save.' },
    ],
    note: 'The URL starts with https://…webhook.office.com/… — keep it secret, anyone with the URL can post to your channel.',
    link: { label: 'Microsoft Teams Incoming Webhooks docs', url: 'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook' },
  },
  slack: {
    title: 'Slack — Incoming Webhook',
    icon: '💬',
    intro: 'Post KubePilot alerts to a Slack channel via a Slack App webhook.',
    steps: [
      { text: 'Go to api.slack.com/apps and click Create New App → From scratch.' },
      { text: 'Give it a name (e.g. "KubePilot") and select your workspace.' },
      { text: 'In the left sidebar, click Incoming Webhooks → toggle Activate Incoming Webhooks to On.' },
      { text: 'Scroll down and click Add New Webhook to Workspace.' },
      { text: 'Select the channel where alerts should appear → click Allow.' },
      { text: 'Copy the Webhook URL that appears.' },
      { text: 'Paste it into the Webhook URL field above.' },
      { text: 'Click Test Connection to verify, then Save.' },
    ],
    note: 'The URL starts with https://hooks.slack.com/services/… — treat it like a password.',
    link: { label: 'Slack Incoming Webhooks guide', url: 'https://api.slack.com/messaging/webhooks' },
  },
  email_system: {
    title: 'Email (SMTP) — System Configuration',
    icon: '📧',
    intro: 'Configure the SMTP server that KubePilot uses to send email notifications to all users.',
    steps: [
      { text: 'Obtain SMTP credentials from your email provider.' },
      { text: 'SMTP Host: e.g. smtp.gmail.com (Gmail), smtp.office365.com (Outlook).' },
      { text: 'SMTP Port: 587 for TLS (recommended), 465 for SSL, 25 for unencrypted.' },
      { text: 'Username: your full email address (e.g. alerts@yourcompany.com).' },
      { text: 'Password: your email password or App Password (see note below).' },
      { text: 'From Name: how the sender appears, e.g. "KubePilot" <alerts@yourcompany.com>.' },
      { text: 'Default Recipients: comma-separated fallback addresses for system alerts.' },
      { text: 'Click Test Connection — it verifies the SMTP credentials without sending an email.' },
      { text: 'Click Save.' },
    ],
    note: 'Gmail users: go to myaccount.google.com → Security → App Passwords and generate one instead of using your main password. 2-step verification must be enabled.',
    link: { label: 'Google App Passwords guide', url: 'https://support.google.com/accounts/answer/185833' },
  },
  telegram: {
    title: 'Telegram — Bot Notifications',
    icon: '✈️',
    intro: 'Send KubePilot alerts to a Telegram chat or group using a bot.',
    steps: [
      { text: 'Open Telegram and search for @BotFather.' },
      { text: 'Send /newbot — follow the prompts to name your bot.' },
      { text: 'BotFather will give you a Bot Token (e.g. 123456:ABC-DefGhi…). Copy it.' },
      { text: 'To get your Chat ID: add your bot to the target chat, then send a message.' },
      { text: 'Visit https://api.telegram.org/bot[YOUR_TOKEN]/getUpdates in your browser (replace [YOUR_TOKEN] with your actual token).' },
      { text: 'Find "chat" → "id" in the JSON response — that is your Chat ID.' },
      { text: 'Paste the Bot Token and Chat ID into the fields above.' },
      { text: 'Click Test Connection to verify, then Save.' },
    ],
    note: 'For group chats, the Chat ID is a negative number (e.g. -1001234567890). Add the bot as an admin in the group.',
  },
  discord: {
    title: 'Discord — Webhook Notifications',
    icon: '🎮',
    intro: 'Send KubePilot alerts to a Discord channel using a built-in webhook.',
    steps: [
      { text: 'Open Discord and go to the server and channel you want to use.' },
      { text: 'Click the gear icon next to the channel name → Integrations.' },
      { text: 'Click Webhooks → New Webhook.' },
      { text: 'Give it a name (e.g. "KubePilot") and optionally set an avatar.' },
      { text: 'Click Copy Webhook URL.' },
      { text: 'Paste it into the Webhook URL field above.' },
      { text: 'Click Test Connection to verify, then Save.' },
    ],
    note: 'The URL starts with https://discord.com/api/webhooks/… — keep it secret.',
  },
  webhook: {
    title: 'Generic Webhook',
    icon: '🔗',
    intro: 'Send KubePilot alert payloads to any HTTP endpoint — useful for custom integrations.',
    steps: [
      { text: 'Enter the full URL of your endpoint (must be HTTPS in production).' },
      { text: 'Set the HTTP Method — POST is standard for webhooks.' },
      { text: 'Add any required headers in JSON format, e.g. {"Authorization": "Bearer your-token"}.' },
      { text: 'Click Test Connection — KubePilot will send a test POST request to your endpoint.' },
      { text: 'Save once the test succeeds.' },
    ],
    note: 'KubePilot sends a JSON body with fields: id, timestamp, severity, category, title, message, namespace, source, metadata.',
  },
}

// ── Help Modal ─────────────────────────────────────────────────────────────────
function HelpModal({ guide, onClose }) {
  if (!guide) return null
  return (
    <div className="nc-help-overlay" onClick={onClose}>
      <div className="nc-help-modal" onClick={e => e.stopPropagation()}>
        <div className="nc-help-header">
          <div className="nc-help-title">
            <span>{guide.icon}</span>
            <span>{guide.title}</span>
          </div>
          <button className="nc-help-close" onClick={onClose}>✕</button>
        </div>

        <div className="nc-help-body">
          <p className="nc-help-intro">{guide.intro}</p>

          <div className="nc-help-steps">
            {guide.steps.map((s, i) => (
              <div key={i} className="nc-help-step">
                <span className="nc-help-step-num">{i + 1}</span>
                <span className="nc-help-step-text">{s.text}</span>
              </div>
            ))}
          </div>

          {guide.note && (
            <div className="nc-help-note">
              <span className="nc-help-note-icon">💡</span>
              <span>{guide.note}</span>
            </div>
          )}

          {guide.link && (
            <a className="nc-help-link" href={guide.link.url} target="_blank" rel="noreferrer">
              ↗ {guide.link.label}
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      className={`notif-toggle ${checked ? 'notif-toggle-on' : ''} ${disabled ? 'notif-toggle-disabled' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      aria-checked={checked} role="switch"
    >
      <span className="notif-toggle-thumb" />
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Personal Preferences (all users)
// ═══════════════════════════════════════════════════════════════════════════════
function PersonalPreferencesTab({ readOnly = false, prefData = null, onSaved }) {
  const { user }            = useAuth()
  const [prefs,           setPrefs]           = useState(null)
  const [saving,          setSaving]          = useState(false)
  const [testingEmail,    setTestingEmail]    = useState(false)
  const [emailTestResult, setEmailTestResult] = useState(null)
  const [helpGuide,       setHelpGuide]       = useState(null)

  const load = useCallback(() => {
    if (prefData) { setPrefs(prefData); return }
    apiFetch('/api/notifications/preferences').then(r => r.json()).then(setPrefs).catch(() => {})
  }, [prefData])

  useEffect(() => { load() }, [load])

  function toggleChannel(type) {
    setPrefs(p => ({
      ...p,
      channels: p.channels.includes(type)
        ? p.channels.filter(c => c !== type)
        : [...p.channels, type],
    }))
  }

  function toggleCategory(cat) {
    setPrefs(p => ({
      ...p,
      categories: p.categories.includes(cat)
        ? p.categories.filter(c => c !== cat)
        : [...p.categories, cat],
    }))
  }

  async function save() {
    setSaving(true)
    try {
      await apiFetch('/api/notifications/preferences', { method: 'PUT', body: prefs })
      onSaved?.()
    } catch {}
    finally { setSaving(false) }
  }

  async function testEmail() {
    setTestingEmail(true); setEmailTestResult(null)
    try {
      const r = await apiFetch('/api/notifications/preferences/test-email', { method: 'POST' })
      const data = await r.json()
      setEmailTestResult(data)
    } catch (e) { setEmailTestResult({ ok: false, message: e.message }) }
    finally { setTestingEmail(false) }
  }

  if (!prefs) return <div className="nc-loading">Loading…</div>

  return (
    <div className="nc-section">
      {helpGuide && <HelpModal guide={helpGuide} onClose={() => setHelpGuide(null)} />}
      {/* Channels */}
      <div className="nc-pref-block">
        <div className="nc-pref-block-title">Notification Channels</div>
        <div className="nc-pref-block-desc">Choose how you want to receive notifications.</div>
        <div className="nc-pref-channels">
          {PERSONAL_CHANNELS.map(ch => (
            <div key={ch.type} className="nc-pref-channel-row">
              <div className="nc-pref-channel-info">
                <span className="nc-channel-icon">{ch.icon}</span>
                <div>
                  <div className="nc-channel-label">{ch.label}</div>
                  {ch.alwaysOn && <div className="nc-pref-always">Always on</div>}
                </div>
              </div>
              <div className="nc-pref-channel-actions">
                <button className="nc-help-btn" onClick={() => setHelpGuide(CHANNEL_GUIDES[ch.type])} title="How it works">?</button>
                <Toggle
                  checked={ch.alwaysOn || prefs.channels.includes(ch.type)}
                  onChange={() => !ch.alwaysOn && !readOnly && toggleChannel(ch.type)}
                  disabled={ch.alwaysOn || readOnly}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Personal email override */}
      {(prefs.channels.includes('email') || readOnly) && (
        <div className="nc-pref-block">
          <div className="nc-pref-block-title">Notification Email</div>
          <div className="nc-pref-block-desc">Override the email address used for your personal notifications.</div>
          <div className="nc-email-test-row">
            <input
              className="nc-field-input"
              type="email"
              placeholder={user?.email ?? 'your@email.com'}
              value={prefs.notifyEmail ?? ''}
              onChange={e => !readOnly && setPrefs(p => ({ ...p, notifyEmail: e.target.value }))}
              disabled={readOnly}
            />
            {!readOnly && (
              <button className="nc-btn-test" onClick={testEmail} disabled={testingEmail}>
                {testingEmail ? '◌' : '⚡'} {testingEmail ? 'Sending…' : 'Send Test'}
              </button>
            )}
          </div>
          {emailTestResult && (
            <div className={`nc-test-result ${emailTestResult.ok ? 'nc-test-ok' : 'nc-test-fail'}`}>
              {emailTestResult.ok ? '✓' : '✗'} {emailTestResult.message}
            </div>
          )}
        </div>
      )}

      {/* Categories */}
      <div className="nc-pref-block">
        <div className="nc-pref-block-title">Event Categories</div>
        <div className="nc-pref-block-desc">
          Select the types of events you want to be notified about.
          Leave all unchecked to receive everything.
        </div>
        <div className="nc-pref-categories">
          {CATEGORIES.map(cat => (
            <label key={cat} className={`nc-pref-cat-chip ${prefs.categories.includes(cat) ? 'nc-pref-cat-on' : ''} ${readOnly ? 'nc-pref-cat-readonly' : ''}`}>
              <input
                type="checkbox"
                className="nc-checkbox"
                checked={prefs.categories.includes(cat)}
                onChange={() => !readOnly && toggleCategory(cat)}
                disabled={readOnly}
              />
              {cat}
            </label>
          ))}
        </div>
        {prefs.categories.length === 0 && (
          <div className="nc-pref-all-hint">✓ Receiving all categories</div>
        )}
      </div>

      {!readOnly && (
        <button className="nc-btn-save" onClick={save} disabled={saving}>
          {saving ? '◌ Saving…' : 'Save Preferences'}
        </button>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — System Channels (admin only)
// ═══════════════════════════════════════════════════════════════════════════════
function SystemChannelCard({ def, data, onSaved }) {
  const [enabled,    setEnabled]    = useState(data?.enabled ?? false)
  const [config,     setConfig]     = useState(data?.config  ?? {})
  const [open,       setOpen]       = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [testing,    setTesting]    = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [showHelp,   setShowHelp]   = useState(false)
  // email system guide key differs from channel type to avoid collision with personal email guide
  const guideKey = def.type === 'email' ? 'email_system' : def.type

  useEffect(() => { setEnabled(data?.enabled ?? false); setConfig(data?.config ?? {}) }, [data])

  async function save() {
    setSaving(true)
    try {
      const r = await apiFetch(`/api/notifications/channels/${def.type}`, {
        method: 'PUT', body: { enabled, config },
      })
      if (!r.ok) throw new Error((await r.json()).error)
      onSaved()
    } catch (e) { alert(e.message) }
    finally { setSaving(false) }
  }

  async function test() {
    setTesting(true); setTestResult(null)
    try {
      const r    = await apiFetch(`/api/notifications/channels/${def.type}/test`, {
        method: 'POST', body: { config },
      })
      setTestResult(await r.json())
    } catch (e) { setTestResult({ ok: false, message: e.message }) }
    finally { setTesting(false) }
  }

  return (
    <div className={`nc-card ${enabled ? 'nc-card-on' : ''}`}>
      {showHelp && <HelpModal guide={CHANNEL_GUIDES[guideKey]} onClose={() => setShowHelp(false)} />}
      <div className="nc-card-head">
        <div className="nc-card-title-row">
          <span className="nc-channel-icon">{def.icon}</span>
          <span className="nc-channel-label">{def.label}</span>
          {def.phase > 1 && <span className="nc-phase-badge">Phase {def.phase}</span>}
        </div>
        <div className="nc-card-actions">
          {enabled && <span className="nc-status-dot nc-status-on" />}
          <button className="nc-help-btn" onClick={() => setShowHelp(true)} title="Setup guide">?</button>
          <Toggle checked={enabled} onChange={setEnabled} />
          <button className="nc-expand-btn" onClick={() => setOpen(p => !p)}>{open ? '▲' : '▼'}</button>
        </div>
      </div>

      {open && (
        <div className="nc-card-body">
          {def.fields.map(f => (
            <div key={f.key} className="nc-field">
              <label className="nc-field-label">{f.label}</label>
              {f.hint && <div className="nc-field-hint">{f.hint}</div>}
              <input
                className="nc-field-input"
                type={f.secret ? 'password' : 'text'}
                placeholder={f.placeholder}
                value={config[f.key] ?? ''}
                onChange={e => setConfig(p => ({ ...p, [f.key]: e.target.value }))}
                autoComplete="off"
              />
            </div>
          ))}
          {testResult && (
            <div className={`nc-test-result ${testResult.ok ? 'nc-test-ok' : 'nc-test-fail'}`}>
              {testResult.ok ? '✓' : '✗'} {testResult.message}
            </div>
          )}
          <div className="nc-card-footer">
            <button className="nc-btn-test" onClick={test} disabled={testing}>
              {testing ? '◌ Testing…' : '⚡ Test Connection'}
            </button>
            <button className="nc-btn-save" onClick={save} disabled={saving}>
              {saving ? '◌ Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SystemChannelsTab({ channels, onSaved }) {
  return (
    <div className="nc-section">
      <p className="nc-section-desc">
        Configure the <strong>shared team channels</strong> — webhook URLs and SMTP settings that deliver
        alerts to the whole team. These are system-level settings, not personal.
      </p>
      <div className="nc-channels-grid">
        {SYSTEM_CHANNELS.map(def => (
          <SystemChannelCard
            key={def.type}
            def={def}
            data={channels.find(c => c.type === def.type)}
            onSaved={onSaved}
          />
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Routing Rules (admin only)
// ═══════════════════════════════════════════════════════════════════════════════
function RoutingTab() {
  const [routing, setRouting] = useState(null)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    apiFetch('/api/notifications/routing').then(r => r.json()).then(setRouting).catch(() => {})
  }, [])

  function toggle(sev, ch) {
    setRouting(prev => {
      const cur = prev[sev] ?? []
      return { ...prev, [sev]: cur.includes(ch) ? cur.filter(c => c !== ch) : [...cur, ch] }
    })
  }

  async function save() {
    setSaving(true)
    try { await apiFetch('/api/notifications/routing', { method: 'PUT', body: routing }) }
    catch {} finally { setSaving(false) }
  }

  if (!routing) return <div className="nc-loading">Loading…</div>

  const cols = SYSTEM_CHANNELS.filter(c => c.phase === 1)

  return (
    <div className="nc-section">
      <p className="nc-section-desc">Map each severity level to one or more delivery channels.</p>
      <div className="nc-routing-table-wrap">
        <table className="nc-routing-table">
          <thead>
            <tr>
              <th>Severity</th>
              {cols.map(c => <th key={c.type}>{c.icon} {c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {SEVERITIES.map(sev => (
              <tr key={sev}>
                <td><span className="nc-sev-badge" style={{ background: SEV_COLOR[sev] }}>{sev}</span></td>
                {cols.map(c => (
                  <td key={c.type} className="nc-routing-cell">
                    <input type="checkbox" className="nc-checkbox"
                      checked={(routing[sev] ?? []).includes(c.type)}
                      onChange={() => toggle(sev, c.type)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="nc-btn-save" onClick={save} disabled={saving}>
        {saving ? '◌ Saving…' : 'Save Routing Rules'}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — All Users' Preferences (admin only)
// ═══════════════════════════════════════════════════════════════════════════════
function UsersPreferencesTab() {
  const [users,    setUsers]    = useState([])
  const [selected, setSelected] = useState(null) // { userId, name, prefs }
  const [saving,   setSaving]   = useState(false)

  const load = useCallback(() => {
    apiFetch('/api/notifications/admin/users-preferences').then(r => r.json()).then(setUsers).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  async function saveUserPrefs(prefs) {
    setSaving(true)
    try {
      await apiFetch('/api/notifications/preferences', { method: 'PUT', body: prefs })
      load()
      setSelected(null)
    } catch {}
    finally { setSaving(false) }
  }

  if (selected) {
    return (
      <div className="nc-section">
        <div className="nc-user-prefs-header">
          <button className="nc-back-btn" onClick={() => setSelected(null)}>← Back</button>
          <div>
            <div className="nc-user-prefs-name">{selected.name}</div>
            <div className="nc-user-prefs-email">{selected.email}</div>
          </div>
          <span className={`role-badge role-${selected.role}`}>{selected.role}</span>
        </div>
        <PersonalPreferencesTab readOnly prefData={selected.prefs} />
      </div>
    )
  }

  return (
    <div className="nc-section">
      <p className="nc-section-desc">View each team member's notification preferences.</p>
      <div className="nc-users-table-wrap">
        <table className="nc-users-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Channels</th>
              <th>Categories</th>
              <th>Email</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.userId}>
                <td>
                  <div className="nc-user-cell">
                    <div className="nc-user-avatar">{u.name?.[0]?.toUpperCase() ?? '?'}</div>
                    <span className="nc-user-name">{u.name}</span>
                  </div>
                </td>
                <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
                <td>
                  <div className="nc-user-chips">
                    {(u.prefs.channels ?? ['inApp']).map(ch => {
                      const def = [...PERSONAL_CHANNELS, ...SYSTEM_CHANNELS].find(c => c.type === ch)
                      return <span key={ch} className="nc-user-chip">{def?.icon ?? '•'} {def?.label ?? ch}</span>
                    })}
                  </div>
                </td>
                <td>
                  {(u.prefs.categories ?? []).length === 0
                    ? <span className="nc-pref-all-hint" style={{ margin: 0 }}>All</span>
                    : <span className="nc-user-cat-count">{u.prefs.categories.length} selected</span>
                  }
                </td>
                <td className="nc-mono">{u.prefs.notifyEmail || u.email}</td>
                <td>
                  <button className="nc-btn-test" onClick={() => setSelected(u)}>View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Delivery History (admin only)
// ═══════════════════════════════════════════════════════════════════════════════
function HistoryTab() {
  const [data,          setData]    = useState(null)
  const [page,          setPage]    = useState(1)
  const [channelFilter, setChannel] = useState('')
  const [statusFilter,  setStatus]  = useState('')
  const [loading,       setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    const qs = new URLSearchParams({ page, limit: 50 })
    if (channelFilter) qs.set('channel', channelFilter)
    if (statusFilter)  qs.set('status',  statusFilter)
    apiFetch(`/api/notifications/delivery-log?${qs}`)
      .then(r => r.json()).then(setData).catch(() => {})
      .finally(() => setLoading(false))
  }, [page, channelFilter, statusFilter])

  useEffect(() => { load() }, [load])

  const fmt = iso => new Date(iso).toLocaleString('en-GB', {
    hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })

  return (
    <div className="nc-section">
      <div className="nc-history-filters">
        <select className="nc-select" value={channelFilter} onChange={e => { setChannel(e.target.value); setPage(1) }}>
          <option value="">All Channels</option>
          {SYSTEM_CHANNELS.map(c => <option key={c.type} value={c.type}>{c.label}</option>)}
        </select>
        <select className="nc-select" value={statusFilter} onChange={e => { setStatus(e.target.value); setPage(1) }}>
          <option value="">All Statuses</option>
          {['PENDING','SENT','FAILED','RETRYING'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="nc-btn-test" onClick={load} disabled={loading}>↺ Refresh</button>
      </div>

      {loading && <div className="nc-loading">Loading…</div>}

      {data && (
        <>
          <div className="nc-history-table-wrap">
            <table className="nc-history-table">
              <thead>
                <tr><th>Time</th><th>Channel</th><th>Severity</th><th>Title</th><th>Status</th><th>Retries</th><th>Error</th></tr>
              </thead>
              <tbody>
                {data.docs.length === 0 && (
                  <tr><td colSpan={7} className="nc-history-empty">No delivery records found</td></tr>
                )}
                {data.docs.map(d => (
                  <tr key={d._id}>
                    <td className="nc-mono">{fmt(d.createdAt)}</td>
                    <td>{SYSTEM_CHANNELS.find(c => c.type === d.channel)?.icon ?? '•'} {d.channel}</td>
                    <td>{d.severity && <span className="nc-sev-badge" style={{ background: SEV_COLOR[d.severity] ?? '#6b7280' }}>{d.severity}</span>}</td>
                    <td className="nc-history-title">{d.title}</td>
                    <td><span className="nc-status-chip" style={{ color: STATUS_COLOR[d.status] ?? '#6b7280' }}>{d.status}</span></td>
                    <td className="nc-mono">{d.retries}</td>
                    <td className="nc-history-error">{d.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="nc-pagination">
            <button className="nc-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
            <span className="nc-page-info">Page {data.page} of {data.pages} ({data.total} total)</span>
            <button className="nc-page-btn" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}>Next ›</button>
          </div>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main page
// ═══════════════════════════════════════════════════════════════════════════════
export default function NotificationsSettingsPage() {
  const { user }                    = useAuth()
  const isAdmin                     = user?.role === 'admin'
  const [tab,      setTab]          = useState('preferences')
  const [channels, setChannels]     = useState([])

  const loadChannels = useCallback(() => {
    if (!isAdmin) return
    apiFetch('/api/notifications/channels').then(r => r.json()).then(setChannels).catch(() => {})
  }, [isAdmin])

  useEffect(() => { loadChannels() }, [loadChannels])

  const adminTabs = [
    { id: 'preferences', label: '⚙️ My Preferences' },
    { id: 'channels',    label: '📡 Team Channels'  },
    { id: 'routing',     label: '🔀 Routing'         },
    { id: 'users',       label: '👥 Users'           },
    { id: 'history',     label: '📜 History'         },
  ]
  const userTabs = [
    { id: 'preferences', label: '⚙️ My Preferences' },
  ]
  const tabs = isAdmin ? adminTabs : userTabs

  return (
    <div className="nc-page">
      <div className="nc-page-header">
        <h2>Notification Settings</h2>
        <p className="page-subtitle">
          {isAdmin
            ? 'Manage your personal preferences and configure team-wide notification channels.'
            : 'Configure how and when you receive notifications.'}
        </p>
      </div>

      <div className="nc-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`nc-tab ${tab === t.id ? 'nc-tab-active' : ''}`}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'preferences' && <PersonalPreferencesTab />}
      {tab === 'channels'    && isAdmin && <SystemChannelsTab channels={channels} onSaved={loadChannels} />}
      {tab === 'routing'     && isAdmin && <RoutingTab />}
      {tab === 'users'       && isAdmin && <UsersPreferencesTab />}
      {tab === 'history'     && isAdmin && <HistoryTab />}
    </div>
  )
}

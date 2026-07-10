import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import ThemeToggle from '../components/ThemeToggle'
import HelpModal from '../components/HelpModal'

// ── Flow schemas ──────────────────────────────────────────────────────────
const SCHEMAS = [
  {
    id: 'monitoring',
    title: 'Autonomous Monitoring & Self-Healing',
    color: '#3b82f6',
    description: 'The core loop that watches every cluster continuously and fixes issues without human intervention when safe.',
    steps: [
      { icon: '☸', label: 'Kubernetes Clusters', sub: 'minikube / cluster2 / staging', color: '#64748b' },
      { icon: '⬇', type: 'arrow', text: 'kubectl get pods + top nodes (every 30s)' },
      { icon: '🛡', label: 'Guardian Agent', sub: 'Polls all clusters, detects CrashLoop, OOMKill, Pending, high restarts', color: '#3b82f6' },
      { icon: '⬇', type: 'arrow', text: 'anomaly detected' },
      { icon: '🔍', label: 'Pod Analyzer + Investigator', sub: 'Reads logs, events, describe — LLM root-cause analysis', color: '#8b5cf6' },
      { icon: '⬇', type: 'arrow', text: 'diagnosis + RCA' },
      { icon: '🧠', label: 'Planner Agent', sub: 'LLM generates step-by-step remediation (restart, scale, rollback)', color: '#6366f1' },
      { icon: '⬇', type: 'arrow', text: 'risk score evaluation' },
      { icon: '⬇', type: 'branch', branches: [
        { label: 'LOW risk', path: [
          { icon: '⚡', label: 'Auto-Execute', sub: 'Cluster Agent runs kubectl immediately', color: '#22c55e' },
        ]},
        { label: 'MED / HIGH risk', path: [
          { icon: '✅', label: 'Approval Gate', sub: 'Blocked until operator approves in dashboard', color: '#f59e0b' },
          { icon: '⬇', type: 'arrow', text: 'approved' },
          { icon: '⚡', label: 'Execute', sub: 'Cluster Agent runs approved kubectl', color: '#22c55e' },
        ]},
      ]},
      { icon: '⬇', type: 'arrow', text: 'kubectl applied' },
      { icon: '🔄', label: 'Reflection Agent', sub: 'Re-reads pod state, LLM validates if fix worked', color: '#06b6d4' },
      { icon: '⬇', type: 'branch', branches: [
        { label: 'Fixed', path: [
          { icon: '✓', label: 'Resolved', sub: 'Logged to audit trail, incident closed', color: '#22c55e' },
        ]},
        { label: 'Still failing (max retries)', path: [
          { icon: '🚨', label: 'Escalation Created', sub: 'Human intervention required — appears in Escalations page', color: '#ef4444' },
        ]},
      ]},
    ],
  },
  {
    id: 'escalation',
    title: 'Escalation Lifecycle',
    color: '#ef4444',
    description: 'When the agent cannot fix an issue after multiple attempts, it escalates to the team.',
    steps: [
      { icon: '🚨', label: 'Agent Escalates', sub: 'Max fix attempts reached, issue persists', color: '#ef4444' },
      { icon: '⬇', type: 'arrow', text: 'notification sent (Email / Slack / in-app)' },
      { icon: '👤', label: 'Developer Claims', sub: 'Takes ownership from the Escalations page', color: '#f59e0b' },
      { icon: '⬇', type: 'arrow', text: 'status: acknowledged' },
      { icon: '🔧', label: 'Manual Investigation', sub: 'Developer uses RCA card, logs, chat agent for context', color: '#8b5cf6' },
      { icon: '⬇', type: 'branch', branches: [
        { label: 'Resolved', path: [
          { icon: '✓', label: 'Mark Fixed', sub: 'Incident closed, admins notified', color: '#22c55e' },
        ]},
        { label: 'Stuck', path: [
          { icon: '🆘', label: 'Need Help / Reassign', sub: 'Request reassignment — admin notified to re-route', color: '#f59e0b' },
        ]},
      ]},
    ],
  },
  {
    id: 'chat',
    title: 'Order Chat Agent',
    color: '#6366f1',
    description: 'Natural language interface — type what you want in plain English, the AI generates and executes safe kubectl commands.',
    steps: [
      { icon: '💬', label: 'User Types Order', sub: '"Scale backend to 5 replicas in staging"', color: '#6366f1' },
      { icon: '⬇', type: 'arrow', text: 'natural language input' },
      { icon: '🤖', label: 'LLM 1 — Intent Parser', sub: 'Extracts: action, target, namespace, cluster. Asks clarifying questions if missing.', color: '#8b5cf6' },
      { icon: '⬇', type: 'arrow', text: 'structured intent (all params collected)' },
      { icon: '🤖', label: 'LLM 2 — Command Generator', sub: 'Generates exact kubectl command with safety checks', color: '#a855f7' },
      { icon: '⬇', type: 'arrow', text: 'kubectl command ready' },
      { icon: '🔒', label: 'Permission Check', sub: 'User RBAC verified — cluster, namespace, action role', color: '#f59e0b' },
      { icon: '⬇', type: 'branch', branches: [
        { label: 'Read-only (get, describe, logs)', path: [
          { icon: '⚡', label: 'Direct Execute', sub: 'No approval needed — results shown instantly', color: '#22c55e' },
        ]},
        { label: 'Write (scale, restart, delete)', path: [
          { icon: '✅', label: 'Approval Card', sub: 'User confirms the command before execution', color: '#f59e0b' },
          { icon: '⬇', type: 'arrow', text: 'user approves' },
          { icon: '⚡', label: 'Execute', sub: 'kubectl runs, output shown in chat', color: '#22c55e' },
        ]},
      ]},
    ],
  },
  {
    id: 'capacity',
    title: 'Capacity & Cost Monitoring',
    color: '#06b6d4',
    description: 'Tracks resource usage over time, forecasts exhaustion, and estimates Azure cloud costs.',
    steps: [
      { icon: '☸', label: 'Kubernetes Nodes & Pods', sub: 'kubectl top nodes/pods — CPU, memory usage', color: '#64748b' },
      { icon: '📊', label: 'Prometheus Metrics', sub: 'node_cpu, node_memory, network transmit bytes', color: '#f59e0b' },
      { icon: '⬇', type: 'arrow', text: 'metrics collected every 30s' },
      { icon: '🗄', label: 'MetricSnapshot (MongoDB)', sub: 'Time-series stored per node/pod, TTL 30 days', color: '#22c55e' },
      { icon: '⬇', type: 'arrow', text: 'enough data points accumulated' },
      { icon: '📈', label: 'Capacity Forecast Engine', sub: 'Weighted Linear Regression + EWMA — predicts resource exhaustion', color: '#06b6d4' },
      { icon: '⬇', type: 'arrow', text: 'alerts: OK / WARNING / HIGH / CRITICAL' },
      { icon: '💰', label: 'Cost Estimation', sub: 'Compute (Azure SKU) + Disk (PV) + Load Balancers + Network Egress', color: '#0078d4' },
    ],
  },
  {
    id: 'health',
    title: 'Cluster Health Dashboard',
    color: '#22c55e',
    description: 'Real-time overview of every pod across all clusters with Prometheus-powered metrics.',
    steps: [
      { icon: '☸', label: 'All Configured Clusters', sub: 'minikube, cluster2, cluster3, staging', color: '#64748b' },
      { icon: '⬇', type: 'arrow', text: 'kubectl get pods + Prometheus queries' },
      { icon: '📋', label: 'Pod Health Table', sub: 'Phase, restarts, CPU/memory, age — filterable by namespace', color: '#22c55e' },
      { icon: '📊', label: 'Prometheus Sparklines', sub: 'CPU & memory trends per pod (15min window)', color: '#f59e0b' },
      { icon: '🔍', label: 'Pod Detail Drawer', sub: 'Click any pod — logs, events, describe, metrics history', color: '#8b5cf6' },
    ],
  },
  {
    id: 'rbac',
    title: 'RBAC & Teams Management',
    color: '#f59e0b',
    description: 'Manages user permissions and syncs them to Kubernetes RoleBindings automatically.',
    steps: [
      { icon: '👥', label: 'Admin Creates Team', sub: 'Name, description, permissions (cluster/namespace/role)', color: '#f59e0b' },
      { icon: '⬇', type: 'arrow', text: 'members assigned' },
      { icon: '🔄', label: 'RBAC Sync Engine', sub: 'Translates app permissions → K8s RoleBindings per user', color: '#6366f1' },
      { icon: '⬇', type: 'arrow', text: 'kubectl apply RoleBinding' },
      { icon: '☸', label: 'Kubernetes RBAC', sub: 'view / edit / admin ClusterRoles bound to user email', color: '#64748b' },
      { icon: '⬇', type: 'arrow', text: 'enforced on every kubectl call' },
      { icon: '🔒', label: 'Permission Gate', sub: 'Chat & dashboard commands checked against user scope', color: '#ef4444' },
    ],
  },
  {
    id: 'notifications',
    title: 'Notification Engine',
    color: '#f87171',
    description: 'Multi-channel alerting — keeps the team informed at every step.',
    steps: [
      { icon: '🔔', label: 'Event Triggers', sub: 'Escalation, approval needed, assignment, state change, forecast alert', color: '#f87171' },
      { icon: '⬇', type: 'arrow', text: 'routing rules applied' },
      { icon: '⬇', type: 'branch', branches: [
        { label: 'In-App', path: [
          { icon: '🔔', label: 'Bell Notifications', sub: 'Real-time SSE — badge count in header', color: '#6366f1' },
        ]},
        { label: 'Email', path: [
          { icon: '✉', label: 'SMTP Mailer', sub: 'Assignment, escalation, resolved emails', color: '#f59e0b' },
        ]},
        { label: 'Slack / Webhook', path: [
          { icon: '💬', label: 'Webhook Delivery', sub: 'Channel-based alerts with retry', color: '#22c55e' },
        ]},
      ]},
    ],
  },
]

// ── How everything connects to minikube ───────────────────────────────────
const MINIKUBE_CONNECTIONS = [
  { from: 'Guardian Agent',       arrow: 'kubectl get pods / nodes / events', color: '#3b82f6' },
  { from: 'Cluster Agent',        arrow: 'kubectl scale / restart / delete / apply', color: '#22c55e' },
  { from: 'Reflection Agent',     arrow: 'kubectl get pod (verify fix)', color: '#06b6d4' },
  { from: 'Chat Agent',           arrow: 'kubectl (user orders)', color: '#6366f1' },
  { from: 'Capacity Engine',      arrow: 'kubectl top + Prometheus scrape', color: '#f59e0b' },
  { from: 'RBAC Sync',            arrow: 'kubectl apply RoleBinding', color: '#f87171' },
]

const FEATURES = [
  { icon: '🔍', title: 'Continuous Detection',    body: 'Monitors all pods 24/7 — CrashLoopBackOff, OOMKill, pending, high restarts — across every cluster and namespace.' },
  { icon: '🧠', title: 'AI-Driven Remediation',   body: 'Multi-agent pipeline analyses root cause, plans fixes, and generates safe kubectl commands with full reasoning.' },
  { icon: '✅', title: 'Human-in-the-Loop',       body: 'Every HIGH and MEDIUM risk action requires operator approval. No command runs on a live cluster without consent.' },
  { icon: '💬', title: 'Natural Language Orders', body: 'Type commands in plain English. A two-LLM clarification chain collects every missing parameter before generating kubectl.' },
]

// ── Component ──────────────────────────────────────────────────────────────
export default function LoginPage() {
  const { login }                       = useAuth()
  const [showModal, setShowModal]       = useState(false)
  const [showHelp, setShowHelp]         = useState(false)
  // 'login' | 'forgot' | 'sent' | 'reset'
  const [view, setView]                 = useState('login')
  const [email, setEmail]               = useState('')
  const [password, setPassword]         = useState('')
  const [forgotEmail, setForgotEmail]   = useState('')
  const [resetToken, setResetToken]     = useState('')
  const [newPassword, setNewPassword]       = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetSuccess, setResetSuccess] = useState('')
  const [error, setError]               = useState('')
  const [loading, setLoading]           = useState(false)

  // Detect ?reset=<token> in URL to open the reset-password form directly
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('reset')
    if (token) { setResetToken(token); setView('reset'); setShowModal(true) }
  }, [])

  async function submit(e) {
    e.preventDefault(); setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Login failed'); return }
      login(data.token, data.user)
    } catch (_e) {
      setError('Server unreachable')
    } finally {
      setLoading(false)
    }
  }

  async function submitForgot(e) {
    e.preventDefault(); setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Request failed'); return }
      setView('sent')
    } catch (_e) {
      setError('Server unreachable')
    } finally {
      setLoading(false)
    }
  }

  async function submitReset(e) {
    e.preventDefault(); setError('')
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return }
    setLoading(true)
    try {
      const res  = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: newPassword }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Reset failed'); return }
      window.history.replaceState({}, '', window.location.pathname)
      setResetSuccess('Password updated! You can now sign in.')
      setView('login')
    } catch (_e) {
      setError('Server unreachable')
    } finally {
      setLoading(false)
    }
  }

  function openModal()  { setShowModal(true);  setError(''); setView('login') }
  function closeModal() {
    setShowModal(false); setError(''); setView('login')
    setForgotEmail(''); setNewPassword(''); setConfirmPassword(''); setResetToken('')
  }
  function goBack()     { setView('login'); setError('') }

  return (
    <div className="lp-root">

      {/* ── Navbar ──────────────────────────────────────────────────────── */}
      <nav className="lp-nav">
        <div className="lp-nav-logo">
          <span className="lp-nav-icon">⎈</span>
          <span className="lp-nav-name">KubePilot</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <ThemeToggle />
          <button className="lp-nav-btn" onClick={openModal}>Sign in</button>
          <button className="help-btn" onClick={() => setShowHelp(true)} title="Help">?</button>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="lp-hero">
        <div className="lp-hero-badge">Autonomous Kubernetes Operations</div>
        <h1 className="lp-hero-title">AI-Powered Cluster<br />Management Platform</h1>
        <p className="lp-hero-desc">
          KubePilot monitors your Kubernetes clusters 24/7, detects anomalies,
          plans remediations, and executes fixes — with human approval at every critical step.
        </p>
        <button className="lp-hero-cta" onClick={openModal}>Get Started →</button>
      </section>

      {/* ── Flow schemas ─────────────────────────────────────────────────── */}
      <section className="lp-arch">
        <h2 className="lp-section-title">How KubePilot Works</h2>
        <p className="lp-section-sub">
          Each subsystem explained — from autonomous healing to natural language commands
        </p>

        <div className="lp-schemas">
          {SCHEMAS.map(schema => (
            <div key={schema.id} className="lp-schema" style={{ '--sc': schema.color }}>
              <div className="lp-schema-head">
                <h3 className="lp-schema-title" style={{ color: schema.color }}>{schema.title}</h3>
                <p className="lp-schema-desc">{schema.description}</p>
              </div>
              <div className="lp-schema-flow">
                {schema.steps.map((step, i) => {
                  if (step.type === 'arrow') {
                    return (
                      <div key={i} className="lp-flow-arrow">
                        <div className="lp-flow-arrow-line" />
                        <span className="lp-flow-arrow-text">{step.text}</span>
                        <div className="lp-flow-arrow-head">▼</div>
                      </div>
                    )
                  }
                  if (step.type === 'branch') {
                    return (
                      <div key={i} className="lp-flow-branches">
                        {step.branches.map((br, bi) => (
                          <div key={bi} className="lp-flow-branch">
                            <div className="lp-flow-branch-label">{br.label}</div>
                            {br.path.map((bs, bsi) => {
                              if (bs.type === 'arrow') {
                                return (
                                  <div key={bsi} className="lp-flow-arrow lp-flow-arrow-sm">
                                    <div className="lp-flow-arrow-line" />
                                    <span className="lp-flow-arrow-text">{bs.text}</span>
                                    <div className="lp-flow-arrow-head">▼</div>
                                  </div>
                                )
                              }
                              return (
                                <div key={bsi} className="lp-flow-node" style={{ '--nc': bs.color }}>
                                  <span className="lp-flow-icon">{bs.icon}</span>
                                  <div>
                                    <div className="lp-flow-name">{bs.label}</div>
                                    <div className="lp-flow-sub">{bs.sub}</div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ))}
                      </div>
                    )
                  }
                  return (
                    <div key={i} className="lp-flow-node" style={{ '--nc': step.color }}>
                      <span className="lp-flow-icon">{step.icon}</span>
                      <div>
                        <div className="lp-flow-name">{step.label}</div>
                        <div className="lp-flow-sub">{step.sub}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* ── Minikube connection map ──────────────────────────────────── */}
        <div className="lp-minikube-section">
          <h3 className="lp-section-title" style={{ fontSize: 20 }}>How Everything Connects to Minikube</h3>
          <p className="lp-section-sub">Every agent communicates with your cluster through kubectl context</p>
          <div className="lp-minikube-map">
            <div className="lp-mk-center">
              <span className="lp-mk-icon">☸</span>
              <span className="lp-mk-label">minikube</span>
              <span className="lp-mk-sub">kube-apiserver</span>
            </div>
            <div className="lp-mk-connections">
              {MINIKUBE_CONNECTIONS.map((c, i) => (
                <div key={i} className="lp-mk-conn" style={{ '--cc': c.color }}>
                  <span className="lp-mk-from">{c.from}</span>
                  <span className="lp-mk-arrow">→</span>
                  <span className="lp-mk-cmd">{c.arrow}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Feature cards ───────────────────────────────────────────────── */}
      <section className="lp-features">
        {FEATURES.map(f => (
          <div key={f.title} className="lp-feature-card">
            <div className="lp-feature-icon">{f.icon}</div>
            <h3 className="lp-feature-title">{f.title}</h3>
            <p className="lp-feature-body">{f.body}</p>
          </div>
        ))}
      </section>

      {/* ── Footer CTA ──────────────────────────────────────────────────── */}
      <section className="lp-footer-cta">
        <h2>Ready to automate your cluster ops?</h2>
        <button className="lp-hero-cta" onClick={openModal}>Sign in to KubePilot</button>
      </section>

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {/* ── Login / Forgot-password modal ────────────────────────────────── */}
      {showModal && (
        <div className="lp-overlay" onClick={e => { if (e.target === e.currentTarget) closeModal() }}>
          <div className="lp-modal">
            <button className="lp-modal-close" onClick={closeModal}>✕</button>

            {/* ── Sign-in view ─────────────────────────────────────────── */}
            {view === 'login' && (<>
              <div className="login-logo">
                <span className="login-logo-icon">⎈</span>
                <span className="login-logo-text">KubePilot</span>
              </div>
              <p className="login-sub">Sign in to your workspace</p>
              {resetSuccess && <div className="login-success">{resetSuccess}</div>}
              <form onSubmit={submit} className="login-form">
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com" required autoFocus />
                </div>
                <div className="field">
                  <label>Password</label>
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••" required />
                </div>
                {error && <div className="login-error">{error}</div>}
                <button type="submit" className="login-btn" disabled={loading}>
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
              <div className="login-forgot-row">
                <button type="button" className="login-forgot-link"
                  onClick={() => { setView('forgot'); setError('') }}>
                  Forgot password?
                </button>
              </div>
              {import.meta.env.DEV && (
                <div className="login-hint">
                  <span>Quick fill (dev only):</span>
                  <button type="button" className="autofill-chip"
                    onClick={() => { setEmail('admin@admin.com'); setPassword('admin') }}>Admin</button>
                  <button type="button" className="autofill-chip"
                    onClick={() => { setEmail('developer@developer.com'); setPassword('developer') }}>Developer</button>
                </div>
              )}
            </>)}

            {/* ── Forgot-password view ─────────────────────────────────── */}
            {view === 'forgot' && (<>
              <div className="login-logo">
                <span className="login-logo-icon">⎈</span>
                <span className="login-logo-text">KubePilot</span>
              </div>
              <p className="login-sub">Enter your email and we'll send a reset link</p>
              <form onSubmit={submitForgot} className="login-form">
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)}
                    placeholder="you@example.com" required autoFocus />
                </div>
                {error && <div className="login-error">{error}</div>}
                <button type="submit" className="login-btn" disabled={loading}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
              <div className="login-forgot-row">
                <button type="button" className="login-forgot-link" onClick={goBack}>← Back to sign in</button>
              </div>
            </>)}

            {/* ── Email sent confirmation ──────────────────────────────── */}
            {view === 'sent' && (<>
              <div className="login-logo">
                <span className="login-logo-icon">⎈</span>
                <span className="login-logo-text">KubePilot</span>
              </div>
              <div className="login-sent-box">
                <div className="login-sent-icon">✉</div>
                <p className="login-sent-title">Check your inbox</p>
                <p className="login-sent-body">
                  A reset link has been sent to <strong>{forgotEmail}</strong>.
                  It expires in 15 minutes.
                </p>
              </div>
              <div className="login-forgot-row">
                <button type="button" className="login-forgot-link" onClick={goBack}>← Back to sign in</button>
              </div>
            </>)}

            {/* ── Reset-password view (opened via ?reset=token URL) ────── */}
            {view === 'reset' && (<>
              <div className="login-logo">
                <span className="login-logo-icon">⎈</span>
                <span className="login-logo-text">KubePilot</span>
              </div>
              <p className="login-sub">Choose a new password</p>
              <form onSubmit={submitReset} className="login-form">
                <div className="field">
                  <label>New password</label>
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    placeholder="••••••••" required autoFocus minLength={6} />
                </div>
                <div className="field">
                  <label>Confirm password</label>
                  <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="••••••••" required minLength={6} />
                </div>
                {error && <div className="login-error">{error}</div>}
                <button type="submit" className="login-btn" disabled={loading}>
                  {loading ? 'Saving…' : 'Set new password'}
                </button>
              </form>
            </>)}

          </div>
        </div>
      )}
    </div>
  )
}

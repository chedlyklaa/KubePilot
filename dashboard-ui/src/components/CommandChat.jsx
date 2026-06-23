import { useState, useRef, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { RISK_COLOR, CATEGORY_ICON } from '../constants'

// Terminal = turn is finished and should be persisted; it breaks the clarification thread.
const TERMINAL = new Set(['done', 'denied', 'error'])

// Strip ephemeral states before storing so reloaded turns render cleanly.
function cleanTurn(t) {
  return {
    id:          t.id,
    userInput:   t.userInput,
    status:      t.status,
    plan:        t.plan    ?? null,
    result:      t.result  ?? null,
    error:       t.error   ?? null,
    recovery:    t.recovery?.status === 'ready' ? t.recovery : null,
    // Persist clarifying turns so the thread is readable on reload
    ...(t.status === 'clarifying' ? { clarifyingQuestion: t.plan?.question ?? null } : {}),
  }
}

export default function CommandChat() {
  const [turns,   setTurns]   = useState([])
  const [input,   setInput]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [loaded,  setLoaded]  = useState(false)
  const [threadId, setThreadId] = useState(1)
  const bottomRef  = useRef(null)
  const turnsRef   = useRef(turns)
  const saveTimer  = useRef(null)

  useEffect(() => { turnsRef.current = turns }, [turns])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [turns])

  // Load history from MongoDB on first mount
  useEffect(() => {
    apiFetch('/api/command/history')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.turns) && data.turns.length > 0) setTurns(data.turns)
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  // Debounced auto-save: 1.5 s after any turns change, once loaded.
  // Only save terminal turns to avoid persisting mid-stream states.
  useEffect(() => {
    if (!loaded) return
    const terminal = turns.filter(t => TERMINAL.has(t.status) || t.status === 'clarifying')
    if (terminal.length === 0) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      apiFetch('/api/command/history', {
        method: 'PUT',
        body: { turns: terminal.map(cleanTurn) },
      }).catch(() => {})
    }, 1500)
    return () => clearTimeout(saveTimer.current)
  }, [turns, loaded])

  async function clearHistory() {
    setTurns([])
    apiFetch('/api/command/history', { method: 'DELETE' }).catch(() => {})
  }

  const patchLast = fn =>
    setTurns(prev => { const a = [...prev]; a[a.length - 1] = fn(a[a.length - 1]); return a })

  const patchById = (id, fn) =>
    setTurns(prev => prev.map(t => t.id === id ? fn(t) : t))

  // Collect all clarifying turns in the current thread (from last terminal turn onward).
  // Passed to LLM2 so it has full conversation context, not just the latest answer.
  function buildConversationHistory() {
    const all = turnsRef.current
    let threadStart = 0
    for (let i = all.length - 1; i >= 0; i--) {
      if (TERMINAL.has(all[i].status)) { threadStart = i + 1; break }
    }
    return all.slice(threadStart)
      .filter(t => t.status === 'clarifying')
      .map(t => ({ userMessage: t.userInput, question: t.plan?.question ?? null }))
  }

  async function send() {
    const order = input.trim()
    if (!order || busy) return
    setInput(''); setBusy(true)

    const lastTurn = turnsRef.current[turnsRef.current.length - 1]
    const pendingRequest = lastTurn?.status === 'clarifying'
      ? (lastTurn.plan?.request ?? null)
      : null
    const conversationHistory = pendingRequest ? buildConversationHistory() : []

    const turn = {
      id:        Date.now(),
      threadId,
      userInput: order,
      status:    'thinking',
      plan:      null,
      result:    null,
      error:     null,
      recovery:  null,
    }
    setTurns(p => [...p, turn])

    try {
      const res  = await apiFetch('/api/command/interpret', {
        method: 'POST',
        body:   { order, pendingRequest, conversationHistory },
      })
      const data = await res.json()

      if (!res.ok) {
        patchLast(t => ({ ...t, status: 'error', error: data.error ?? 'Interpretation failed', recovery: null }))
        setBusy(false)
        return
      }
      // ── Phase 7: handle clarification response ────────────────────────────
      if (data.type === 'clarification') {
        patchLast(t => ({ ...t, status: 'clarifying', plan: data }))
      } else {
        // 'command' or 'provision' — proceed to approval
        patchLast(t => ({ ...t, status: 'awaiting_approval', plan: data }))
      }
    } catch (err) {
      patchLast(t => ({ ...t, status: 'error', error: err.message, recovery: null }))
    }

    setBusy(false)
  }

  async function approve(id) {
    const turn = turnsRef.current.find(t => t.id === id)

    // ── Cluster provisioning (polling) ───────────────────────────────────────
    if (turn?.plan?.type === 'provision') {
      patchById(id, t => ({ ...t, status: 'provisioning', provisionLog: '' }))
      const { profileName, tier } = turn.plan

      let jobId
      try {
        const r = await apiFetch('/api/cluster/provision/start', {
          method: 'POST',
          body: { profile: profileName, tier: tier ?? 'dev' },
        })
        const d = await r.json()
        if (!r.ok) {
          patchById(id, t => ({ ...t, status: 'error', error: d.error ?? 'Failed to start provision' }))
          return
        }
        jobId = d.jobId
      } catch (err) {
        patchById(id, t => ({ ...t, status: 'error', error: err.message }))
        return
      }

      // Poll every 2 s — safe through any proxy, no SSE/EventSource issues
      const poll = setInterval(async () => {
        try {
          const r    = await apiFetch(`/api/cluster/provision/status?id=${jobId}`)
          const data = await r.json()

          patchById(id, t => ({ ...t, provisionLog: data.log ?? '' }))

          if (data.status === 'done') {
            clearInterval(poll)
            patchById(id, t => ({
              ...t, status: 'done',
              result: `✓ Cluster "${data.profile}" created and added to monitoring.`,
            }))
          } else if (data.status === 'failed') {
            clearInterval(poll)
            patchById(id, t => ({
              ...t, status: 'error',
              error: data.error ?? 'minikube start failed — check logs above',
            }))
          }
        } catch (_e) { /* network hiccup — keep polling */ }
      }, 2000)

      return
    }

    // ── Regular kubectl command ───────────────────────────────────────────────
    patchById(id, t => ({ ...t, status: 'executing' }))
    const command = turn?.plan?.command
    try {
      const res  = await apiFetch('/api/command/execute', { method: 'POST', body: { command } })
      const data = await res.json()
      if (res.ok) {
        patchById(id, t => ({ ...t, status: 'done', result: data.output ?? null }))
      } else {
        const errMsg = data.error ?? 'Command failed'
        patchById(id, t => ({ ...t, status: 'error', error: errMsg, recovery: { status: 'analyzing' } }))
        diagnose(id, turn.userInput, command, errMsg)
      }
    } catch (err) {
      patchById(id, t => ({ ...t, status: 'error', error: err.message, recovery: { status: 'analyzing' } }))
      diagnose(id, turn.userInput, command, err.message)
    }
  }

  async function diagnose(id, order, command, errMsg) {
    try {
      const res  = await apiFetch('/api/command/diagnose', { method: 'POST', body: { order, command, error: errMsg } })
      const data = await res.json()
      patchById(id, t => ({
        ...t,
        recovery: res.ok ? { status: 'ready', ...data } : { status: 'failed' },
      }))
    } catch (_e) {
      patchById(id, t => ({ ...t, recovery: { status: 'failed' } }))
    }
  }

  function retryWithFix(originalTurn, fixedCommand) {
    const newTurn = {
      id: Date.now(),
      userInput: originalTurn.userInput,
      status: 'awaiting_approval',
      plan: {
        ...(originalTurn.plan ?? {}),
        command:     fixedCommand,
        understood:  `Retry: ${originalTurn.plan?.understood ?? originalTurn.userInput}`,
        risk:        originalTurn.plan?.risk     ?? 'MEDIUM',
        riskReason:  'Retrying with corrected command.',
        explanation: 'Fixed command based on the previous error.',
        category:    originalTurn.plan?.category ?? 'rolling-update',
      },
      result: null, error: null, recovery: null,
    }
    setTurns(p => [...p, newTurn])
  }

  function deny(id) {
    patchById(id, t => ({ ...t, status: 'denied' }))
  }

  function cancelOperation() {
    const last = turnsRef.current[turnsRef.current.length - 1]
    if (last?.status === 'clarifying') {
      patchById(last.id, t => ({ ...t, status: 'denied' }))
    }
    setThreadId(t => t + 1)
    setInput('')
  }

  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  // Determine placeholder hint based on context
  const inThread = turns.length > 0 && turns[turns.length - 1]?.status === 'clarifying'
  const inputPlaceholder = inThread
    ? 'Type your answer…'
    : 'e.g. restart nginx in default namespace…'

  return (
    <div className="cmd-chat">
      {turns.some(t => TERMINAL.has(t.status)) && (
        <div className="cmd-chat-header">
          <span className="cmd-chat-header-label">History</span>
          <button className="btn-secondary cmd-clear-btn" onClick={clearHistory}>Clear</button>
        </div>
      )}
      <div className="cmd-chat-history">
        {turns.length === 0 && (
          <div className="cmd-chat-empty">
            <span style={{ fontSize: 32, opacity: .25 }}>⎈</span>
            <p>Tell the agent what to do.<br />e.g. <em>"restart nginx in default"</em></p>
          </div>
        )}

        {turns.map((t, idx) => (
          <div key={t.id} className="cmd-turn">
            {idx > 0 && t.threadId !== turns[idx - 1].threadId && (
              <div className="cmd-thread-sep"><span>New operation</span></div>
            )}
            <div className="cmd-bubble-user">{t.userInput}</div>

            {t.status === 'thinking' && (
              <div className="cmd-bubble-agent">
                <span className="thinking-dots"><span /><span /><span /></span> Analyzing…
              </div>
            )}

            {/* ── Phase 7: clarification bubble ──────────────────────────── */}
            {t.status === 'clarifying' && t.plan && (
              <div className="cmd-bubble-agent cmd-clarify">
                <div className="cmd-clarify-icon">❓</div>
                <div className="cmd-clarify-body">
                  <p className="cmd-clarify-question">{t.plan.question}</p>
                  {t.plan.missingFields?.length > 0 && (
                    <div className="cmd-clarify-fields">
                      <span className="cmd-clarify-fields-label">Needed:</span>
                      {t.plan.missingFields.map(f => (
                        <span key={f} className="cmd-clarify-field-chip">{f.replace(/_/g, ' ')}</span>
                      ))}
                    </div>
                  )}
                  {t.plan.ambiguousCandidates?.length > 0 && (
                    <div className="cmd-clarify-candidates">
                      {t.plan.ambiguousCandidates.map(c => (
                        <span key={c} className="cmd-clarify-candidate-chip">{c}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {t.status === 'awaiting_approval' && t.plan && (
              <div className={`cmd-bubble-agent cmd-plan cmd-plan-risk-${RISK_COLOR[t.plan.risk] || 'warn'}`}>
                <div className="cmd-plan-understood">🎯 {t.plan.understood}</div>
                <div className="cmd-plan-command">
                  <span className="cmd-plan-label">Command</span>
                  <code className="cmd-code">{t.plan.command}</code>
                </div>
                <div className="cmd-safety-row">
                  {(() => {
                    const cat = CATEGORY_ICON[t.plan.category] || { icon: '?', label: t.plan.category }
                    return (
                      <span className={`cmd-category cmd-category-${RISK_COLOR[t.plan.risk] || 'warn'}`}>
                        {cat.icon} {cat.label}
                      </span>
                    )
                  })()}
                  <span className={`cmd-risk cmd-risk-${RISK_COLOR[t.plan.risk] || 'warn'}`}>
                    {t.plan.risk} risk
                  </span>
                </div>
                <div className="cmd-risk-reason">
                  <span className="cmd-plan-label">Safety note</span>
                  {t.plan.riskReason}
                </div>
                <div className="cmd-plan-explain">{t.plan.explanation}</div>
                {t.plan.risk === 'HIGH' && (
                  <div className="cmd-high-warning">⚠ High-risk operation — review the command carefully before approving.</div>
                )}
                <div className="cmd-plan-actions">
                  <button className="btn-approve cmd-btn" onClick={() => approve(t.id)}>✓ Approve</button>
                  <button className="btn-deny   cmd-btn" onClick={() => deny(t.id)}>✕ Deny</button>
                </div>
              </div>
            )}

            {t.status === 'executing' && (
              <div className="cmd-bubble-agent">
                <span className="thinking-dots"><span /><span /><span /></span> Executing…
              </div>
            )}

            {t.status === 'provisioning' && (
              <div className="cmd-bubble-agent cmd-provisioning">
                <div className="cmd-prov-header">
                  <span className="thinking-dots"><span /><span /><span /></span>
                  Provisioning cluster — this takes 1–5 minutes…
                </div>
                {t.provisionLog && (
                  <pre className="cmd-prov-log">{t.provisionLog}</pre>
                )}
              </div>
            )}

            {t.status === 'done' && (
              <div className="cmd-bubble-agent cmd-result">
                <span className="cmd-result-ok">✓ Done</span>
                <pre className="cmd-output">{t.result}</pre>
              </div>
            )}

            {t.status === 'denied' && (
              <div className="cmd-bubble-agent cmd-denied">✕ Command cancelled</div>
            )}

            {t.status === 'error' && (
              <div className="cmd-bubble-agent cmd-error">
                <div className="cmd-error-msg">⚠ {t.error}</div>

                {t.recovery?.status === 'analyzing' && (
                  <div className="cmd-recovery-analyzing">
                    <span className="thinking-dots"><span /><span /><span /></span> Figuring out what went wrong…
                  </div>
                )}

                {t.recovery?.status === 'ready' && (
                  <div className="cmd-recovery">
                    <p className="cmd-recovery-diagnosis">{t.recovery.diagnosis}</p>
                    <p className="cmd-recovery-suggestion">{t.recovery.suggestion}</p>
                    {t.recovery.fixedCommand && (
                      <div className="cmd-recovery-fix">
                        <span className="cmd-plan-label">Suggested fix</span>
                        <code className="cmd-code">{t.recovery.fixedCommand}</code>
                        <button
                          className="btn-approve cmd-btn cmd-btn-sm"
                          onClick={() => retryWithFix(t, t.recovery.fixedCommand)}
                        >
                          Try fix ↑
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {inThread && (
        <div className="cmd-cancel-bar">
          <span className="cmd-cancel-hint">Clarification in progress</span>
          <button className="cmd-cancel-btn" onClick={cancelOperation}>Cancel operation</button>
        </div>
      )}
      <div className="cmd-chat-input-row">
        <input
          className="cmd-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={inputPlaceholder}
          disabled={busy}
        />
        <button className="btn-primary cmd-send" onClick={send} disabled={busy || !input.trim()}>
          {busy ? '◌' : '↑'}
        </button>
      </div>
    </div>
  )
}

import { useState, useRef, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { RISK_COLOR, CATEGORY_ICON } from '../constants'

const TERMINAL = new Set(['done', 'denied', 'error'])

// Strip ephemeral states before storing so reloaded turns render cleanly
function cleanTurn(t) {
  return {
    id:        t.id,
    userInput: t.userInput,
    status:    t.status,
    plan:      t.plan   ?? null,
    result:    t.result ?? null,
    error:     t.error  ?? null,
    recovery:  t.recovery?.status === 'ready' ? t.recovery : null,
  }
}

export default function CommandChat() {
  const [turns,   setTurns]   = useState([])
  const [input,   setInput]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [loaded,  setLoaded]  = useState(false)
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

  // Debounced auto-save: 1.5s after any turns change, once loaded
  useEffect(() => {
    if (!loaded) return
    const terminal = turns.filter(t => TERMINAL.has(t.status))
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

  async function send() {
    const order = input.trim()
    if (!order || busy) return
    setInput(''); setBusy(true)

    const turn = { id: Date.now(), userInput: order, status: 'thinking', plan: null, result: null, error: null, recovery: null }
    setTurns(p => [...p, turn])

    try {
      const res  = await apiFetch('/api/command/interpret', { method: 'POST', body: { order } })
      const data = await res.json()
      if (!res.ok) {
        patchLast(t => ({ ...t, status: 'error', error: data.error ?? 'Interpretation failed', recovery: null }))
        setBusy(false)
        return
      }
      patchLast(t => ({ ...t, status: 'awaiting_approval', plan: data }))
    } catch (err) {
      patchLast(t => ({ ...t, status: 'error', error: err.message, recovery: null }))
    }

    setBusy(false)
  }

  async function approve(id) {
    patchById(id, t => ({ ...t, status: 'executing' }))
    const turn    = turnsRef.current.find(t => t.id === id)
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
    } catch {
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

  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

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

        {turns.map(t => (
          <div key={t.id} className="cmd-turn">
            <div className="cmd-bubble-user">{t.userInput}</div>

            {t.status === 'thinking' && (
              <div className="cmd-bubble-agent">
                <span className="thinking-dots"><span /><span /><span /></span> Analyzing…
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

      <div className="cmd-chat-input-row">
        <input
          className="cmd-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. restart nginx in default namespace…"
          disabled={busy}
        />
        <button className="btn-primary cmd-send" onClick={send} disabled={busy || !input.trim()}>
          {busy ? '◌' : '↑'}
        </button>
      </div>
    </div>
  )
}

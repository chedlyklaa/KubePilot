import { useState, useRef, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { RISK_COLOR, CATEGORY_ICON } from '../constants'

export default function CommandChat() {
  const [turns,  setTurns]  = useState([])
  const [input,  setInput]  = useState('')
  const [busy,   setBusy]   = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [turns])

  const patchLast = fn =>
    setTurns(prev => { const a = [...prev]; a[a.length - 1] = fn(a[a.length - 1]); return a })

  async function send() {
    const order = input.trim()
    if (!order || busy) return
    setInput(''); setBusy(true)

    const turn = { id: Date.now(), userInput: order, status: 'thinking', plan: null, result: null, error: null }
    setTurns(p => [...p, turn])

    try {
      const res  = await apiFetch('/api/command/interpret', { method: 'POST', body: { order } })
      const data = await res.json()
      if (!res.ok) { patchLast(t => ({ ...t, status: 'error', error: data.error ?? 'Interpretation failed' })); setBusy(false); return }
      patchLast(t => ({ ...t, status: 'awaiting_approval', plan: data }))
    } catch (err) {
      patchLast(t => ({ ...t, status: 'error', error: err.message }))
    }

    setBusy(false)
  }

  async function approve(id) {
    setTurns(p => p.map(t => t.id === id ? { ...t, status: 'executing' } : t))
    const command = turns.find(t => t.id === id)?.plan?.command
    try {
      const res  = await apiFetch('/api/command/execute', { method: 'POST', body: { command } })
      const data = await res.json()
      setTurns(p => p.map(t => t.id === id
        ? { ...t, status: res.ok ? 'done' : 'error', result: data.output ?? null, error: data.error ?? null }
        : t))
    } catch (err) {
      setTurns(p => p.map(t => t.id === id ? { ...t, status: 'error', error: err.message } : t))
    }
  }

  function deny(id) {
    setTurns(p => p.map(t => t.id === id ? { ...t, status: 'denied' } : t))
  }

  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  return (
    <div className="cmd-chat">
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
              <div className="cmd-bubble-agent cmd-error">⚠ {t.error}</div>
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

import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'

export default function ChatPage() {
  const { user }   = useAuth()
  const chatKey    = `kubepilot_chat_${user.id}`
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(chatKey)) || [] } catch { return [] }
  })
  const [input,   setInput]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [elapsed, setElapsed] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // Load from MongoDB on mount (source of truth across sessions)
  useEffect(() => {
    apiFetch('/api/chat/history').then(r => r.json()).then(data => {
      if (Array.isArray(data.messages) && data.messages.length > 0) {
        setMessages(data.messages)
        localStorage.setItem(chatKey, JSON.stringify(data.messages))
      }
    }).catch(() => {})
  }, [chatKey])

  async function saveToDb(finalMessages) {
    apiFetch('/api/chat/history', { method: 'PUT', body: { messages: finalMessages } }).catch(() => {})
  }

  async function send() {
    const text = input.trim()
    if (!text || busy) return

    const history = [...messages, { role: 'user', content: text }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setInput(''); setBusy(true); setElapsed(null)

    const patch = fn => setMessages(prev => {
      const upd = [...prev]
      upd[upd.length - 1] = fn(upd[upd.length - 1])
      return upd
    })

    let assistantContent = ''
    try {
      const res = await fetch('/api/chat/stream', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body:    JSON.stringify({ messages: history }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        patch(m => ({ ...m, content: `⚠ ${err.error}`, error: true }))
        setBusy(false); return
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buf     = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.content) { assistantContent += ev.content; patch(m => ({ ...m, content: m.content + ev.content })) }
            if (ev.done)    setElapsed(ev.elapsed)
            if (ev.error)   patch(m => ({ ...m, content: `⚠ ${ev.error}`, error: true }))
          } catch {}
        }
      }
    } catch (err) {
      patch(m => ({ ...m, content: `⚠ ${err.message}`, error: true }))
    }

    const finalMessages = [...history, { role: 'assistant', content: assistantContent }]
    localStorage.setItem(chatKey, JSON.stringify(finalMessages))
    saveToDb(finalMessages)
    setBusy(false)
  }

  async function clearHistory() {
    setMessages([]); setElapsed(null)
    localStorage.removeItem(chatKey)
    apiFetch('/api/chat/history', { method: 'DELETE' }).catch(() => {})
  }

  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  return (
    <div className="chat-page">
      <div className="chat-page-header">
        <div>
          <h2>AI Assistant</h2>
          <p className="page-subtitle">Direct LLM test — measure response time</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {elapsed != null && <span className="elapsed-badge">⏱ {(elapsed / 1000).toFixed(2)}s</span>}
          <button className="btn-secondary" onClick={clearHistory}>Clear</button>
        </div>
      </div>

      <div className="chat-page-msgs">
        {messages.length === 0 && (
          <div className="chat-page-empty">
            <span style={{ fontSize: 44, opacity: .2 }}>🤖</span>
            <p>Ask anything about Kubernetes, YAML, or deployments…</p>
            <div className="chat-suggestions">
              {['Why is my pod in CrashLoopBackOff?', 'How do I rollback a deployment?', 'What does OOMKilled mean?'].map(s => (
                <button key={s} className="suggestion-chip" onClick={() => setInput(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg-row chat-msg-${msg.role}`}>
            <div className={`chat-bubble-page ${msg.error ? 'bubble-error' : ''}`}>
              {msg.content || (msg.role === 'assistant' && busy && i === messages.length - 1
                ? <span className="thinking-dots"><span /><span /><span /></span>
                : null
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="chat-page-input-row">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about Kubernetes… (Enter to send, Shift+Enter for new line)"
          rows={3}
          disabled={busy}
        />
        <button className="btn-primary chat-send-btn" onClick={send} disabled={busy || !input.trim()}>
          {busy ? '◌' : '↑'}
        </button>
      </div>
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'

const GENERAL_CHIPS = [
  'Why is my pod in CrashLoopBackOff?',
  'How do I rollback a deployment?',
  'What does OOMKilled mean and how do I fix it?',
  'Explain HPA vs VPA vs KEDA',
  'How do I debug a pod stuck in Pending?',
  'What is the difference between a Deployment and a StatefulSet?',
]

const CLUSTER_CHIPS = [
  'Show me all pods that have issues right now',
  'Which pods have the most restarts?',
  'Are there any active escalations and what caused them?',
  'Describe the health of the default namespace',
  'Should I approve or deny the pending approvals?',
  'Give me a full cluster health report as PDF',
]

// Keywords that trigger the per-message PDF download button
const PDF_KEYWORDS = /\b(pdf|report|download|export|summary|incident)\b/i

function isPdfRequest(messages, index) {
  if (messages[index]?.role !== 'assistant') return false
  const prev = messages[index - 1]
  return !!(prev?.role === 'user' && PDF_KEYWORDS.test(prev.content))
}

// Minimal markdown → HTML converter for report PDFs
function mdToHtml(raw) {
  // Extract code blocks first so we don't mangle them
  const blocks = []
  let t = raw.replace(/```[\w]*\n?([\s\S]*?)```/gm, (_, code) => {
    blocks.push(code.trim())
    return `\x00CODE${blocks.length - 1}\x00`
  })

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  t = esc(t)

  // Restore code blocks
  t = t.replace(/\x00CODE(\d+)\x00/g, (_, i) =>
    `<pre class="code">${esc(blocks[+i])}</pre>`)

  t = t
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm,  '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,   '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,    '<h1>$1</h1>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,         '<em>$1</em>')
    .replace(/`([^`]+)`/g,         '<code>$1</code>')
    .replace(/^[-*•] (.+)$/gm,     '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm,     '<li class="ol">$1</li>')
    .replace(/^---+$/gm,           '<hr>')

  // Wrap consecutive li items
  t = t.replace(/(<li(?:\s[^>]*)?>[\s\S]*?<\/li>\n?)+/g, m =>
    m.includes('class="ol"')
      ? `<ol>${m.replace(/ class="ol"/g, '')}</ol>`
      : `<ul>${m}</ul>`)

  // Paragraphs
  t = `<p>${t.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`

  // Clean up block-level tags wrapped in <p>
  ;['h1','h2','h3','h4','ul','ol','pre','hr'].forEach(tag => {
    t = t
      .replace(new RegExp(`<p>(<${tag}[\\s>])`, 'g'), '$1')
      .replace(new RegExp(`(</${tag}>)<\\/p>`, 'g'), '$1')
  })
  t = t.replace(/<p>\s*<\/p>/g, '').replace(/<p>(<hr>)<\/p>/g, '$1')
  return t
}

function downloadReportPdf(content, question) {
  const win = window.open('', '_blank', 'width=940,height=720')
  if (!win) return

  // Strip the cluster data prefix from the question if present
  const cleanQ = (question ?? 'Report')
    .replace(/\[LIVE CLUSTER DATA\][\s\S]*?\[MY QUESTION\]\n?/i, '')
    .trim()
    .slice(0, 100)

  win.document.write(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>${cleanQ}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body   { font-family: 'Segoe UI', Arial, sans-serif; padding: 36px 48px; max-width: 900px; margin: 0 auto; color: #111827; font-size: 13.5px; line-height: 1.75; }
  .rhead { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #6366f1; padding-bottom: 14px; margin-bottom: 6px; }
  .rlogo { font-size: 18px; font-weight: 800; color: #6366f1; }
  .rmeta { font-size: 11px; color: #9ca3af; margin-bottom: 26px; }
  .rtitle{ font-size: 16px; font-weight: 700; color: #111827; margin-bottom: 22px; }
  h1 { font-size: 18px; font-weight: 700; color: #1e293b; margin: 22px 0 10px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; }
  h2 { font-size: 15px; font-weight: 700; color: #1e293b; margin: 18px 0 8px; }
  h3 { font-size: 13.5px; font-weight: 700; color: #374151; margin: 14px 0 6px; }
  h4 { font-size: 13px; font-weight: 600; color: #4b5563; margin: 12px 0 5px; }
  p  { margin: 6px 0; }
  ul, ol { padding-left: 22px; margin: 8px 0; }
  li { margin: 4px 0; }
  pre.code { background: #f8fafc; border: 1px solid #e2e8f0; border-left: 3px solid #6366f1; border-radius: 6px; padding: 12px 16px; font-size: 11.5px; font-family: 'Cascadia Code','Consolas',monospace; white-space: pre-wrap; margin: 10px 0; }
  code { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 3px; padding: 1px 5px; font-family: 'Cascadia Code','Consolas',monospace; font-size: 11.5px; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 18px 0; }
  strong { font-weight: 700; color: #1e293b; }
  @page { margin: 18mm 20mm; }
  @media print { body { padding: 0; } }
</style>
</head><body>
<div class="rhead">
  <div class="rlogo">⎈ KubePilot</div>
  <div style="font-size:11px;color:#9ca3af;">${new Date().toLocaleString()}</div>
</div>
<div class="rmeta">AI-generated report · KubePilot Dashboard</div>
<div class="rtitle">${cleanQ}</div>
${mdToHtml(content)}
</body></html>`)

  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 400)
}

export default function ChatPage() {
  const { user }   = useAuth()
  const chatKey    = `kubepilot_chat_${user.id}`

  const [messages,           setMessages]           = useState(() => {
    try { return JSON.parse(localStorage.getItem(chatKey)) || [] } catch { return [] }
  })
  const [input,              setInput]              = useState('')
  const [busy,               setBusy]               = useState(false)
  const [elapsed,            setElapsed]            = useState(null)
  const [withClusterContext, setWithClusterContext]  = useState(false)
  const [clusterLoading,     setClusterLoading]      = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    apiFetch('/api/chat/history').then(r => r.json()).then(data => {
      if (Array.isArray(data.messages) && data.messages.length > 0) {
        setMessages(data.messages)
        localStorage.setItem(chatKey, JSON.stringify(data.messages))
      }
    }).catch(() => {})
  }, [chatKey])

  function saveToDb(msgs) {
    apiFetch('/api/chat/history', { method: 'PUT', body: { messages: msgs } }).catch(() => {})
  }

  async function send() {
    const text = input.trim()
    if (!text || busy) return

    const displayHistory = [...messages, { role: 'user', content: text }]
    setMessages([...displayHistory, { role: 'assistant', content: '' }])
    setInput(''); setBusy(true); setElapsed(null)

    const patch = fn => setMessages(prev => {
      const upd = [...prev]
      upd[upd.length - 1] = fn(upd[upd.length - 1])
      return upd
    })

    let apiHistory = displayHistory
    if (withClusterContext) {
      try {
        const r = await apiFetch('/api/chat/cluster-context')
        const { text: snapshot } = await r.json()
        apiHistory = [
          ...messages,
          { role: 'user', content: `[LIVE CLUSTER DATA]\n${snapshot}\n\n[MY QUESTION]\n${text}` },
        ]
      } catch { /* cluster unreachable */ }
    }

    let assistantContent = ''
    try {
      const res = await fetch('/api/chat/stream', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body:    JSON.stringify({ messages: apiHistory, withClusterContext }),
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

    const finalMessages = [...displayHistory, { role: 'assistant', content: assistantContent }]
    localStorage.setItem(chatKey, JSON.stringify(finalMessages))
    saveToDb(finalMessages)
    setBusy(false)
  }

  async function clearHistory() {
    setMessages([]); setElapsed(null)
    localStorage.removeItem(chatKey)
    apiFetch('/api/chat/history', { method: 'DELETE' }).catch(() => {})
  }

  async function toggleClusterMode() {
    const next = !withClusterContext
    setWithClusterContext(next)
    if (next) {
      setClusterLoading(true)
      try {
        const r = await apiFetch('/api/chat/cluster-context')
        if (!r.ok) throw new Error()
      } catch {
        setWithClusterContext(false)
      } finally {
        setClusterLoading(false)
      }
    }
  }

  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
  const chips     = withClusterContext ? CLUSTER_CHIPS : GENERAL_CHIPS

  return (
    <div className="chat-page">
      <div className="chat-page-header">
        <div>
          <h2>AI Assistant</h2>
          <p className="page-subtitle">
            {withClusterContext
              ? 'Reading live cluster state — read-only'
              : 'Senior Kubernetes SRE & DevOps expert'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {elapsed != null && <span className="elapsed-badge">⏱ {(elapsed / 1000).toFixed(2)}s</span>}
          <button
            className={`chat-cluster-btn ${withClusterContext ? 'chat-cluster-btn-active' : ''}`}
            onClick={toggleClusterMode}
            disabled={clusterLoading}
            title={withClusterContext ? 'Disconnect from live cluster' : 'Connect to live cluster (read-only)'}
          >
            {clusterLoading ? '◌' : '⎈'} {withClusterContext ? 'Live' : 'Cluster'}
          </button>
          <button className="btn-secondary" onClick={clearHistory}>Clear</button>
        </div>
      </div>

      <div className="chat-page-msgs">
        {messages.length === 0 && (
          <div className="chat-page-empty">
            <span style={{ fontSize: 44, opacity: .2 }}>⎈</span>
            <p>
              {withClusterContext
                ? 'Ask anything about your live cluster — pod health, escalations, resource usage…'
                : 'Ask anything about Kubernetes, YAML, Helm, GitOps, or cloud infrastructure…'}
            </p>
            <div className="chat-suggestions">
              {chips.map(s => (
                <button key={s} className="suggestion-chip" onClick={() => setInput(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg-row chat-msg-${msg.role}`}>
            {msg.role === 'assistant' ? (
              <div className="chat-assistant-wrap">
                <div className={`chat-bubble-page ${msg.error ? 'bubble-error' : ''}`}>
                  {msg.content || (busy && i === messages.length - 1
                    ? <span className="thinking-dots"><span /><span /><span /></span>
                    : null
                  )}
                </div>
                {isPdfRequest(messages, i) && msg.content && !(busy && i === messages.length - 1) && (
                  <button
                    className="msg-pdf-btn"
                    onClick={() => downloadReportPdf(msg.content, messages[i - 1]?.content)}
                    title="Download this report as PDF"
                  >
                    📥 Download PDF
                  </button>
                )}
              </div>
            ) : (
              <div className={`chat-bubble-page ${msg.error ? 'bubble-error' : ''}`}>
                {msg.content}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="chat-page-input-row">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={withClusterContext
            ? 'Ask about your live cluster… (Enter to send)'
            : 'Ask about Kubernetes… (Enter to send, Shift+Enter for new line)'}
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

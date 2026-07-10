import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { detectIntent } from '../lib/intentClassifier'
import { renderStructuredReport, renderMarkdownPdf } from '../lib/reportRenderer'

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

// ── Memoized markdown renderer — only re-parses when content changes ──────
const MarkdownBubble = memo(function MarkdownBubble({ content }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
})

// ── Memoized message bubble — skips re-render for unchanged messages ───────
const MessageBubble = memo(function MessageBubble({ msg, i, isLast, busy, pdfGenerating, onPdf, onEnableLive }) {
  if (msg.role === 'assistant') {
    return (
      <div className="chat-assistant-wrap">
        {msg.isClusterPrompt ? (
          <div className="chat-bubble-page cluster-prompt-bubble">
            <span>⎈ This question is about your live cluster. Connect first, then ask again.</span>
            <button className="cluster-prompt-btn" onClick={onEnableLive}>Enable Live Mode</button>
          </div>
        ) : (
          <div className={`chat-bubble-page ${msg.error ? 'bubble-error' : ''}`}>
            {!msg.content && busy && isLast
              ? <span className="thinking-dots"><span /><span /><span /></span>
              : <MarkdownBubble content={msg.content} />
            }
          </div>
        )}
        {msg.isPdfRequest && msg.content && !(busy && isLast) && (
          <button
            className="msg-pdf-btn"
            onClick={() => onPdf(i)}
            disabled={pdfGenerating === i}
            title="Download this report as PDF"
          >
            {pdfGenerating === i
              ? <><span className="thinking-dots"><span /><span /><span /></span> Preparing report…</>
              : <><span className="pdf-btn-icon">⬇</span> Download Report</>
            }
          </button>
        )}
      </div>
    )
  }
  return (
    <div className={`chat-bubble-page ${msg.error ? 'bubble-error' : ''}`}>
      {msg.content}
    </div>
  )
})

// ── Input box lives in its own component — its state changes are isolated ──
// This prevents every keystroke from re-rendering the message list above.
const ChatInput = memo(function ChatInput({ onSend, busy, withClusterContext }) {
  const [input, setInput] = useState('')

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    onSend(text)
    setInput('')
  }, [input, busy, onSend])

  const onKeyDown = useCallback(e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend])

  return (
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
      <button className="btn-primary chat-send-btn" onClick={handleSend} disabled={busy || !input.trim()}>
        {busy ? '◌' : '↑'}
      </button>
    </div>
  )
})

const INITIAL_LOAD = 10
const PAGE_SIZE = 6

export default function ChatPage() {
  const { user }   = useAuth()
  const chatKey    = `kubepilot_chat_${user.id}`

  const [messages,           setMessages]           = useState([])
  const [busy,               setBusy]               = useState(false)
  const [elapsed,            setElapsed]            = useState(null)
  const [withClusterContext, setWithClusterContext]  = useState(false)
  const [clusterLoading,     setClusterLoading]      = useState(false)
  const [pdfGenerating,      setPdfGenerating]       = useState(null)
  const [hasMore,            setHasMore]             = useState(false)
  const [loadingMore,        setLoadingMore]         = useState(false)
  const [initialLoading,     setInitialLoading]      = useState(true)
  const [totalCount,         setTotalCount]          = useState(0)
  const [showScrollBtn,      setShowScrollBtn]       = useState(false)
  const bottomRef  = useRef(null)
  const msgsRef    = useRef(null)
  const scrollLock = useRef(false)
  const didFetch   = useRef(false)
  const userScrolled = useRef(false)

  const messagesRef = useRef(messages)
  useEffect(() => { messagesRef.current = messages }, [messages])

  const prevMsgCount  = useRef(0)
  const pendingScroll = useRef(null)
  useLayoutEffect(() => {
    const el = msgsRef.current
    if (pendingScroll.current != null && el) {
      el.scrollTop = el.scrollHeight - pendingScroll.current
      pendingScroll.current = null
      scrollLock.current = false
    } else if (messages.length > prevMsgCount.current && !scrollLock.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevMsgCount.current = messages.length
  }, [messages])

  useEffect(() => {
    if (didFetch.current) return
    didFetch.current = true
    apiFetch(`/api/chat/history?limit=${INITIAL_LOAD}`).then(r => r.json()).then(data => {
      if (Array.isArray(data.messages)) {
        setMessages(data.messages)
        setHasMore(data.hasMore ?? false)
        setTotalCount(data.total ?? data.messages.length)
      }
    }).catch(() => {}).finally(() => setInitialLoading(false))
  }, [chatKey])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    scrollLock.current = true
    const el = msgsRef.current
    const prevHeight = el?.scrollHeight ?? 0
    try {
      const before = totalCount - messages.length
      const r = await apiFetch(`/api/chat/history?limit=${PAGE_SIZE}&before=${before}`)
      const data = await r.json()
      if (Array.isArray(data.messages) && data.messages.length > 0) {
        pendingScroll.current = prevHeight
        setMessages(prev => [...data.messages, ...prev])
        setHasMore(data.hasMore ?? false)
      } else {
        setHasMore(false)
        scrollLock.current = false
      }
    } catch {
      scrollLock.current = false
    }
    setLoadingMore(false)
  }, [loadingMore, hasMore, totalCount, messages.length])

  useEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const armTimer = setTimeout(() => { userScrolled.current = true }, 1000)
    const onScroll = () => {
      if (!userScrolled.current) return
      if (el.scrollTop < 60 && hasMore && !loadingMore) loadMore()
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollBtn(distFromBottom > 200)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { clearTimeout(armTimer); el.removeEventListener('scroll', onScroll) }
  }, [hasMore, loadingMore, loadMore])

  function appendToDb(newMsgs) {
    apiFetch('/api/chat/history', { method: 'PATCH', body: { messages: newMsgs } })
      .then(r => r.json())
      .then(data => { if (data.total) setTotalCount(data.total) })
      .catch(() => {})
  }

  const generatePdf = useCallback(async (msgIndex) => {
    const content = messagesRef.current[msgIndex]?.content
    if (!content) return
    setPdfGenerating(msgIndex)
    try {
      const res = await apiFetch('/api/chat/pdf-report', {
        method: 'POST',
        body: {
          messages: messagesRef.current.slice(Math.max(0, msgIndex - 4), msgIndex + 1),
          reportContent: content,
        },
      })
      if (res.ok) {
        const report = await res.json()
        if (report.title && report.sections) {
          renderStructuredReport(report)
          return
        }
      }
      renderMarkdownPdf(content)
    } catch {
      renderMarkdownPdf(content)
    } finally {
      setTimeout(() => setPdfGenerating(null), 600)
    }
  }, [])

  const send = useCallback(async (text) => {
    if (busy) return
    const { intent, confidence, scores } = detectIntent(text)
    const userMsg = { role: 'user', content: text }

    const needsCluster = intent === 'cluster_debug' ||
      (intent === 'export_pdf' && (scores.cluster_debug ?? 0) > 2)

    if (needsCluster && !withClusterContext) {
      const prompt = {
        role:            'assistant',
        content:         '⎈ This question is about your live cluster. Please click the **⎈ Live** button above to connect, then ask again.',
        isClusterPrompt: true,
      }
      setMessages(prev => [...prev, userMsg, prompt])
      appendToDb([userMsg, prompt])
      return
    }

    const wantsPdf = intent === 'export_pdf' && confidence >= 0.2
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setBusy(true); setElapsed(null)

    const patch = fn => setMessages(prev => {
      const upd = [...prev]
      upd[upd.length - 1] = fn(upd[upd.length - 1])
      return upd
    })

    const currentMsgs = messagesRef.current
    const apiUserMsg = wantsPdf
      ? { role: 'user', content: `${text}\n\n[Note: produce a comprehensive, well-structured report with headings, tables, and bullet points. The KubePilot dashboard will provide a PDF download button automatically — do NOT say you cannot generate files.]` }
      : userMsg
    let apiHistory = [
      ...currentMsgs.slice(-2),
      apiUserMsg,
    ]
    if (withClusterContext) {
      try {
        const r = await apiFetch('/api/chat/cluster-context')
        const { text: snapshot } = await r.json()
        const suffix = wantsPdf ? '\n\n[Note: produce a comprehensive structured report. The KubePilot dashboard provides a PDF download button — do NOT say you cannot generate files.]' : ''
        apiHistory = [
          ...currentMsgs.slice(-1),
          { role: 'user', content: `[LIVE CLUSTER DATA]\n${snapshot}\n\n[MY QUESTION]\n${text}${suffix}` },
        ]
      } catch { /* cluster unreachable */ }
    }

    let assistantContent = ''
    let hadError = false
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
            if (ev.error)   { patch(m => ({ ...m, content: `⚠ ${ev.error}`, error: true })); hadError = true }
          } catch {}
        }
      }
    } catch (err) {
      patch(m => ({ ...m, content: `⚠ ${err.message}`, error: true }))
      hadError = true
    }

    if (!hadError) {
      const assistantMsg  = { role: 'assistant', content: assistantContent, ...(wantsPdf && { isPdfRequest: true }) }
      setMessages(prev => [...prev.slice(0, -1), assistantMsg])
      appendToDb([userMsg, assistantMsg])
    } else {
      const errorMsg = { role: 'assistant', content: assistantContent || 'Request failed', error: true }
      appendToDb([userMsg, errorMsg])
    }
    setBusy(false)
  }, [withClusterContext, busy])

  async function clearHistory() {
    setMessages([]); setElapsed(null)
    setHasMore(false); setTotalCount(0)
    apiFetch('/api/chat/history', { method: 'DELETE' }).catch(() => {})
  }

  const toggleClusterMode = useCallback(async () => {
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
  }, [withClusterContext])

  const chips = withClusterContext ? CLUSTER_CHIPS : GENERAL_CHIPS

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

      <div className="chat-page-msgs" ref={msgsRef}>
        {loadingMore && (
          <div className="chat-load-more">
            <div className="chat-load-spinner">
              <svg className="chat-load-ring" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" />
              </svg>
              <span>Loading older messages</span>
            </div>
          </div>
        )}
        {!loadingMore && hasMore && (
          <div className="chat-load-more">
            <button className="chat-load-btn" onClick={loadMore}>
              <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" fill="currentColor" opacity=".6"/></svg>
              Load older messages
            </button>
          </div>
        )}
        {initialLoading && (
          <div className="chat-initial-loading">
            <svg className="chat-load-ring chat-load-ring-lg" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
            </svg>
            <span>Loading conversation</span>
          </div>
        )}
        {messages.length === 0 && !loadingMore && !initialLoading && (
          <div className="chat-page-empty">
            <span style={{ fontSize: 44, opacity: .2 }}>⎈</span>
            <p>
              {withClusterContext
                ? 'Ask anything about your live cluster — pod health, escalations, resource usage…'
                : 'Ask anything about Kubernetes, YAML, Helm, GitOps, or cloud infrastructure…'}
            </p>
            <div className="chat-suggestions">
              {chips.map(s => (
                <button key={s} className="suggestion-chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg-row chat-msg-${msg.role}`}>
            <MessageBubble
              msg={msg}
              i={i}
              isLast={i === messages.length - 1}
              busy={busy}
              pdfGenerating={pdfGenerating}
              onPdf={generatePdf}
              onEnableLive={toggleClusterMode}
            />
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {showScrollBtn && (
        <button className="chat-scroll-btn" onClick={() => {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
          setShowScrollBtn(false)
        }} title="Jump to latest message">
          <svg viewBox="0 0 16 16" width="18" height="18"><path d="M8 11.5a.75.75 0 01-.53-.22l-3.5-3.5a.75.75 0 111.06-1.06L8 9.69l2.97-2.97a.75.75 0 111.06 1.06l-3.5 3.5a.75.75 0 01-.53.22z" fill="currentColor"/></svg>
        </button>
      )}

      <ChatInput onSend={send} busy={busy} withClusterContext={withClusterContext} />
    </div>
  )
}

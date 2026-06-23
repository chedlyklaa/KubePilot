import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, getToken } from '../lib/api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { marked } from 'marked'

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

// ── Intent classifier ──────────────────────────────────────────────────────
function detectIntent(text) {
  const lower = text.toLowerCase()

  const PDF_PATTERNS = [
    { re: /\b(generate|create|make|build|give\s+me)\s+(\w+\s+){0,3}report\b/, score: 6 },
    { re: /\b(download|export|save)\s+(\w+\s+){0,2}report\b/,                  score: 6 },
    { re: /\b(generate|create|export|save|make)\s+(\w+\s+){0,2}pdf\b/,          score: 6 },
    { re: /\bexport\s+as\s+pdf\b/,                                               score: 6 },
    { re: /\bsave\s+as\s+pdf\b/,                                                 score: 6 },
    { re: /\bhealth\s+report\b/,                                                 score: 5 },
    { re: /\bcluster\s+(\w+\s+)?report\b/,                                       score: 6 },
    { re: /\bstatus\s+report\b/,                                                 score: 5 },
    { re: /\brapport\b/,                                                         score: 4 },
  ]

  const INTENTS = {
    export_pdf: {
      patterns: PDF_PATTERNS,
      keywords: [
        { text: 'pdf',      score: 3 },
        { text: 'report',   score: 2 },
        { text: 'download', score: 2 },
        { text: 'export',   score: 2 },
      ],
    },
    cluster_debug: {
      phrases: [
        { text: 'my pods are crashing',             score: 5 },
        { text: 'cluster is down',                  score: 5 },
        { text: 'what is wrong with my cluster',    score: 5 },
        { text: 'show cluster health',              score: 5 },
        { text: 'show me all pods',                 score: 5 },
        { text: 'which pods have',                  score: 5 },
        { text: 'active escalations',               score: 5 },
        { text: 'health of the default namespace',  score: 5 },
        { text: 'pending approvals',                score: 4 },
        { text: 'my cluster',                       score: 4 },
        { text: 'my pods',                          score: 4 },
        { text: 'my nodes',                         score: 4 },
        { text: 'right now',                        score: 3 },
        { text: 'currently running',                score: 4 },
        { text: 'currently failing',                score: 4 },
        { text: 'show me',                          score: 3 },
      ],
      keywords: [
        { text: 'cluster',    score: 2 },
        { text: 'pods',       score: 2 },
        { text: 'nodes',      score: 2 },
        { text: 'crash',      score: 2 },
        { text: 'crashing',   score: 2 },
        { text: 'failing',    score: 2 },
        { text: 'restart',    score: 2 },
        { text: 'kubernetes', score: 2 },
        { text: 'namespace',  score: 2 },
        { text: 'deployment', score: 2 },
        { text: 'escalation', score: 2 },
        { text: 'minikube',   score: 3 },
      ],
    },
    explain: {
      phrases: [
        { text: 'what is the difference', score: 5 },
        { text: 'how does',               score: 5 },
        { text: 'how do i',               score: 5 },
        { text: 'how to',                 score: 5 },
        { text: 'what is',                score: 4 },
        { text: 'what are',               score: 4 },
        { text: 'explain the',            score: 5 },
        { text: 'can you explain',        score: 5 },
        { text: 'difference between',     score: 5 },
        { text: 'why does',               score: 4 },
        { text: 'why is',                 score: 4 },
        { text: 'what does',              score: 4 },
        { text: 'what do',                score: 4 },
      ],
      keywords: [
        { text: 'explain',    score: 2 },
        { text: 'definition', score: 2 },
        { text: 'meaning',    score: 2 },
      ],
    },
  }

  const scores = {}
  for (const [intent, def] of Object.entries(INTENTS)) {
    let score = 0
    for (const pat of (def.patterns ?? [])) {
      if (pat.re.test(lower)) score += pat.score
    }
    for (const phrase of (def.phrases ?? [])) {
      if (lower.includes(phrase.text)) score += phrase.score
    }
    for (const kw of def.keywords) {
      const re = new RegExp(`\\b${kw.text}\\b`)
      if (re.test(lower)) score += kw.score + Math.floor(kw.text.length / 4)
    }
    scores[intent] = score
  }

  const maxScore = Math.max(...Object.values(scores))
  if (maxScore < 2) return { intent: 'chat', confidence: 0, scores }

  const [bestIntent] = Object.entries(scores).reduce(
    (best, curr) => (curr[1] > best[1] ? curr : best),
    ['chat', 0]
  )

  return { intent: bestIntent, confidence: Math.min(maxScore / 15, 1.0), scores }
}

// ── Severity detection from markdown text ─────────────────────────────────
function detectSeverity(text) {
  const t = text.toLowerCase()
  if (/critical|crashloop|oomkill|evict|not ready|down\b|unavailable/.test(t)) return 'critical'
  if (/warn|high|pending|failed|error|throttl|pressure/.test(t))               return 'warn'
  return 'ok'
}

function extractTitle(text) {
  const h = text.match(/^#{1,3}\s+(.+)/m)
  if (h) return h[1].replace(/[*_`]/g, '').trim().slice(0, 100)
  const s = text.replace(/```[\s\S]*?```/g, '').match(/[^.!?\n]{10,120}/)
  return s ? s[0].trim().slice(0, 100) : 'Cluster Status Report'
}

// ── Structured report renderer — takes JSON from /api/chat/pdf-report ──────
function renderStructuredReport(report) {
  const win = window.open('', '_blank', 'width=980,height=800')
  if (!win) return

  const SEV_COLOR = { ok: '#059669', warn: '#d97706', critical: '#dc2626' }
  const SEV_BG    = { ok: '#d1fae5', warn: '#fef3c7', critical: '#fee2e2' }
  const SEV_LABEL = { ok: '✓ Healthy', warn: '⚠ Warning', critical: '🔴 Critical' }
  const FIND_COLOR = { critical: '#dc2626', high: '#f97316', medium: '#d97706', low: '#6366f1' }
  const STAT_COLOR = { ok: '#059669', warn: '#d97706', error: '#dc2626' }

  const sev = report.severity ?? 'ok'
  const sc  = SEV_COLOR[sev] ?? SEV_COLOR.ok
  const sbg = SEV_BG[sev] ?? SEV_BG.ok
  const slb = SEV_LABEL[sev] ?? SEV_LABEL.ok

  function esc(s) { return (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

  function fmtText(s) {
    const safe = esc(s)
    return safe
      .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
        `<pre style="background:#1e293b;border-radius:8px;padding:14px 18px;margin:12px 0;overflow-x:auto;white-space:pre-wrap;word-break:break-all"><code style="color:#e2e8f0;font-family:'Cascadia Code','Fira Mono',monospace;font-size:11.5px;line-height:1.6">${code.trim()}</code></pre>`)
      .replace(/`([^`]+)`/g, '<code style="font-family:\'Cascadia Code\',\'Fira Mono\',monospace;font-size:11.5px;background:#f1f5f9;border-radius:4px;padding:1px 5px;color:#4338ca">$1</code>')
      .replace(/\n/g, '<br>')
  }

  function renderSection(s) {
    let html = `<h2 style="font-size:15px;font-weight:700;color:#1e293b;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin:22px 0 8px">${esc(s.heading)}</h2>`
    if (s.type === 'text') {
      html += `<div style="color:#374151;margin:6px 0 10px;line-height:1.7">${fmtText(s.content)}</div>`
    } else if (s.type === 'list') {
      html += '<ul style="padding-left:22px;margin:6px 0 14px">'
      for (const item of (s.items ?? [])) html += `<li style="color:#374151;margin:4px 0">${fmtText(item)}</li>`
      html += '</ul>'
    } else if (s.type === 'table') {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">'
      if (s.columns?.length) {
        html += '<thead><tr>'
        for (const col of s.columns) html += `<th style="background:#f1f5f9;text-align:left;padding:7px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#475569;border-bottom:2px solid #e2e8f0">${esc(col)}</th>`
        html += '</tr></thead>'
      }
      html += '<tbody>'
      for (const row of (s.rows ?? [])) {
        html += '<tr style="border-bottom:1px solid #f1f5f9">'
        const cells = Array.isArray(row) ? row : Object.values(row)
        for (const cell of cells) html += `<td style="padding:7px 12px;color:#374151">${esc(String(cell))}</td>`
        html += '</tr>'
      }
      html += '</tbody></table>'
    } else if (s.type === 'status_table') {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">'
      html += '<thead><tr><th style="background:#f1f5f9;text-align:left;padding:7px 12px;font-size:10px;font-weight:700;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0">Resource</th><th style="background:#f1f5f9;text-align:left;padding:7px 12px;font-size:10px;font-weight:700;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0">Detail</th><th style="background:#f1f5f9;text-align:left;padding:7px 12px;font-size:10px;font-weight:700;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0">Status</th><th style="background:#f1f5f9;text-align:left;padding:7px 12px;font-size:10px;font-weight:700;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0">Note</th></tr></thead><tbody>'
      for (const r of (s.rows ?? [])) {
        const color = STAT_COLOR[r.status] ?? '#374151'
        html += `<tr style="border-bottom:1px solid #f1f5f9"><td style="padding:7px 12px;font-weight:600">${esc(r.label)}</td><td style="padding:7px 12px;color:#374151">${esc(r.value)}</td><td style="padding:7px 12px"><span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700;background:${color}15;color:${color}">${esc(r.status)}</span></td><td style="padding:7px 12px;color:#64748b;font-size:11px">${esc(r.note ?? '')}</td></tr>`
      }
      html += '</tbody></table>'
    } else if (s.type === 'findings') {
      for (const f of (s.items ?? [])) {
        const fc = FIND_COLOR[f.severity] ?? '#6366f1'
        html += `<div style="border-left:3px solid ${fc};padding:10px 16px;margin:10px 0;background:${fc}08;border-radius:0 8px 8px 0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700;background:${fc};color:#fff">${esc(f.severity?.toUpperCase())}</span><strong style="font-size:13px;color:#1e293b">${esc(f.title)}</strong></div><div style="color:#374151;margin:4px 0;font-size:12px">${fmtText(f.detail)}</div>${f.action ? `<p style="color:${fc};font-size:12px;font-weight:600;margin:4px 0">→ ${fmtText(f.action)}</p>` : ''}</div>`
      }
    }
    return html
  }

  const sectionsHtml = (report.sections ?? []).map(renderSection).join('')

  let recsHtml = ''
  if (report.recommendations?.length) {
    recsHtml = '<h2 style="font-size:15px;font-weight:700;color:#1e293b;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin:22px 0 8px">Recommendations</h2><ol style="padding-left:22px;margin:6px 0 14px">'
    for (const r of report.recommendations) recsHtml += `<li style="color:#374151;margin:5px 0;line-height:1.6">${fmtText(r)}</li>`
    recsHtml += '</ol>'
  }

  win.document.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${esc(report.title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#111827;font-size:13px;line-height:1.7;background:#fff}
  @page{margin:14mm 16mm}
  @media print{.hdr,.sbar{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{padding:0}}
</style></head><body>

<div class="hdr" style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#6366f1 100%);color:#fff;padding:26px 48px 22px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <div style="font-size:19px;font-weight:800;letter-spacing:-.5px">⎈ KubePilot <span style="opacity:.75;font-weight:400">Report</span></div>
    <div style="font-size:11px;opacity:.8">${new Date().toLocaleString()}</div>
  </div>
  <div style="font-size:20px;font-weight:700;margin-bottom:4px">${esc(report.title)}</div>
  <div style="font-size:12px;opacity:.75">AI-generated structured report · KubePilot Dashboard</div>
</div>

<div class="sbar" style="display:flex;align-items:center;gap:10px;padding:9px 48px;background:${sbg};border-bottom:2px solid ${sc}">
  <span style="display:inline-flex;align-items:center;gap:5px;background:${sc};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">${slb}</span>
  <span style="font-size:12px;color:${sc};font-weight:600">Overall Status</span>
</div>

<div style="padding:28px 48px">
  ${report.summary ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:20px"><p style="font-size:13px;color:#334155;line-height:1.65;margin:0"><strong>Summary:</strong> ${esc(report.summary)}</p></div>` : ''}
  ${sectionsHtml}
  ${recsHtml}
  <div style="margin-top:30px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;font-size:10px;color:#9ca3af">
    <span>KubePilot AI · Autonomous Kubernetes Management</span>
    <span>Generated ${new Date().toUTCString()}</span>
  </div>
</div>
</body></html>`)

  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 500)
}

// ── Fallback: render raw markdown as PDF (used when structured API fails) ───
function renderMarkdownPdf(markdown) {
  const win = window.open('', '_blank', 'width=980,height=800')
  if (!win) return

  const SEV_COLOR = { ok: '#059669', warn: '#d97706', critical: '#dc2626' }
  const SEV_BG    = { ok: '#d1fae5', warn: '#fef3c7', critical: '#fee2e2' }
  const SEV_LABEL = { ok: '✓ Healthy', warn: '⚠ Warning', critical: '🔴 Critical' }
  const severity  = detectSeverity(markdown)
  const sc  = SEV_COLOR[severity]
  const sbg = SEV_BG[severity]
  const slb = SEV_LABEL[severity]
  const title     = extractTitle(markdown)
  const bodyHtml  = marked.parse(markdown)

  win.document.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#111827;font-size:13px;line-height:1.7;background:#fff}
  .body{padding:28px 48px}
  .md h1{font-size:18px;font-weight:700;color:#1e293b;border-bottom:2px solid #6366f1;padding-bottom:5px;margin:22px 0 10px}
  .md h2{font-size:15px;font-weight:700;color:#1e293b;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin:18px 0 8px}
  .md h3{font-size:13.5px;font-weight:700;color:#334155;margin:14px 0 6px}
  .md p{color:#374151;margin:6px 0 10px}
  .md ul,.md ol{padding-left:22px;margin:6px 0 10px}
  .md li{color:#374151;margin:3px 0}
  .md strong{font-weight:700}
  .md blockquote{border-left:3px solid #6366f1;padding:4px 14px;margin:10px 0;color:#475569;font-style:italic}
  .md code{font-family:'Cascadia Code','Fira Mono',monospace;font-size:11.5px;background:#f1f5f9;border-radius:4px;padding:1px 5px;color:#4338ca}
  .md pre{background:#1e293b;border-radius:8px;padding:14px 18px;margin:12px 0;overflow-x:visible;white-space:pre-wrap;word-break:break-all}
  .md pre code{background:none;padding:0;color:#e2e8f0;font-size:11.5px}
  .md table{width:100%;border-collapse:collapse;font-size:12px;margin:12px 0}
  .md thead th{background:#f1f5f9;text-align:left;padding:7px 12px;font-size:10px;font-weight:700;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0}
  .md tbody tr{border-bottom:1px solid #f1f5f9}
  .md td{padding:7px 12px;color:#374151}
  .md hr{border:none;border-top:1px solid #e2e8f0;margin:18px 0}
  .footer{margin-top:30px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;font-size:10px;color:#9ca3af}
  @page{margin:14mm 16mm}
  @media print{.hdr,.sbar{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{padding:0}}
</style></head><body>
<div class="hdr" style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#6366f1 100%);color:#fff;padding:26px 48px 22px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <div style="font-size:19px;font-weight:800">⎈ KubePilot <span style="opacity:.75;font-weight:400">Report</span></div>
    <div style="font-size:11px;opacity:.8">${new Date().toLocaleString()}</div>
  </div>
  <div style="font-size:20px;font-weight:700;margin-bottom:4px">${title}</div>
  <div style="font-size:12px;opacity:.75">AI-generated report · KubePilot Dashboard</div>
</div>
<div class="sbar" style="display:flex;align-items:center;gap:10px;padding:9px 48px;background:${sbg};border-bottom:2px solid ${sc}">
  <span style="background:${sc};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">${slb}</span>
  <span style="font-size:12px;color:${sc};font-weight:600">Overall Status</span>
</div>
<div class="body"><div class="md">${bodyHtml}</div>
  <div class="footer"><span>KubePilot AI · Autonomous Kubernetes Management</span><span>Generated ${new Date().toUTCString()}</span></div>
</div>
</body></html>`)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 500)
}

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

    const wantsPdf = intent === 'export_pdf' && confidence > 0.2
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setBusy(true); setElapsed(null)

    const patch = fn => setMessages(prev => {
      const upd = [...prev]
      upd[upd.length - 1] = fn(upd[upd.length - 1])
      return upd
    })

    const currentMsgs = messagesRef.current
    let apiHistory = [
      ...currentMsgs.slice(-2),
      userMsg,
    ]
    if (withClusterContext) {
      try {
        const r = await apiFetch('/api/chat/cluster-context')
        const { text: snapshot } = await r.json()
        apiHistory = [
          ...currentMsgs.slice(-1),
          { role: 'user', content: `[LIVE CLUSTER DATA]\n${snapshot}\n\n[MY QUESTION]\n${text}` },
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

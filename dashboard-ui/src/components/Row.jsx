import { fmtTime } from '../utils/format'

const TAG_MAP = {
  AI: 'tag-ai', LLM: 'tag-ai',
  RISK: 'tag-risk',
  FIX: 'tag-fix',
  VALIDATE: 'tag-validate',
  RESOLVED: 'tag-resolved',
  ESCALATE: 'tag-escalate', ESCALATED: 'tag-escalate',
  DIAGNOSE: 'tag-diagnose', ANALYZE: 'tag-diagnose',
  ACTION: 'tag-action',
}

function highlight(text, search) {
  if (!search) return text
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((p, i) =>
    p.toLowerCase() === search.toLowerCase()
      ? <mark key={i} className="log-highlight">{p}</mark>
      : p
  )
}

function parseLogMessage(msg, search) {
  return msg.split(/(\[[A-Z_]+\])/g).map((part, i) => {
    const m = part.match(/^\[([A-Z_]+)\]$/)
    if (m) return <span key={i} className={`log-tag ${TAG_MAP[m[1]] || 'tag-generic'}`}>{part}</span>
    return <span key={i}>{highlight(part, search)}</span>
  })
}

export function Row({ label, val, mono }) {
  return (
    <div className="card-row">
      <span className="card-label">{label}</span>
      <span className={`card-value${mono ? ' mono-small' : ''}`}>{val}</span>
    </div>
  )
}

export function LogRow({ entry, search }) {
  return (
    <div className={`log-row ${entry.level}`}>
      <span className="log-ts">{fmtTime(entry.timestamp)}</span>
      <span className={`log-level ${entry.level}`}>{entry.level}</span>
      <span className="log-msg">{parseLogMessage(entry.message, search)}</span>
    </div>
  )
}

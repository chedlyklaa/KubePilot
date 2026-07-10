// PDF report rendering — opens a new window, writes a styled HTML document, and
// triggers print(). Extracted from ChatPage.jsx, which previously mixed this with the
// intent classifier and the chat UI itself in one 771-line file.
//
// Security note: renderMarkdownPdf() runs LLM-generated markdown through `marked`, which
// converts markdown to HTML but does NOT strip raw HTML tags embedded in the source — if
// the LLM's output (via prompt injection or an unusual response) contained `<script>` or
// an `onerror` handler, it would execute in the new window's origin. The result is run
// through DOMPurify before being written into the document. renderStructuredReport()
// doesn't need this: every field it interpolates already goes through esc() below, which
// HTML-escapes before any markdown-like substitution.

import { marked } from 'marked'
import DOMPurify from 'dompurify'

function escHtml(s) { return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

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
export function renderStructuredReport(report) {
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
export function renderMarkdownPdf(markdown) {
  const win = window.open('', '_blank', 'width=980,height=800')
  if (!win) return

  const SEV_COLOR = { ok: '#059669', warn: '#d97706', critical: '#dc2626' }
  const SEV_BG    = { ok: '#d1fae5', warn: '#fef3c7', critical: '#fee2e2' }
  const SEV_LABEL = { ok: '✓ Healthy', warn: '⚠ Warning', critical: '🔴 Critical' }
  const severity  = detectSeverity(markdown)
  const sc  = SEV_COLOR[severity]
  const sbg = SEV_BG[severity]
  const slb = SEV_LABEL[severity]
  // extractTitle() pulls this from LLM-generated markdown — escape before embedding in
  // the document (a raw </title><script> in the source would otherwise break out of the
  // <title> tag and inject into <head>).
  const title     = escHtml(extractTitle(markdown))
  // marked converts markdown to HTML but passes any raw HTML in the source straight
  // through — sanitize before this LLM-generated content gets written into the window.
  const bodyHtml  = DOMPurify.sanitize(marked.parse(markdown))

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

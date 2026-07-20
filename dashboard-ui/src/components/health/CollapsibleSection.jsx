import { useState } from 'react'

export default function CollapsibleSection({ title, badges, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = () => setOpen(o => !o)
  return (
    <div className={`col-section${open ? ' col-section-open' : ''}`}>
      <div
        className="col-section-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
      >
        <span className={`hc-chevron${open ? ' hc-chevron-open' : ''}`}>▶</span>
        <span className="col-section-title">{title}</span>
        <div className="col-section-badges">{badges}</div>
      </div>
      {open && <div className="col-section-body">{children}</div>}
    </div>
  )
}

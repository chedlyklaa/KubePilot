import { useState } from 'react'

export default function CollapsibleSection({ title, badges, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`col-section${open ? ' col-section-open' : ''}`}>
      <div className="col-section-header" onClick={() => setOpen(o => !o)}>
        <span className={`hc-chevron${open ? ' hc-chevron-open' : ''}`}>▶</span>
        <span className="col-section-title">{title}</span>
        <div className="col-section-badges">{badges}</div>
      </div>
      {open && <div className="col-section-body">{children}</div>}
    </div>
  )
}

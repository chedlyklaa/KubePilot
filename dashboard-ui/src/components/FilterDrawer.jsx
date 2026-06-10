import { useEffect } from 'react'

export default function FilterDrawer({ open, onClose, title, count, onClear, children }) {
  // Close on Escape
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open && <div className="drawer-backdrop" onClick={onClose} />}
      <div className={`filter-drawer${open ? ' open' : ''}`} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <span className="drawer-title">
            Filters
            {count > 0 && <span className="drawer-count">{count}</span>}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {count > 0 && (
              <button className="drawer-clear" onClick={onClear}>Clear all</button>
            )}
            <button className="drawer-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="drawer-body">
          {children}
        </div>
      </div>
    </>
  )
}

/** Labelled section inside the drawer */
export function FilterSection({ label, children }) {
  return (
    <div className="filter-section">
      <span className="filter-section-label">{label}</span>
      {children}
    </div>
  )
}

/** Multi-select chips used for status / decision / risk */
export function FilterChips({ options, selected, onToggle, colorClass }) {
  return (
    <div className="filter-chips">
      {options.map(({ value, label }) => (
        <button
          key={value}
          className={`filter-chip-item${colorClass ? ` fchip-${value}` : ''}${selected.includes(value) ? ' active' : ''}`}
          onClick={() => onToggle(value)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** Checkbox list for user selection.
 *  getKey — optional fn(user) → string used as toggle value; defaults to u.email */
export function FilterUserList({ users, selectedIds, onToggle, onClearAll, getKey = u => u.email }) {
  return (
    <div className="filter-check-list">
      <label className="filter-check-item">
        <input type="checkbox" checked={selectedIds.length === 0}
          onChange={onClearAll} readOnly={selectedIds.length === 0} />
        All Users
      </label>
      <label className="filter-check-item">
        <input type="checkbox" checked={selectedIds.includes('__unassigned__')}
          onChange={() => onToggle('__unassigned__')} />
        Unassigned
      </label>
      {users.length > 0 && <div className="filter-check-divider" />}
      {users.map(u => {
        const key = getKey(u)
        return (
          <label key={u._id} className="filter-check-item">
            <input type="checkbox" checked={selectedIds.includes(key)}
              onChange={() => onToggle(key)} />
            {u.name}
            <span className={`role-badge role-${u.role}`} style={{ marginLeft: 6 }}>{u.role}</span>
          </label>
        )
      })}
    </div>
  )
}

/** Date range with presets */
export function FilterDateRange({ preset, onPreset, dateFrom, dateTo, onDateFrom, onDateTo }) {
  return (
    <div className="filter-date">
      <div className="filter-date-presets">
        {[['all','All'], ['today','Today'], ['7d','7 days'], ['30d','30 days']].map(([val, lbl]) => (
          <button key={val} className={`date-preset-btn${preset === val ? ' active' : ''}`}
            onClick={() => onPreset(val)}>
            {lbl}
          </button>
        ))}
      </div>
      <div className="filter-date-inputs">
        <input type="date" className="date-input" value={dateFrom} onChange={e => onDateFrom(e.target.value)} />
        <span className="date-sep">→</span>
        <input type="date" className="date-input" value={dateTo}   onChange={e => onDateTo(e.target.value)} />
      </div>
    </div>
  )
}

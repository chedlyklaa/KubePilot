// Slide-in drawer replacing the old anchored user-menu dropdown — same items,
// same navigate/sign-out behavior, just rendered as a full-height panel that's
// fully absent from the DOM when closed (per user preference) rather than an
// icon-only collapsed rail.
export default function UserSidebar({ open, onClose, user, page, onNavigate, onSignOut }) {
  if (!open) return null

  function go(p) { onNavigate(p); onClose() }

  const itemClass = p => `dropdown-item${page === p ? ' dropdown-item-active' : ''}`

  return (
    <>
      <div className="sidebar-overlay" onClick={onClose} />
      <aside className="sidebar-panel">
        <div className="sidebar-panel-header">
          <div className="user-avatar-sm">{user.name?.[0]?.toUpperCase() ?? '?'}</div>
          <div className="user-info">
            <span className="user-name">{user.name}</span>
            <span className={`role-badge role-${user.role}`}>{user.role}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <nav className="sidebar-panel-nav">
          <button className={itemClass('/profile')} onClick={() => go('/profile')}>
            <span className="dropdown-item-icon">👤</span> My Profile
          </button>
          <button className={itemClass('/notifications')} onClick={() => go('/notifications')}>
            <span className="dropdown-item-icon">🔔</span> Notifications
          </button>

          {user.role === 'admin' && (
            <>
              <div className="dropdown-divider" />
              <button className={itemClass('/users')} onClick={() => go('/users')}>
                <span className="dropdown-item-icon">👥</span> Users
              </button>
              <button className={itemClass('/agents')} onClick={() => go('/agents')}>
                <span className="dropdown-item-icon">⎈</span> Agent Management
              </button>

              <div className="dropdown-divider" />
              <button className={itemClass('/security')} onClick={() => go('/security')}>
                <span className="dropdown-item-icon">🔐</span> Security
              </button>
              <button className={itemClass('/policies')} onClick={() => go('/policies')}>
                <span className="dropdown-item-icon">🛡</span> Policies
              </button>
              <button className={itemClass('/hardening')} onClick={() => go('/hardening')}>
                <span className="dropdown-item-icon">🔒</span> Hardening
              </button>
              <button className={itemClass('/network')} onClick={() => go('/network')}>
                <span className="dropdown-item-icon">🌐</span> Network
              </button>
              <button className={itemClass('/secrets')} onClick={() => go('/secrets')}>
                <span className="dropdown-item-icon">🔑</span> Secrets
              </button>
            </>
          )}
        </nav>

        <div className="sidebar-panel-footer">
          <button className="dropdown-item dropdown-item-danger" onClick={onSignOut}>
            <span className="dropdown-item-icon">⏻</span> Sign Out
          </button>
        </div>
      </aside>
    </>
  )
}

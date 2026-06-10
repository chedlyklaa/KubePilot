import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from './contexts/AuthContext'
import { NotifyCtx } from './contexts/NotifyContext'
import { sseUrl, apiFetch } from './lib/api'
import Toasts from './components/Toasts'
import SignOutModal from './components/SignOutModal'
import ThemeToggle from './components/ThemeToggle'
import NotificationPanel from './components/NotificationPanel'
import DashboardPage from './pages/DashboardPage'
import EscalationsPage from './pages/EscalationsPage'
import ClusterHealthPage from './pages/ClusterHealthPage'
import ChatPage from './pages/ChatPage'
import HistoryPage from './pages/HistoryPage'
import UsersPage from './pages/UsersPage'
import HelpModal from './components/HelpModal'
import ProfilePage from './pages/ProfilePage'
import NotificationsSettingsPage from './pages/NotificationsSettingsPage'

export default function AppShell() {
  const { user, logout }            = useAuth()
  const [page, setPage]             = useState('dashboard')
  const [toasts, setToasts]         = useState([])
  const [notifCount, setNotifCount] = useState(0)
  const [showNotifPanel, setShowNotifPanel] = useState(false)
  const [showSignOut, setShowSignOut]       = useState(false)
  const [menuOpen, setMenuOpen]             = useState(false)
  const [dashCounts, setDashCounts]         = useState({ approvals: 0, unclaimed: 0 })
  const [showHelp, setShowHelp]             = useState(false)
  const [showUserMenu, setShowUserMenu]     = useState(false)
  const bellRef    = useRef(null)
  const userMenuRef = useRef(null)

  const notify = useCallback((type, message) => {
    const id = Date.now() + Math.random()
    setToasts(p => [...p, { id, type, message }])
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 5000)
  }, [])

  const dismiss = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), [])

  function toggleNotif() { setShowNotifPanel(p => !p); setNotifCount(0) }

  function navigate(p) { setPage(p); setMenuOpen(false); setShowUserMenu(false) }

  useEffect(() => {
    function handleOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setShowUserMenu(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  useEffect(() => {
    const es = new EventSource(sseUrl('/api/notifications/stream'))
    es.onmessage = e => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'notification') {
        setNotifCount(n => n + 1)
        notify(ev.notification.type, ev.notification.message)
      }
    }
    return () => es.close()
  }, [notify])

  // Keep the dashboard badge accurate on every page — DashboardPage only updates
  // dashCounts while it is mounted, so we poll independently here.
  useEffect(() => {
    async function fetchCounts() {
      try {
        const [ar, er] = await Promise.all([
          apiFetch('/api/approvals'),
          apiFetch('/api/escalations'),
        ])
        const approvals   = await ar.json()
        const escalations = await er.json()
        setDashCounts({
          approvals: Array.isArray(approvals) ? approvals.length : 0,
          unclaimed: Array.isArray(escalations) ? escalations.filter(e => e.status === 'pending').length : 0,
        })
      } catch { /* network unavailable — keep last known value */ }
    }
    fetchCounts()
    const id = setInterval(fetchCounts, 15_000)
    return () => clearInterval(id)
  }, [])

  const dashBadge = dashCounts.approvals + dashCounts.unclaimed

  return (
    <NotifyCtx.Provider value={notify}>
      <Toasts toasts={toasts} dismiss={dismiss} />
      {showSignOut && <SignOutModal onConfirm={logout} onCancel={() => setShowSignOut(false)} />}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {menuOpen && <div className="nav-backdrop" onClick={() => setMenuOpen(false)} />}

      <div className={`app ${page !== 'dashboard' ? 'app-page' : ''}`}>
        <header className="header">
          <div className="header-left">
            <span className="header-logo">⎈</span>
            <div>
              <div className="header-title">KubePilot</div>
              <div className="header-subtitle">Autonomous Multi-Cluster AKS</div>
            </div>
          </div>

          <nav className={`header-nav ${menuOpen ? 'nav-open' : ''}`}>
            <button className={`nav-btn ${page === 'dashboard'   ? 'active' : ''}`} onClick={() => navigate('dashboard')}>
              Dashboard
              {dashBadge > 0 && <span className="nav-badge">{dashBadge > 99 ? '99+' : dashBadge}</span>}
            </button>
            <button className={`nav-btn ${page === 'health'      ? 'active' : ''}`} onClick={() => navigate('health')}>Cluster Health</button>
            <button className={`nav-btn ${page === 'escalations' ? 'active' : ''}`} onClick={() => navigate('escalations')}>Escalations</button>
            <button className={`nav-btn ${page === 'chat'        ? 'active' : ''}`} onClick={() => navigate('chat')}>AI Assistant</button>
            <button className={`nav-btn ${page === 'history'     ? 'active' : ''}`} onClick={() => navigate('history')}>History</button>
          </nav>

          <div className="header-right">
            <ThemeToggle />
            <div className="notif-bell-wrap" ref={bellRef}>
              <button className={`notif-bell ${showNotifPanel ? 'notif-bell-active' : ''}`} onClick={toggleNotif} title="Notifications">
                🔔 {notifCount > 0 && <span className="notif-count">{notifCount}</span>}
              </button>
              {showNotifPanel && <NotificationPanel onClose={() => setShowNotifPanel(false)} bellRef={bellRef} />}
            </div>
            <div className="user-menu-wrap" ref={userMenuRef}>
              <button className="user-menu-trigger" onClick={() => setShowUserMenu(p => !p)}>
                <div className="user-avatar-sm">{user.name?.[0]?.toUpperCase() ?? '?'}</div>
                <div className="user-info">
                  <span className="user-name">{user.name}</span>
                  <span className={`role-badge role-${user.role}`}>{user.role}</span>
                </div>
                <span className="menu-caret">{showUserMenu ? '▲' : '▼'}</span>
              </button>
              {showUserMenu && (
                <div className="user-dropdown">
                  <button className="dropdown-item" onClick={() => navigate('profile')}>
                    <span className="dropdown-item-icon">👤</span> My Profile
                  </button>
                  <button className="dropdown-item" onClick={() => navigate('notifications')}>
                    <span className="dropdown-item-icon">🔔</span> Notifications
                  </button>
                  {user.role === 'admin' && (
                    <button className="dropdown-item" onClick={() => navigate('users')}>
                      <span className="dropdown-item-icon">👥</span> Users
                    </button>
                  )}
                  <div className="dropdown-divider" />
                  <button className="dropdown-item dropdown-item-danger" onClick={() => { setShowSignOut(true); setShowUserMenu(false) }}>
                    <span className="dropdown-item-icon">⏻</span> Sign Out
                  </button>
                </div>
              )}
            </div>
            <button className="help-btn" onClick={() => setShowHelp(true)} title="Help">?</button>
            <button className="hamburger" onClick={() => setMenuOpen(p => !p)} aria-label="Toggle menu">
              {menuOpen ? '✕' : '☰'}
            </button>
          </div>
        </header>

        {page === 'dashboard'                      && <DashboardPage onCountsChange={setDashCounts} />}
        {page === 'health'                         && <ClusterHealthPage />}
        {page === 'escalations'                    && <EscalationsPage />}
        {page === 'chat'                           && <ChatPage />}
        {page === 'history'                        && <HistoryPage />}
        {page === 'users'         && user.role === 'admin' && <UsersPage />}
        {page === 'profile'                               && <ProfilePage />}
        {page === 'notifications'                         && <NotificationsSettingsPage />}
      </div>
    </NotifyCtx.Provider>
  )
}

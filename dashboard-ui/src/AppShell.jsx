import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from './contexts/AuthContext'
import { NotifyCtx } from './contexts/NotifyContext'
import { sseUrl } from './lib/api'
import Toasts from './components/Toasts'
import SignOutModal from './components/SignOutModal'
import ThemeToggle from './components/ThemeToggle'
import NotificationPanel from './components/NotificationPanel'
import DashboardPage from './pages/DashboardPage'
import EscalationsPage from './pages/EscalationsPage'
import ChatPage from './pages/ChatPage'
import HistoryPage from './pages/HistoryPage'
import UsersPage from './pages/UsersPage'

export default function AppShell() {
  const { user, logout }            = useAuth()
  const [page, setPage]             = useState('dashboard')
  const [toasts, setToasts]         = useState([])
  const [notifCount, setNotifCount] = useState(0)
  const [showNotifPanel, setShowNotifPanel] = useState(false)
  const [showSignOut, setShowSignOut]       = useState(false)
  const bellRef = useRef(null)

  const notify = useCallback((type, message) => {
    const id = Date.now() + Math.random()
    setToasts(p => [...p, { id, type, message }])
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 5000)
  }, [])

  const dismiss = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), [])

  function toggleNotif() { setShowNotifPanel(p => !p); setNotifCount(0) }

  // Live notification count via SSE
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

  return (
    <NotifyCtx.Provider value={notify}>
      <Toasts toasts={toasts} dismiss={dismiss} />
      {showSignOut && <SignOutModal onConfirm={logout} onCancel={() => setShowSignOut(false)} />}

      <div className={`app ${page !== 'dashboard' ? 'app-page' : ''}`}>
        <header className="header">
          <div className="header-left">
            <span className="header-logo">⎈</span>
            <div>
              <div className="header-title">KubePilot</div>
              <div className="header-subtitle">Autonomous Multi-Cluster AKS</div>
            </div>
          </div>

          <nav className="header-nav">
            <button className={`nav-btn ${page === 'dashboard'   ? 'active' : ''}`} onClick={() => setPage('dashboard')}>Dashboard</button>
            <button className={`nav-btn ${page === 'escalations' ? 'active' : ''}`} onClick={() => setPage('escalations')}>Escalations</button>
            <button className={`nav-btn ${page === 'chat'        ? 'active' : ''}`} onClick={() => setPage('chat')}>Chat</button>
            <button className={`nav-btn ${page === 'history'     ? 'active' : ''}`} onClick={() => setPage('history')}>History</button>
            {user.role === 'admin' && (
              <button className={`nav-btn ${page === 'users' ? 'active' : ''}`} onClick={() => setPage('users')}>Users</button>
            )}
          </nav>

          <div className="header-right">
            <ThemeToggle />
            <div className="notif-bell-wrap" ref={bellRef}>
              <button className={`notif-bell ${showNotifPanel ? 'notif-bell-active' : ''}`} onClick={toggleNotif} title="Notifications">
                🔔 {notifCount > 0 && <span className="notif-count">{notifCount}</span>}
              </button>
              {showNotifPanel && <NotificationPanel onClose={() => setShowNotifPanel(false)} bellRef={bellRef} />}
            </div>
            <div className="user-info">
              <span className="user-name">{user.name}</span>
              <span className={`role-badge role-${user.role}`}>{user.role}</span>
            </div>
            <button className="btn-logout" onClick={() => setShowSignOut(true)}>Sign out</button>
          </div>
        </header>

        {page === 'dashboard'                      && <DashboardPage />}
        {page === 'escalations'                    && <EscalationsPage />}
        {page === 'chat'                           && <ChatPage />}
        {page === 'history'                        && <HistoryPage />}
        {page === 'users' && user.role === 'admin' && <UsersPage />}
      </div>
    </NotifyCtx.Provider>
  )
}

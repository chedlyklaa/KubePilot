import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch, openSSE } from '../lib/api'
import { fmtDT } from '../utils/format'

export default function NotificationPanel({ onClose, bellRef }) {
  const { user }              = useAuth()
  const [notifs, setNotifs]   = useState([])
  const [loading, setLoading] = useState(true)
  const panelRef              = useRef(null)

  useEffect(() => {
    apiFetch('/api/notifications').then(r => r.json()).then(data => {
      setNotifs(Array.isArray(data) ? data : [])
      setLoading(false)
    })
  }, [])

  // Close on outside click, ignoring the bell button itself
  useEffect(() => {
    const handler = e => {
      if (panelRef.current && !panelRef.current.contains(e.target) &&
          bellRef?.current && !bellRef.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, bellRef])

  // Subscribe to live notifications
  useEffect(() => {
    let es, cancelled = false
    openSSE('/api/notifications/stream').then(s => {
      if (cancelled) { s.close(); return }
      es = s
      es.onmessage = e => {
        const ev = JSON.parse(e.data)
        if (ev.type === 'notification') setNotifs(p => [ev.notification, ...p])
      }
    })
    return () => { cancelled = true; es?.close() }
  }, [])

  async function markAll() {
    await apiFetch('/api/notifications/read-all', { method: 'PUT' })
    setNotifs(p => p.map(n => ({ ...n, readBy: [...(n.readBy || []), user.id] })))
  }

  const unread = notifs.filter(n => !n.readBy?.includes(user.id)).length

  return (
    <div className="notif-panel" ref={panelRef}>
      <div className="notif-panel-header">
        <span className="notif-panel-title">
          Notifications {unread > 0 && <span className="notif-unread-count">{unread}</span>}
        </span>
        {unread > 0 && <button className="notif-read-all" onClick={markAll}>Mark all read</button>}
      </div>
      <div className="notif-panel-list">
        {loading
          ? <div className="notif-loading">Loading…</div>
          : notifs.length === 0
            ? <div className="notif-empty">No notifications yet</div>
            : notifs.map(n => {
                const isRead = n.readBy?.includes(user.id)
                return (
                  <div key={n.id} className={`notif-item ${isRead ? 'read' : 'unread'}`}
                    onClick={async () => {
                      await apiFetch(`/api/notifications/${n.id}/read`, { method: 'PUT' })
                      setNotifs(p => p.map(x => x.id === n.id ? { ...x, readBy: [...(x.readBy || []), user.id] } : x))
                    }}>
                    <span className={`notif-item-dot notif-dot-${n.type}`} />
                    <div className="notif-item-body">
                      <div className="notif-item-msg">{n.message}</div>
                      <div className="notif-item-time">{fmtDT(n.createdAt)}</div>
                    </div>
                  </div>
                )
              })
        }
      </div>
    </div>
  )
}

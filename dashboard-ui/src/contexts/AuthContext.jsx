import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { setUnauthorizedHandler, getToken } from '../lib/api'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }) {
  const [user,  setUser]  = useState(() => { try { return JSON.parse(localStorage.getItem('k8s_user')) } catch { return null } })
  const [token, setToken] = useState(() => localStorage.getItem('k8s_token') || null)

  const login = useCallback((tok, u) => {
    localStorage.setItem('k8s_token', tok)
    localStorage.setItem('k8s_user', JSON.stringify(u))
    setToken(tok); setUser(u)
  }, [])

  const logout = useCallback(async () => {
    setUnauthorizedHandler(null)
    await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }).catch(() => {})
    localStorage.removeItem('k8s_token')
    localStorage.removeItem('k8s_user')
    setToken(null); setUser(null)
  }, [])

  useEffect(() => {
    if (user && token) setUnauthorizedHandler(logout)
    else setUnauthorizedHandler(null)
  }, [user, token, logout])

  // Auto-logout after 30 minutes of inactivity
  useEffect(() => {
    if (!user) return
    const INACTIVITY_MS = 30 * 60 * 1000
    let timer = setTimeout(logout, INACTIVITY_MS)
    const reset = () => { clearTimeout(timer); timer = setTimeout(logout, INACTIVITY_MS) }
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart']
    events.forEach(e => window.addEventListener(e, reset, { passive: true }))
    return () => {
      clearTimeout(timer)
      events.forEach(e => window.removeEventListener(e, reset))
    }
  }, [user, logout])

  return <AuthCtx.Provider value={{ user, token, login, logout }}>{children}</AuthCtx.Provider>
}

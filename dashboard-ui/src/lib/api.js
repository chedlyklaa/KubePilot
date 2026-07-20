export const getToken = () => localStorage.getItem('k8s_token')

let _onUnauthorized = null
export function setUnauthorizedHandler(fn) { _onUnauthorized = fn }

export const apiFetch = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (res.status === 401 && _onUnauthorized) _onUnauthorized()
  return res
}

// Opens an EventSource for `path` using a short-lived, single-use ticket instead of
// the real session token — a token in the URL would land in server access logs,
// browser history, and any Referer header sent by the page. The ticket is minted
// server-side (POST /api/auth/sse-ticket) and consumed on first use.
export const openSSE = async path => {
  const res = await apiFetch('/api/auth/sse-ticket', { method: 'POST' })
  const { ticket } = await res.json()
  return new EventSource(`${path}?ticket=${ticket}`)
}

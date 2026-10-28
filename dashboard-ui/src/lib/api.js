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

// Open an SSE stream using a one-time ticket
export const openSSE = async path => {
  const res = await apiFetch('/api/auth/sse-ticket', { method: 'POST' })
  const { ticket } = await res.json()
  return new EventSource(`${path}?ticket=${ticket}`)
}

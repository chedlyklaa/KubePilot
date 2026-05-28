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

export const sseUrl = path => `${path}?token=${getToken()}`

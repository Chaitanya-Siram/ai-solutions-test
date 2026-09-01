// Shared HTTP client for the FastAPI backend.
//
// Every backend route (except /auth/login and user registration) requires a
// JWT Bearer token, so this wrapper injects the access token on every request.
// On a 401 it transparently tries the refresh-token flow once and retries; if
// that fails the session is cleared and an `auth:unauthorized` event fires so
// the app can bounce the user to the login screen.
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '../auth/tokenStore.js'

export const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

// Turn a non-ok response into a thrown Error carrying the backend `detail`.
export async function handle(res) {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (data && data.detail) detail = data.detail
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail)
  }
  if (res.status === 204) return null
  return res.json()
}

function withAuth(headers = {}) {
  const token = getAccessToken()
  return token ? { ...headers, Authorization: `Bearer ${token}` } : { ...headers }
}

// Single-flight refresh: concurrent 401s share one refresh request.
let refreshInFlight = null

async function refreshAccessToken() {
  const refresh_token = getRefreshToken()
  if (!refresh_token) return false
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    })
      .then(async (res) => {
        if (!res.ok) return false
        const data = await res.json()
        setTokens(data)
        return true
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

function forceLogout() {
  clearTokens()
  window.dispatchEvent(new Event('auth:unauthorized'))
}

// Core request: prefixes BASE_URL, injects auth, and handles 401→refresh→retry.
// Returns the raw Response so callers can parse JSON (via `handle`) or read a blob.
export async function apiFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const doFetch = () => fetch(url, { ...options, headers: withAuth(options.headers) })

  let res = await doFetch()
  if (res.status === 401) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      res = await doFetch()
    }
    if (res.status === 401) {
      forceLogout()
    }
  }
  return res
}

// Save a file response via the browser. Prefers the filename the backend put in
// Content-Disposition; `fallbackName` is used when the header is missing.
export async function saveFileResponse(res, fallbackName) {
  if (!res.ok) {
    let detail = `Download failed (${res.status})`
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch { /* non-JSON error body */ }
    throw new Error(detail)
  }

  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="?([^";]+)"?/)

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = match ? match[1] : fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Convenience: request + JSON handling in one call.
export function apiJson(path, options = {}) {
  return apiFetch(path, options).then(handle)
}

// Convenience for JSON bodies (sets the header + serializes).
export function apiSend(path, method, body) {
  return apiJson(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Persisted auth tokens. Kept in localStorage so a refresh keeps the session.
const ACCESS_KEY = 'iv_access_token'
const REFRESH_KEY = 'iv_refresh_token'

export function getAccessToken() {
  return localStorage.getItem(ACCESS_KEY) || ''
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY) || ''
}

export function setTokens({ access_token, refresh_token } = {}) {
  if (access_token) localStorage.setItem(ACCESS_KEY, access_token)
  if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token)
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

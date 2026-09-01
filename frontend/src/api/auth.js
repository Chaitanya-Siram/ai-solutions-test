// Auth endpoints: login, refresh, logout, and the current-user probe.
import { BASE_URL, apiJson, handle } from './http.js'
import { getRefreshToken } from '../auth/tokenStore.js'

// Login is unauthenticated — call fetch directly (no token to attach yet).
// Returns { access_token, refresh_token, token_type, user }.
export function login({ email, password }) {
  return fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then(handle)
}

// The authenticated user behind the current access token.
export function getMe() {
  return apiJson('/auth/me')
}

// Revoke the current refresh token (this session). Best-effort.
export function logout() {
  const refresh_token = getRefreshToken()
  if (!refresh_token) return Promise.resolve(null)
  return fetch(`${BASE_URL}/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token }),
  }).then(handle)
}

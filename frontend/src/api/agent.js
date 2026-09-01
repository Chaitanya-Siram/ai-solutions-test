// Interactive data agent: the streaming WebSocket URL.
import { getAccessToken } from '../auth/tokenStore.js'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

// http(s)://host  ->  ws(s)://host/ws/agent?token=<jwt>
// Browsers can't set headers on a WS handshake, so the access token rides in
// the query string (the backend accepts either header or ?token=).
export function agentWsUrl() {
  const base = `${BASE_URL.replace(/^http/, 'ws')}/ws/agent`
  const token = getAccessToken()
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

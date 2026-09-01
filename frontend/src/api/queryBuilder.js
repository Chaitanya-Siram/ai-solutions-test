// Query-builder intake agent: the streaming WebSocket URL.
import { getAccessToken } from '../auth/tokenStore.js'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

// http(s)://host  ->  ws(s)://host/ws/query-builder?project_id=<id>&token=<jwt>
export function queryBuilderWsUrl(projectId) {
  const base = `${BASE_URL.replace(/^http/, 'ws')}/ws/query-builder`
  const params = new URLSearchParams()
  if (projectId != null) params.set('project_id', String(projectId))
  const token = getAccessToken()
  if (token) params.set('token', token)
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

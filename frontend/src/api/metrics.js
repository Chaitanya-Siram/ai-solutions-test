import { apiJson } from './http.js'

function qs(params) {
  const p = Object.entries(params).filter(([, v]) => v != null)
  return p.length ? '?' + new URLSearchParams(p).toString() : ''
}

export const getMetricsSummary = (params = {}) => apiJson('/metrics/summary' + qs(params))
export const getMetricsDaily = (params = {}) => apiJson('/metrics/daily' + qs(params))
export const getMetricsAgents = (params = {}) => apiJson('/metrics/agents' + qs(params))
export const getMetricsModels = (params = {}) => apiJson('/metrics/models' + qs(params))
export const getMetricsSessions = () => apiJson('/metrics/sessions')
export const getSessionDetail = (sessionId) => apiJson(`/metrics/sessions/${sessionId}`)

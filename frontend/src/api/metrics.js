import { apiJson } from './http.js'

export const getMetricsSummary = () => apiJson('/metrics/summary')
export const getMetricsSessions = () => apiJson('/metrics/sessions')
export const getSessionDetail = (sessionId) => apiJson(`/metrics/sessions/${sessionId}`)

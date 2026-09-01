// Charts: the streaming WebSocket URL for dashboard generation.
import { BASE_URL, apiFetch, apiJson, apiSend, saveFileResponse } from './http.js'
import { getAccessToken } from '../auth/tokenStore.js'

// http(s)://host  ->  ws(s)://host/ws/charts?token=<jwt>
export function chartsWsUrl() {
  const base = `${BASE_URL.replace(/^http/, 'ws')}/ws/charts`
  const token = getAccessToken()
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

// Fetch the (cached) charts payload for a session — used to restore dashboards
// after a page refresh without re-running generation.
export function fetchCharts(sessionId) {
  return apiJson(`/charts?session_id=${sessionId}`)
}

// Move a media-monitoring article from one section to another. Persists the move
// to the session's cached charts file and the underlying tagged file (both on S3).
export function moveMediaMonitoringArticle(sessionId, articleId, fromSection, toSection) {
  return apiSend('/media-monitoring/move-article', 'PUT', {
    session_id: sessionId,
    article_id: String(articleId),
    from_section: fromSection,
    to_section: toSection,
  })
}

// Download the media-monitoring articles as a BeOne-style .docx report and save
// it via the browser. `days` is an optional array of YYYY-MM-DD strings to limit
// the report to specific dates (empty = all dates). `variant` picks between the
// two Otsuka layouts ('coverage' | 'summary'); other brands ignore it.
export async function downloadMediaMonitoringReport(sessionId, days = [], variant = 'coverage') {
  const params = new URLSearchParams()
  params.set('session_id', sessionId)
  days.forEach((d) => params.append('days', d))
  params.set('variant', variant)

  const res = await apiFetch(`/media-monitoring/report?${params.toString()}`)
  const fallback = variant === 'summary'
    ? 'otsuka_summary_report.docx'
    : 'media_monitoring_report.docx'
  await saveFileResponse(res, fallback)
}

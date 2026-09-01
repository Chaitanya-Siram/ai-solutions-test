// Tagging: the streaming WebSocket URL + fetching the tagged articles.
import { BASE_URL, apiFetch, apiJson, apiSend, saveFileResponse } from './http.js'
import { getAccessToken } from '../auth/tokenStore.js'

// http(s)://host  ->  ws(s)://host/ws/tagging?token=<jwt>
export function taggingWsUrl() {
  const base = `${BASE_URL.replace(/^http/, 'ws')}/ws/tagging`
  const token = getAccessToken()
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

export function getTaggedArticles(sessionId) {
  return apiJson(`/tagging/${sessionId}`)
}

// Promote one or more irrelevant articles to relevant and AI-tag them in place.
// `ids` is an array of article ids. Returns the updated, now fully-tagged
// articles (each with is_relevant === true).
export function markArticlesRelevant(sessionId, ids) {
  return apiSend(`/tagging/${sessionId}/articles/mark-relevant`, 'POST', { ids })
}

// Demote one or more relevant articles to irrelevant, keeping their tags. `reason`
// (required) is stored as the not-relevant reason. Returns the updated articles
// (each with is_relevant === false).
export function markArticlesIrrelevant(sessionId, ids, reason) {
  return apiSend(`/tagging/${sessionId}/articles/mark-irrelevant`, 'POST', { ids, reason })
}

// Patch tagged fields on one or more articles. `updates` is an array of
// { id, <changed fields> }. Returns { updated_count, updated_ids, ..., retagged },
// where `retagged` holds the full new state of every article whose title/content
// changed — the server re-runs the tagger and the keyword match over the new text.
export function updateTaggedArticles(sessionId, updates) {
  return apiSend(`/tagging/${sessionId}`, 'PUT', updates)
}

// Append one or more new articles (body + tags) to the session. `articles` is an
// array of article objects. Returns the created articles with server-assigned ids.
export function addTaggedArticles(sessionId, articles) {
  return apiSend(`/tagging/${sessionId}/articles`, 'POST', articles)
}

// Fetch a single article by URL and AI-tag it (preview only — not saved).
// Returns the tagged article object (confidences as 0–100 percents). Throws with
// a "Subscription required…" message when the article body can't be fetched.
export function fetchArticleByUrl(sessionId, url) {
  return apiSend(`/tagging/${sessionId}/fetch-article`, 'POST', { url })
}

// AI-tag a manually-entered article (used when a URL can't be fetched). `fields`
// is { title, content, date, url, author }. Returns the tagged preview
// (confidences as 0–100 percents), same shape as fetchArticleByUrl.
export function tagManualArticle(sessionId, fields) {
  return apiSend(`/tagging/${sessionId}/tag-manual`, 'POST', fields)
}

// Delete a manually-added article (added_type === 'Manual') by id.
export function deleteTaggedArticle(sessionId, articleId) {
  return apiJson(`/tagging/${sessionId}/articles/${encodeURIComponent(articleId)}`, {
    method: 'DELETE',
  })
}

// The columns the download popup can offer: [{ key, label, default }] in the
// order they appear in the sheet. Owned by the backend so the two can't drift.
export function getExportFields() {
  return apiJson('/tagging/export/fields')
}

// Download the session's articles as an .xlsx and save it via the browser.
// `types` is a subset of ['relevant', 'irrelevant']; `fields` are export field
// keys (empty = the backend's default columns).
export async function downloadArticlesExcel(sessionId, types, fields) {
  const res = await apiFetch(`/tagging/${sessionId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ types, fields }),
  })
  await saveFileResponse(res, `articles_session_${sessionId}.xlsx`)
}

// Set an approval flag on a set of articles. `ids` is an array of article ids.
// `forMonitoring` targets the separate is_approved_for_monitoring flag used by
// the Media Monitoring review popup (default targets is_approved).
export function approveTaggedArticles(sessionId, ids, isApproved = true, forMonitoring = false) {
  return apiSend(`/tagging/${sessionId}/approve`, 'POST', {
    ids,
    is_approved: isApproved,
    for_monitoring: forMonitoring,
  })
}

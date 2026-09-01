// Client for session listing/deletion and file upload.
import { apiFetch, apiJson, apiSend, handle } from './http.js'

export function listSessions(projectId) {
  return apiJson(`/projects/${projectId}/sessions`)
}

export function listGeneratedQueries(projectId) {
  return apiJson(`/projects/${projectId}/generated-queries`)
}

// Files synced from the project's OneDrive folder, newest first. Each carries an
// `article_count` — the tagged articles deleting it would remove.
export function listOnedriveFiles(projectId) {
  return apiJson(`/projects/${projectId}/onedrive-files`)
}

// Delete a synced file along with the raw and tagged articles it brought in.
export function deleteOnedriveFile(fileId) {
  return apiJson(`/onedrive-files/${fileId}`, { method: 'DELETE' })
}

// Update a generated query's name and/or grouped queries.
// `fields` may include { name, queries: [{ label, queries: [...] }] }.
export function updateGeneratedQuery(projectId, queryId, fields) {
  return apiSend(`/projects/${projectId}/generated-queries/${queryId}`, 'PUT', fields)
}

// Manually trigger a generated query over a date window. Returns the new session,
// which owns no articles: it shows the project's collected articles dated inside the
// window. `startIso` / `endIso` are UTC ISO 8601 strings.
export function runGeneratedQuery(projectId, queryId, startIso, endIso) {
  return apiSend(`/projects/${projectId}/generated-queries/${queryId}/run`, 'POST', {
    start_datetime: startIso,
    end_datetime: endIso,
  })
}

export function deleteSession(sessionId) {
  return apiJson(`/sessions/${sessionId}`, { method: 'DELETE' })
}

// Merge several sessions' raw files into one new "merged" session (deduped by
// url on the backend). Returns the new session.
export function mergeSessions(projectId, sessionIds) {
  return apiSend(`/projects/${projectId}/merge`, 'POST', { session_ids: sessionIds })
}

// Fetch a single session (including its saved workflow graph).
export function getSession(sessionId) {
  return apiJson(`/sessions/${sessionId}`)
}

// Rename a session (the display file name shown in the data table).
export function renameSession(sessionId, name) {
  return apiSend(`/sessions/${sessionId}/name`, 'PUT', { name })
}

// Persist the workflow designer graph (nodes + edges) on a session.
export function saveWorkflow(sessionId, workflow) {
  return apiSend(`/sessions/${sessionId}/workflow`, 'PUT', { workflow })
}

// Uploads a file → backend creates a session for the project. The project's
// brand/competitor/message keywords apply automatically (no longer per-session).
export function uploadFile({ projectId, file }) {
  const form = new FormData()
  form.append('project_id', String(projectId))
  form.append('file', file)
  // No Content-Type header — the browser sets the multipart boundary.
  return apiFetch('/upload', { method: 'POST', body: form }).then(handle)
}

// A project's stored report comparisons, oldest first, each with its missing articles.
export function listReportComparisons(projectId) {
  return apiJson(`/projects/${projectId}/report-comparisons`)
}

// Save the fields a user typed against one missing article. `fields` may carry
// `keywords` and/or `reason_for_not_found`; an omitted one is left unchanged.
export function updateMissingArticle(articleId, fields) {
  return apiSend(`/report-comparisons/missing-articles/${articleId}`, 'PUT', fields)
}

// Compare a delivered report .xlsx against a session's tagged articles. Returns the
// stored counts plus the report rows the tool has no match for.
export function compareReportExcel({ sessionId, reportDate, file }) {
  const form = new FormData()
  form.append('session_id', String(sessionId))
  form.append('report_date', reportDate)
  form.append('file', file)
  return apiFetch('/report-comparison', { method: 'POST', body: form }).then(handle)
}

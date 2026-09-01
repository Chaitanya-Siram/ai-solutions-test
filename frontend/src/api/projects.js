// Thin client for the FastAPI project CRUD endpoints.
import { apiJson, apiSend } from './http.js'

export function listProjects({ includeInactive = true } = {}) {
  const params = new URLSearchParams({ include_inactive: String(includeInactive) })
  return apiJson(`/projects?${params}`)
}

export function getProject(id) {
  return apiJson(`/projects/${id}`)
}

export function createProject({ name, description }) {
  return apiSend('/projects', 'POST', { name, description: description || null })
}

// Partially update a project. Pass any subset of:
// { name, description, is_active, brand_keywords, competitor_keywords, message_keywords }.
export function updateProject(id, fields) {
  return apiSend(`/projects/${id}`, 'PUT', fields)
}

export function deleteProject(id) {
  return apiJson(`/projects/${id}`, { method: 'DELETE' })
}

// Set (or clear) the Media Monitoring section prompt used during tagging.
// Pass an empty string / null to clear it.
export function addSectionsPrompt(id, sectionsPrompt) {
  return apiSend(`/projects/${id}/add_sections_prompt`, 'POST', { sections_prompt: sectionsPrompt || null })
}

// Set (or clear) the relevancy prompt the relevancy agent uses to filter articles
// before tagging. Pass an empty string / null to clear it (falls back to built-in criteria).
export function addRelevancyPrompt(id, relevancyPrompt) {
  return apiSend(`/projects/${id}/add_relevancy_prompt`, 'POST', { relevancy_prompt: relevancyPrompt || null })
}

// Set (or clear) a recurring hourly schedule on a generated query — the run fires at
// the given time's minute past every hour. Pass a null time to unschedule. `time` is
// "HH:MM" local; `timezone` is an IANA name.
export function scheduleGeneratedQuery(projectId, queryId, time, timezone) {
  return apiSend(`/projects/${projectId}/generated-queries/${queryId}/schedule`, 'PUT', {
    schedule_time: time || null,
    schedule_timezone: timezone || null,
  })
}

// Persist the Media Monitoring section display order (after drag-reorder).
// Pass sessionId to also reorder that session's cached charts file.
export function updateSectionsOrders(id, sectionsOrders, sessionId = null) {
  return apiSend(`/projects/${id}/sections_orders`, 'PUT', {
    sections_orders: sectionsOrders,
    session_id: sessionId,
  })
}

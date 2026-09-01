// User management client. Create and delete are intentionally omitted —
// only listing, viewing, and updating are exposed in the UI.
import { apiJson, apiSend } from './http.js'

export function listUsers({ skip = 0, limit = 100 } = {}) {
  const params = new URLSearchParams({ skip: String(skip), limit: String(limit) })
  return apiJson(`/users?${params}`)
}

export function getUser(id) {
  return apiJson(`/users/${id}`)
}

// Partial update. Pass any subset of:
// { email, password, full_name, is_active, is_admin }.
export function updateUser(id, fields) {
  return apiSend(`/users/${id}`, 'PUT', fields)
}

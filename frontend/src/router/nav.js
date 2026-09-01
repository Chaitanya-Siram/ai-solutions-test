// URL scheme + id-based data loading for the router.
//
// Navigation passes the full project/session/charts objects via react-router
// `state` (fast path, no refetch). On a cold deep-link / refresh that state is
// gone, so we fetch by the id in the URL — results are cached per id so tab
// switches and back/forward don't refetch.
import { useEffect, useState } from 'react'
import { getProject } from '../api/projects.js'
import { getSession } from '../api/sessions.js'
import { fetchCharts } from '../api/charts.js'

export const paths = {
  login: () => '/login',
  users: () => '/users',
  projects: () => '/',
  project: (pid) => `/${pid}/sessions`,
  comparisons: (pid) => `/${pid}/comparisons`,
  workflow: (pid, sid) => `/${pid}/sessions/${sid}/workflow`,
  review: (pid, sid) => `/${pid}/sessions/${sid}/review`,
  dashboards: (pid, sid) => `/${pid}/sessions/${sid}/dashboards`,
  measurement: (pid, sid) => `/${pid}/sessions/${sid}/measurement`,
  monitoring: (pid, sid) => `/${pid}/sessions/${sid}/monitoring`,
}

const cache = { project: new Map(), session: new Map(), charts: new Map() }

export function seedCharts(sessionId, data) {
  if (sessionId != null && data) cache.charts.set(String(sessionId), data)
}

async function cached(map, id, fetchFn) {
  const key = String(id)
  if (map.has(key)) return map.get(key)
  const value = await fetchFn(id)
  map.set(key, value)
  return value
}

export const loadProject = (id) => cached(cache.project, id, getProject)
export const loadSession = (id) => cached(cache.session, id, getSession)
export const loadCharts = (id) => cached(cache.charts, id, fetchCharts)

// Resolve charts with explicit loading/error status so dashboards can show a
// spinner while the API is in flight (instead of a premature "no data" state).
export function useCharts(id, seed) {
  const [state, setState] = useState(() =>
    seed ? { data: seed, loading: false, error: '' } : { data: null, loading: id != null, error: '' },
  )
  useEffect(() => {
    if (id == null) {
      setState({ data: null, loading: false, error: '' })
      return undefined
    }
    if (seed) {
      setState({ data: seed, loading: false, error: '' })
      return undefined
    }
    let cancelled = false
    setState({ data: null, loading: true, error: '' })
    loadCharts(id)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: '' })
      })
      .catch((err) => {
        if (!cancelled) setState({ data: null, loading: false, error: err?.message || 'Failed to load dashboard data.' })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, seed])
  return state
}

// Resolve an entity for a route: use the object passed via navigation `state`
// when present, otherwise fetch it by id (deep-link / refresh).
export function useResolved(loadFn, id, seed) {
  const [value, setValue] = useState(seed || null)
  useEffect(() => {
    if (id == null) {
      setValue(null)
      return undefined
    }
    if (seed) {
      setValue(seed)
      return undefined
    }
    let cancelled = false
    loadFn(id)
      .then((data) => {
        if (!cancelled) setValue(data)
      })
      .catch(() => {
        /* leave null; screens guard against missing data */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, seed])
  return value
}

// Helpers to turn a session's `name` into display values. The name is the original
// filename for an upload, the generated query's name for a query session, and
// "Merged (N files)" for a merge. (Sessions used to carry an S3 `source_file` key
// these were derived from; the articles now live in the database.)

export function prettyFileName(name) {
  if (!name) return 'Untitled file'
  const base = String(name).split('/').pop() || String(name)
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot) : ''
  let stem = dot >= 0 ? base.slice(0, dot) : base
  if (stem.startsWith('raw_')) stem = stem.slice(4)
  stem = stem.replace(/_\d{6,}$/, '') // strip trailing _<unix-timestamp>
  return stem + ext
}

export function fileExt(name) {
  if (!name) return ''
  const base = String(name).split('/').pop() || String(name)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toUpperCase() : ''
}

// Badge text for a session: its file extension when the name has one (uploads),
// otherwise a label for how the session was created — a fetched or merged session
// has no filename to take an extension from.
export function sessionExt(session) {
  const ext = fileExt(session?.name)
  if (ext) return ext
  if (session?.session_type === 'query') return 'QUERY'
  if (session?.session_type === 'merged') return 'MERGED'
  return ''
}

export function uploadedDate(session) {
  if (session?.created_at) {
    const d = new Date(session.created_at)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

export function formatDate(date) {
  if (!date) return '—'
  return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
}

// The date window a session covers — set when the session came from running a
// generated query over an explicit start/end. Null for uploads and merges, and
// for a half-filled window (a range needs both ends to mean anything).
export function sessionWindow(session) {
  const start = session?.start_datetime ? new Date(session.start_datetime) : null
  const end = session?.end_datetime ? new Date(session.end_datetime) : null
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  return { start, end }
}

// The stored window is UTC; toLocale* renders it in the viewer's timezone, the same
// zone they picked it in.
export function formatDateTime(date) {
  if (!date) return '—'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// "Aug 03, 2026" within one day, otherwise both ends. Dates only — the time of
// day the window was picked at isn't meaningful to a reader.
export function formatWindow(window) {
  if (!window) return ''
  const { start, end } = window
  if (dateKey(start) === dateKey(end)) return formatDate(start)
  return `${formatDate(start)} – ${formatDate(end)}`
}

// Local calendar-day key (YYYY-MM-DD) used to bucket sessions by upload day.
export function dateKey(date) {
  if (!date) return 'unknown'
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Friendly header for a day group: "Today" / "Yesterday", else the full date.
export function dateGroupLabel(date) {
  if (!date) return 'No date'
  const today = new Date()
  const key = dateKey(date)
  if (key === dateKey(today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (key === dateKey(yesterday)) return 'Yesterday'
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' })
}

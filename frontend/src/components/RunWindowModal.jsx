import { useEffect, useState } from 'react'

// Modal asking for the date/time window a manual run should cover. The session it
// creates owns no articles — it shows the project's article pool (which the hourly
// scheduler fills) filtered to this window, so the window is the whole question.
//
// The inputs are <input type="datetime-local">, i.e. wall-clock in the browser's
// timezone with no offset. We convert to UTC ISO on submit so the backend never has
// to guess which zone the user meant.

// Date -> "YYYY-MM-DDTHH:mm" in local time, the format datetime-local expects.
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function defaultWindow() {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  return { start: toLocalInput(start), end: toLocalInput(end) }
}

export default function RunWindowModal({ open, query, running = false, onClose, onRun }) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const { start: s, end: e } = defaultWindow()
    setStart(s)
    setEnd(e)
    setError('')
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function submit(e) {
    e.preventDefault()
    if (running) return
    if (!start || !end) {
      setError('Pick both a start and an end.')
      return
    }
    // new Date(<local string>) parses as local time; toISOString gives UTC.
    const startIso = new Date(start).toISOString()
    const endIso = new Date(end).toISOString()
    if (endIso <= startIso) {
      setError('The end must be after the start.')
      return
    }
    setError('')
    onRun(startIso, endIso)
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="run-title" className="modal__title">Run {query?.name || 'query'}</h2>
        <p className="modal__sub">
          Choose the period to review. The run shows every article this project has collected
          in that window
          {query?.status === 'Scheduled'
            ? ', and tags anything the hourly schedule has not tagged yet.'
            : ', and fetches the last 24 hours before it opens.'}
        </p>

        <form onSubmit={submit} className="form">
          <label className="field">
            <span className="field__label">From</span>
            <input
              className="field__input"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </label>

          <label className="field">
            <span className="field__label">To</span>
            <input
              className="field__input"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </label>

          {error && <p className="form__error">{error}</p>}

          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={running}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={running}>
              {running ? 'Starting…' : 'Run'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

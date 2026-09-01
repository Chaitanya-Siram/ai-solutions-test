import { useEffect, useState } from 'react'
import { downloadArticlesExcel, getExportFields } from '../api/tagging.js'
import { DownloadIcon } from './Icons.jsx'

// Download popup for the review screen: pick which relevance buckets to include
// and which columns the Excel file should carry, then stream the .xlsx back.
//
// The field list comes from the backend (`/tagging/export/fields`) rather than
// being repeated here — it is the same catalogue the sheet's columns are built
// from, so a new export field appears in this popup without a frontend change.

const ARTICLE_TYPES = [
  {
    key: 'relevant',
    label: 'Relevant',
    hint: 'Articles that passed the relevancy gate and carry AI tags',
  },
  {
    key: 'irrelevant',
    label: 'Not relevant',
    hint: 'Articles the relevancy agent excluded before tagging',
  },
]

// Toggle a key in a Set, returning a new Set (state must not be mutated).
function toggled(set, key) {
  const next = new Set(set)
  next.has(key) ? next.delete(key) : next.add(key)
  return next
}

export default function DownloadArticlesModal({ open, sessionId, onClose }) {
  const [fieldOptions, setFieldOptions] = useState([])
  const [types, setTypes] = useState(() => new Set(['relevant', 'irrelevant']))
  const [fields, setFields] = useState(() => new Set())
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')

  // Re-fetch the catalogue and reset the selection every time the popup opens, so
  // a previous run's tweaks don't quietly carry over into the next download.
  useEffect(() => {
    if (!open) return undefined
    setTypes(new Set(ARTICLE_TYPES.map((t) => t.key)))
    setError('')
    setLoading(true)
    let alive = true
    getExportFields()
      .then((opts) => {
        if (!alive) return
        const list = Array.isArray(opts) ? opts : []
        setFieldOptions(list)
        setFields(new Set(list.filter((o) => o.default).map((o) => o.key)))
      })
      .catch((err) => {
        if (alive) setError(err.message || 'Failed to load the field list.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && !downloading) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, downloading, onClose])

  if (!open) return null

  async function submit(e) {
    e.preventDefault()
    if (downloading) return
    if (types.size === 0) {
      setError('Pick at least one article type.')
      return
    }
    if (fields.size === 0) {
      setError('Pick at least one field.')
      return
    }
    setError('')
    setDownloading(true)
    try {
      // Send the fields in catalogue order — the sheet's column order.
      const keys = fieldOptions.filter((o) => fields.has(o.key)).map((o) => o.key)
      await downloadArticlesExcel(sessionId, [...types], keys)
      onClose()
    } catch (err) {
      setError(err.message || 'Download failed.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => { if (!downloading) onClose() }}>
      <form
        className="modal modal--export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dl-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="dl-title" className="modal__title">Download articles</h2>
        <p className="modal__sub">
          Choose which articles and which columns go into the Excel file.
        </p>

        <div className="expsec">
          <div className="expsec__head">
            <span className="expsec__title">Article types</span>
          </div>
          <div className="exptypes">
            {ARTICLE_TYPES.map((t) => (
              <label className="toggle" key={t.key} title={t.hint}>
                <input
                  type="checkbox"
                  checked={types.has(t.key)}
                  onChange={() => setTypes((prev) => toggled(prev, t.key))}
                  disabled={downloading}
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>

        <div className="expsec">
          <div className="expsec__head">
            <span className="expsec__title">Fields ({fields.size} of {fieldOptions.length})</span>
            <span className="expsec__actions">
              <button
                type="button"
                className="linkbtn"
                onClick={() => setFields(new Set(fieldOptions.map((o) => o.key)))}
                disabled={downloading || loading}
              >
                Select all
              </button>
              <button
                type="button"
                className="linkbtn"
                onClick={() => setFields(new Set())}
                disabled={downloading || loading}
              >
                Clear all
              </button>
            </span>
          </div>
          <div className="expfields">
            {loading && <span className="muted">Loading fields…</span>}
            {!loading && fieldOptions.map((o) => (
              <label className="toggle" key={o.key}>
                <input
                  type="checkbox"
                  checked={fields.has(o.key)}
                  onChange={() => setFields((prev) => toggled(prev, o.key))}
                  disabled={downloading}
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>

        {error && <p className="form__error">{error}</p>}

        <div className="form__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={downloading}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={downloading || loading}>
            <DownloadIcon width={18} height={18} className={downloading ? 'spin' : undefined} />
            {downloading ? 'Preparing…' : 'Download Excel'}
          </button>
        </div>
      </form>
    </div>
  )
}

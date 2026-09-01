import { useEffect, useRef, useState } from 'react'
import { compareReportExcel } from '../api/sessions.js'
import { SpreadsheetIcon } from './Icons.jsx'

// Compare popup for the review screen: pick the report date, upload the delivered
// report .xlsx, and see how many of its articles the tool already has.
//
// The backend reads every sheet and matches on URL, so the result also lists the
// report rows with no match — those are the articles the pipeline didn't pick up.

export default function CompareReportModal({ open, sessionId, onClose }) {
  const [reportDate, setReportDate] = useState('')
  const [file, setFile] = useState(null)
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const fileRef = useRef(null)

  // Reset every time the popup opens so a previous comparison doesn't linger.
  useEffect(() => {
    if (!open) return
    setReportDate('')
    setFile(null)
    setError('')
    setResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && !comparing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, comparing, onClose])

  if (!open) return null

  async function submit(e) {
    e.preventDefault()
    if (comparing) return
    if (!reportDate) {
      setError('Pick the report date.')
      return
    }
    if (!file) {
      setError('Choose the report Excel file.')
      return
    }
    setError('')
    setComparing(true)
    try {
      setResult(await compareReportExcel({ sessionId, reportDate, file }))
    } catch (err) {
      setError(err.message || 'Comparison failed.')
    } finally {
      setComparing(false)
    }
  }

  const counts = result?.comparison
  const missing = result?.missing || []
  const mismatches = result?.section_mismatches || []

  return (
    <div className="overlay" onMouseDown={() => { if (!comparing) onClose() }}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmp-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="cmp-title" className="modal__title">Compare report</h2>
        <p className="modal__sub">
          Upload the delivered report to see how many of its articles this session already has.
          Each sheet is read, and articles are matched on their URL.
        </p>

        <form onSubmit={submit} className="form">
          <label className="field">
            <span className="field__label">Report date</span>
            <input
              className="field__input"
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              disabled={comparing}
              required
            />
          </label>

          <label className="field">
            <span className="field__label">Report file</span>
            <input
              ref={fileRef}
              className="field__input field__file"
              type="file"
              accept=".xlsx,.xlsm"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null) }}
              disabled={comparing}
            />
          </label>

          {counts && (
            <div className="cmpres">
              <div className="cmpres__stats">
                <div className="cmpres__stat">
                  <span className="cmpres__num">{counts.total_report_articles}</span>
                  <span className="cmpres__lbl">In report</span>
                </div>
                <div className="cmpres__stat">
                  <span className="cmpres__num">{counts.total_articles_found_in_tool}</span>
                  <span className="cmpres__lbl">Found in tool</span>
                </div>
                <div className="cmpres__stat">
                  <span className="cmpres__num cmpres__num--miss">{missing.length}</span>
                  <span className="cmpres__lbl">Not found</span>
                </div>
                <div className="cmpres__stat">
                  <span className="cmpres__num cmpres__num--warn">{mismatches.length}</span>
                  <span className="cmpres__lbl">Wrong section</span>
                </div>
                <div className="cmpres__stat">
                  <span className="cmpres__num cmpres__num--warn">{counts.tagged_irrelevant}</span>
                  <span className="cmpres__lbl">Tagged irrelevant</span>
                </div>
              </div>
              {missing.length === 0 ? (
                <p className="muted cmpres__none">Every article in the report is already in the tool.</p>
              ) : (
                <ul className="cmpres__list">
                  {missing.map((m) => (
                    <li key={m.url} className="cmpres__item">
                      <a href={m.url} target="_blank" rel="noreferrer" title={m.url}>
                        {m.headline || m.url}
                      </a>
                      <span className="cmpres__meta">{m.sheet}</span>
                    </li>
                  ))}
                </ul>
              )}
              {mismatches.length > 0 && (
                <>
                  <p className="cmpres__head">Found, but filed under a different section</p>
                  <ul className="cmpres__list">
                    {mismatches.map((m) => (
                      <li key={m.url} className="cmpres__item">
                        <a href={m.url} target="_blank" rel="noreferrer" title={m.url}>
                          {m.headline || m.url}
                        </a>
                        <span className="cmpres__meta">
                          {m.ai_section || '—'} → {m.correct_section || '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {error && <p className="form__error">{error}</p>}

          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={comparing}>
              {result ? 'Close' : 'Cancel'}
            </button>
            <button type="submit" className="btn btn--primary" disabled={comparing}>
              <SpreadsheetIcon width={18} height={18} className={comparing ? 'spin' : undefined} />
              {comparing ? 'Comparing…' : 'Compare'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

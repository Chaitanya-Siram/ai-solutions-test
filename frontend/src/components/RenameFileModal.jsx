import { useEffect, useMemo, useRef, useState } from 'react'

// Split a file name into an editable stem and a fixed extension (e.g.
// "report.csv" -> { stem: "report", ext: ".csv" }). Names without a real
// file extension (e.g. "Merged (2 files)") get an empty ext and are fully
// editable.
function splitName(name) {
  const value = name || ''
  const dot = value.lastIndexOf('.')
  if (dot > 0 && /^\.[a-z0-9]{1,6}$/i.test(value.slice(dot))) {
    return { stem: value.slice(0, dot), ext: value.slice(dot) }
  }
  return { stem: value, ext: '' }
}

// Popup to rename a data file. The extension is shown but not editable — only
// the stem can be changed, then it's recombined with the original extension.
export default function RenameFileModal({ open, initialName = '', saving = false, onClose, onSave }) {
  const { stem: initialStem, ext } = useMemo(() => splitName(initialName), [initialName])
  const [stem, setStem] = useState(initialStem)
  const ref = useRef(null)

  useEffect(() => {
    if (open) {
      setStem(initialStem)
      setTimeout(() => ref.current?.focus(), 0)
    }
  }, [open, initialStem])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function handleSubmit(e) {
    e.preventDefault()
    if (saving) return
    const next = stem.trim()
    if (!next) return
    onSave(next + ext)
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rn-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="rn-title" className="modal__title">Rename file</h2>
        <p className="modal__sub">The file extension can't be changed.</p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">File name</span>
            <div className="renamefield">
              <input
                ref={ref}
                className="field__input renamefield__input"
                value={stem}
                disabled={saving}
                onChange={(e) => setStem(e.target.value)}
              />
              {ext && <span className="renamefield__ext">{ext}</span>}
            </div>
          </label>

          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={saving || !stem.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

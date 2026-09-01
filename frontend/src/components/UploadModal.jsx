import { useEffect, useRef, useState } from 'react'
import { uploadFile } from '../api/sessions.js'

export default function UploadModal({ open, projectId, onClose, onUploaded }) {
  const [file, setFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    if (open) {
      setFile(null)
      setError('')
      setSubmitting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function handleSubmit(e) {
    e.preventDefault()
    if (!file) return setError('Please choose a file to upload.')

    setSubmitting(true)
    setError('')
    try {
      const result = await uploadFile({ projectId, file })
      onUploaded(result)
    } catch (err) {
      setError(err.message || 'Upload failed.')
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="upload-title" className="modal__title">Upload file</h2>
        <p className="modal__sub">
          Add a CSV, Excel, or JSON file to this project. The project's brand, competitor and
          message keywords apply automatically.
        </p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">File</span>
            <input
              ref={fileRef}
              className="field__input field__file"
              type="file"
              accept=".csv,.xlsx,.xls,.json"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>

          {error && <p className="form__error">{error}</p>}

          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Uploading…' : 'Upload and Review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

export default function AddProjectModal({ open, onClose, onCreate }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const nameRef = useRef(null)

  // Reset + focus whenever the modal opens.
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
      setError('')
      setSubmitting(false)
      // focus after the element is painted
      setTimeout(() => nameRef.current?.focus(), 0)
    }
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Project name is required.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onCreate({ name: trimmed, description: description.trim() })
    } catch (err) {
      setError(err.message || 'Failed to create project.')
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="modal-title" className="modal__title">New project</h2>
        <p className="modal__sub">Add a workspace for a new media intelligence project.</p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              ref={nameRef}
              className="field__input"
              type="text"
              value={name}
              maxLength={255}
              placeholder="Company Name e.g. Infovision"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Description <span className="field__opt">(optional)</span></span>
            <textarea
              className="field__input field__textarea"
              value={description}
              rows={3}
              placeholder="What is this project about?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {error && <p className="form__error">{error}</p>}

          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

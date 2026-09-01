import { useEffect, useRef, useState } from 'react'

const splitList = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

// Popup shown right after a project is created: capture the project-level
// brand, competitor and message keywords (these used to be set per session).
export default function ProjectKeywordsModal({ open, project, saving = false, showCancel = false, onClose, onSave }) {
  const [brand, setBrand] = useState('')
  const [competitors, setCompetitors] = useState('')
  const [messages, setMessages] = useState('')
  const [error, setError] = useState('')
  const brandRef = useRef(null)

  useEffect(() => {
    if (open) {
      setBrand((project?.brand_keywords || []).join(', '))
      setCompetitors((project?.competitor_keywords || []).join(', '))
      setMessages((project?.message_keywords || []).join(', '))
      setError('')
      setTimeout(() => brandRef.current?.focus(), 0)
    }
  }, [open, project])

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
    const brandKeywords = splitList(brand)
    const competitorKeywords = splitList(competitors)
    const messageKeywords = splitList(messages)

    if (brandKeywords.length !== 1) return setError('Enter exactly one brand keyword.')
    if (competitorKeywords.length === 0) return setError('Enter at least one competitor keyword.')

    setError('')
    onSave({
      brand_keywords: brandKeywords,
      competitor_keywords: competitorKeywords,
      message_keywords: messageKeywords,
    })
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pk-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="pk-title" className="modal__title">Project keywords</h2>
        <p className="modal__sub">
          {project?.name ? `Set the keywords for “${project.name}”.` : 'Set the keywords for this project.'}{' '}
          These apply to every session in the project.
        </p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">Brand keyword <span className="field__req">*</span></span>
            <input
              ref={brandRef}
              className="field__input"
              type="text"
              value={brand}
              placeholder="e.g. Lumen"
              onChange={(e) => setBrand(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">
              Competitor keywords <span className="field__req">*</span> <span className="field__opt">(comma-separated)</span>
            </span>
            <input
              className="field__input"
              type="text"
              value={competitors}
              placeholder="e.g. Vertex, Northstar"
              onChange={(e) => setCompetitors(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">
              Message keywords <span className="field__opt">(optional, comma-separated)</span>
            </span>
            <input
              className="field__input"
              type="text"
              value={messages}
              placeholder="e.g. innovation, sustainability"
              onChange={(e) => setMessages(e.target.value)}
            />
          </label>

          {error && <p className="form__error">{error}</p>}

          <div className="form__actions">
            {showCancel && (
              <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save and continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

// Popup to write the project's "relevancy" prompt — the criteria the relevancy
// agent uses to decide which fetched/uploaded articles are relevant enough to
// tag (irrelevant ones are filtered out before tagging).
export default function RelevancyPromptModal({ open, initialValue = '', saving = false, onClose, onSave }) {
  const [prompt, setPrompt] = useState(initialValue)
  const ref = useRef(null)

  useEffect(() => {
    if (open) {
      setPrompt(initialValue)
      setTimeout(() => ref.current?.focus(), 0)
    }
  }, [open, initialValue])

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
    onSave(prompt.trim())
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rp-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="rp-title" className="modal__title">Relevancy prompt</h2>
        <p className="modal__sub">
          Describe what makes an article relevant to this project. The relevancy agent uses
          this to keep only relevant articles for tagging; the rest go to the Irrelevant tab.
          Leave empty to fall back to the built-in per-brand criteria.
        </p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">Relevancy criteria</span>
            <textarea
              ref={ref}
              className="field__input field__textarea"
              value={prompt}
              rows={12}
              placeholder={
                'Include:\n- Coverage of {brand}, its products, and direct competitors.\n- Industry/policy news that materially affects {brand}.\n\nExclude:\n- Passing mentions with no substantive connection.\n- Share-trading noise, unrelated topics.'
              }
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>

          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save relevancy prompt'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

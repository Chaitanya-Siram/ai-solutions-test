import { useEffect } from 'react'

// Confirmation popup, in place of window.confirm. `danger` styles the confirm button
// as destructive; `body` is optional detail shown under the question.
export default function ConfirmModal({
  open,
  title = 'Are you sure?',
  body = '',
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onClose,
  onConfirm,
}) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  return (
    <div className="overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal modal--confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cf-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="cf-title" className="modal__title">{title}</h2>
        {body && <p className="modal__sub modal__sub--confirm">{body}</p>}

        <div className="form__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

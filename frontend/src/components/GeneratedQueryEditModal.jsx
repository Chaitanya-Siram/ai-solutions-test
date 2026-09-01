import { useEffect, useRef, useState } from 'react'
import { CloseIcon, PlusIcon, TrashIcon } from './Icons.jsx'

// Turn a group's queries array into a textarea value: comma-separated, one query
// per line (comma + newline) so the separators are visible AND easy to read.
const toText = (queries) => (Array.isArray(queries) ? queries.join(',\n') : '')
// Split a textarea value back into a trimmed, non-empty query list. Split on the
// comma; trimming removes the surrounding newlines/whitespace.
const toList = (text) =>
  String(text || '')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean)

// Edit a generated query: its name and its grouped search queries.
export default function GeneratedQueryEditModal({ open, query, saving = false, onClose, onSave }) {
  const [name, setName] = useState('')
  const [groups, setGroups] = useState([])
  const [error, setError] = useState('')
  const nameRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setName(query?.name || '')
    const src = Array.isArray(query?.queries) ? query.queries : []
    setGroups(src.map((g) => ({ label: g.label || '', text: toText(g.queries) })))
    setError('')
    setTimeout(() => nameRef.current?.focus(), 0)
  }, [open, query])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const setGroup = (i, patch) =>
    setGroups((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : g)))
  const addGroup = () => setGroups((gs) => [...gs, { label: '', text: '' }])
  const removeGroup = (i) => setGroups((gs) => gs.filter((_, j) => j !== i))

  function handleSubmit(e) {
    e.preventDefault()
    if (saving) return
    const trimmedName = name.trim()
    if (!trimmedName) return setError('Name is required.')
    const query_groups = groups
      .map((g) => ({ label: g.label.trim() || 'Queries', queries: toList(g.text) }))
      .filter((g) => g.queries.length > 0)
    if (query_groups.length === 0) return setError('Add at least one query.')
    setError('')
    onSave({ name: trimmedName, queries: query_groups })
  }

  const totalQueries = groups.reduce((n, g) => n + toList(g.text).length, 0)

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gqe-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="gqe-title" className="modal__title">Edit generated query</h2>
        <p className="modal__sub">
          Edit the name and search queries. Separate queries with commas — each on its own line.
        </p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              ref={nameRef}
              className="field__input"
              type="text"
              value={name}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="gqe__groups">
            {groups.map((g, i) => (
              <div className="gqe__group" key={i}>
                <div className="gqe__grouphead">
                  <input
                    className="field__input gqe__grouplabel"
                    type="text"
                    value={g.label}
                    placeholder="Group label"
                    onChange={(e) => setGroup(i, { label: e.target.value })}
                  />
                  <button
                    type="button"
                    className="iconaction iconaction--danger"
                    title="Remove group"
                    onClick={() => removeGroup(i)}
                  >
                    <TrashIcon width={16} height={16} />
                  </button>
                </div>
                <textarea
                  className="field__input field__textarea gqe__queries"
                  rows={Math.min(14, Math.max(3, g.text.split('\n').length + 1))}
                  value={g.text}
                  placeholder={'"BeOne" OR "BeOne Medicines",\n"zanubrutinib" OR "BGB-3111"'}
                  onChange={(e) => setGroup(i, { text: e.target.value })}
                />
              </div>
            ))}
            <button type="button" className="btn btn--ghost gqe__addgroup" onClick={addGroup}>
              <PlusIcon width={16} height={16} /> Add group
            </button>
          </div>

          {error && <p className="form__error">{error}</p>}

          <div className="form__actions">
            <span className="gqe__count muted">{totalQueries} quer{totalQueries === 1 ? 'y' : 'ies'} · {groups.length} group{groups.length === 1 ? '' : 's'}</span>
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
              <CloseIcon width={16} height={16} /> Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import { useState } from 'react'

// Keyword chip input. Press Enter or comma to add, Backspace (on an empty
// field) to remove the last chip. Used for brand / competitor keywords.
// When `required`, at least one chip must remain — the last can't be removed.
export default function TagInput({ value = [], onChange, placeholder = 'Add keyword…', tone = 'brand', required = false }) {
  const [draft, setDraft] = useState('')
  const atMin = required && value.length <= 1

  function commit(raw) {
    const next = raw.trim().replace(/,$/, '').trim()
    if (!next) return
    if (!value.includes(next)) onChange([...value, next])
    setDraft('')
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && draft === '' && value.length && !atMin) {
      onChange(value.slice(0, -1))
    }
  }

  function remove(k) {
    if (atMin) return // keep at least one — field is required
    onChange(value.filter((x) => x !== k))
  }

  const invalid = required && value.length === 0
  return (
    <div className={`taginput${invalid ? ' taginput--invalid' : ''}`}>
      {value.map((k) => (
        <span className={`pill pill--${tone}`} key={k}>
          {k}
          <button
            type="button"
            className="taginput__x"
            aria-label={`Remove ${k}`}
            onClick={() => remove(k)}
            disabled={atMin}
            title={atMin ? 'At least one keyword is required' : `Remove ${k}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="taginput__field"
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
      />
    </div>
  )
}

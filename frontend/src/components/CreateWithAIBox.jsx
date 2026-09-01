import { useState } from 'react'
import { ChatIcon, SendIcon } from './Icons.jsx'

// Centered "create a project with natural language" box. Stub only — no backend
// yet; submitting shows a "coming soon" note.
export default function CreateWithAIBox() {
  const [input, setInput] = useState('')
  const [note, setNote] = useState('')

  function submit() {
    if (!input.trim()) return
    setNote('🚧 Coming soon — creating projects from natural language isn’t available yet.')
    setInput('')
  }

  return (
    <section className="createai">
      <span className="createai__icon"><ChatIcon width={22} height={22} /></span>
      <h2 className="createai__title">Create with natural language</h2>
      <p className="createai__sub">
        Describe the project or upload you want, and the agent will set it up for you.
      </p>
      <div className="createai__input">
        <input
          value={input}
          placeholder="e.g. Create a BeOne project tracking AstraZeneca, Novartis and Roche…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
        <button className="btn btn--primary" onClick={submit} disabled={!input.trim()}>
          <SendIcon width={18} height={18} /> Create
        </button>
      </div>
      {note && <p className="createai__note">{note}</p>}
    </section>
  )
}

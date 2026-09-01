import { useEffect, useRef, useState } from 'react'
import { taggingWsUrl } from '../api/tagging.js'

// Opens the /ws/tagging socket for a session, streams progress messages, and
// calls onComplete() once the backend emits "complete". Not dismissable while
// running (tagging keeps going server-side regardless).
export default function TaggingProgressModal({ open, sessionId, onClose, onComplete }) {
  const [messages, setMessages] = useState([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [totalArticles, setTotalArticles] = useState(0)
  const [phase, setPhase] = useState('connecting') // connecting | running | complete | error
  const [errorMsg, setErrorMsg] = useState('')
  const wsRef = useRef(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    if (!open) return undefined

    setMessages([])
    setProgress({ done: 0, total: 0 })
    setTotalArticles(0)
    setPhase('connecting')
    setErrorMsg('')

    const push = (text) => setMessages((m) => [...m, text])
    const ws = new WebSocket(taggingWsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      setPhase('running')
      push('Connected — starting tagging…')
      ws.send(JSON.stringify({ session_id: sessionId }))
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'start':
          setTotalArticles(msg.total_articles || 0)
          push(`Tagging ${msg.total_articles} articles…`)
          break
        case 'batch':
          setProgress({ done: msg.completed_batches || 0, total: msg.total_batches || 0 })
          push(
            `Batch ${(msg.batch_index ?? 0) + 1} done — ${msg.completed_batches}/${msg.total_batches} batches (${msg.tagged_count} tagged)`,
          )
          break
        case 'complete':
          setPhase('complete')
          setProgress((p) => ({ done: p.total || p.done, total: p.total || p.done }))
          push(`Completed ${msg.total_tagged} articles in ${msg.elapsed_seconds}s.`)
          onCompleteRef.current?.()
          break
        case 'error':
          setPhase('error')
          setErrorMsg(msg.detail || 'Tagging failed.')
          push(`Error: ${msg.detail}`)
          break
        default:
          break
      }
    }

    ws.onerror = () => {
      setPhase((p) => (p === 'complete' ? p : 'error'))
      setErrorMsg((m) => m || 'Connection error — is the backend running?')
    }

    return () => {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }, [open, sessionId])

  if (!open) return null

  const indeterminate = phase === 'running' && progress.total === 0
  const pct = phase === 'complete' ? 100 : progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="overlay">
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="tag-title">
        <h2 id="tag-title" className="modal__title">
          {phase === 'error' ? 'Tagging failed' : phase === 'complete' ? 'Tagging complete' : 'Generating dashboards'}
        </h2>
        <p className="modal__sub">
          {phase === 'error'
            ? errorMsg
            : phase === 'complete'
            ? 'Opening the article review…'
            : `Running AI tagging${totalArticles ? ` on ${totalArticles} articles` : ''}. This can take a moment.`}
        </p>

        <div className={`progress${indeterminate ? ' progress--indeterminate' : ''}`}>
          <div className="progress__bar" style={{ width: indeterminate ? '40%' : `${pct}%` }} />
        </div>
        {progress.total > 0 && phase !== 'error' && (
          <p className="progress__label">
            {progress.done}/{progress.total} batches · {pct}%
          </p>
        )}

        <div className="log">
          {messages.map((m, i) => (
            <div className="log__line" key={i}>{m}</div>
          ))}
        </div>

        <div className="form__actions">
          {phase === 'error' ? (
            <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
          ) : phase === 'complete' ? null : (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Run in background
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { agentWsUrl } from '../api/agent.js'
import AgentChart from './AgentChart.jsx'
import { Rich } from '../utils/text.jsx'
import { ChatIcon, CloseIcon, SendIcon } from './Icons.jsx'

let msgId = 0
const nextId = () => ++msgId

// A bottom-docked chat over /ws/agent.
//  - mode="inline": chart results render inside the chat thread.
//  - mode="route" : chart results are handed to onCharts(charts, query) (e.g. a
//    "Dynamic Charts" tab) and the thread shows a short note instead.
// Text answers always render in the thread, in both modes.
export default function ChatDock({
  sessionId,
  mode = 'inline',
  onCharts,
  placeholder,
  comingSoon = false,
  title = 'Data agent',
  launcherLabel = 'Ask the data agent',
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [thread, setThread] = useState([])
  const wsRef = useRef(null)
  const bottomRef = useRef(null)

  const push = (m) => setThread((t) => [...t, { id: nextId(), ...m }])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [thread, status])

  useEffect(() => () => {
    try { wsRef.current?.close() } catch { /* noop */ }
  }, [])

  function send() {
    const query = input.trim()
    if (!query || busy) return
    // Stub mode: no backend yet — acknowledge and show a "coming soon" note.
    if (comingSoon) {
      push({ role: 'user', text: query })
      setInput('')
      push({
        role: 'agent',
        kind: 'note',
        text: '🚧 Coming soon — creating projects from natural language isn’t available yet.',
      })
      return
    }
    if (!sessionId) {
      push({ role: 'agent', kind: 'error', text: 'No session is available for the agent.' })
      return
    }
    push({ role: 'user', text: query })
    setInput('')
    setBusy(true)
    setStatus('Thinking…')

    const collected = []
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      setBusy(false)
      setStatus('')
      try { wsRef.current?.close() } catch { /* noop */ }
    }

    const ws = new WebSocket(agentWsUrl())
    wsRef.current = ws

    ws.onopen = () => ws.send(JSON.stringify({ session_id: sessionId, query }))

    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      switch (msg.type) {
        case 'intent':
          setStatus(msg.intent === 'chart' ? 'Generating charts…' : 'Reading the data…')
          break
        case 'status':
          setStatus(msg.message || '')
          break
        case 'plan':
          setStatus(`Generating ${msg.count} chart${msg.count === 1 ? '' : 's'}…`)
          break
        case 'code':
          setStatus(`Writing code for ${msg.chart_id}…`)
          break
        case 'retry':
          setStatus(`Fixing ${msg.chart_id} (retry ${msg.attempt}/${msg.max_retries})…`)
          break
        case 'chart':
          if (msg.chart) collected.push(msg.chart)
          break
        case 'answer':
          push({ role: 'agent', kind: 'text', text: msg.answer || '' })
          break
        case 'complete':
          if (collected.length) {
            if (mode === 'route') {
              onCharts?.(collected, query)
              push({
                role: 'agent',
                kind: 'note',
                text: `📊 Added ${collected.length} chart${collected.length === 1 ? '' : 's'} to the Dynamic Charts tab.`,
              })
            } else {
              push({ role: 'agent', kind: 'charts', charts: collected })
            }
          }
          finish()
          break
        case 'error':
          push({ role: 'agent', kind: 'error', text: msg.detail || 'The agent failed.' })
          finish()
          break
        default:
          break
      }
    }

    ws.onerror = () => {
      if (!finished) {
        push({ role: 'agent', kind: 'error', text: 'Connection error — is the backend running?' })
        finish()
      }
    }
    ws.onclose = () => { if (!finished) finish() }
  }

  if (!open) {
    return (
      <button className="chatlauncher" onClick={() => setOpen(true)} aria-label="Open chat">
        <ChatIcon width={20} height={20} />
        <span>{launcherLabel}</span>
      </button>
    )
  }

  return (
    <div className="chatdock" role="dialog" aria-label="Chat">
      <header className="chatdock__head">
        <span className="chatdock__title"><ChatIcon width={17} height={17} /> {title}</span>
        <button className="chatdock__close" onClick={() => setOpen(false)} aria-label="Close chat">
          <CloseIcon width={16} height={16} />
        </button>
      </header>

      <div className="chatdock__thread">
        {thread.length === 0 && (
          <div className="chatdock__empty">
            {comingSoon ? (
              <>
                <p>Create a project with natural language.</p>
                <p className="muted">e.g. “Create a BeOne project tracking AstraZeneca, Novartis and Roche.”</p>
              </>
            ) : (
              <>
                <p>Ask a question about this data, or request a chart.</p>
                <p className="muted">e.g. “What’s driving negative coverage?” or “Chart sentiment by media type.”</p>
              </>
            )}
          </div>
        )}
        {thread.map((m) =>
          m.role === 'user' ? (
            <div className="cmsg cmsg--user" key={m.id}>{m.text}</div>
          ) : m.kind === 'charts' ? (
            <div className="cmsg cmsg--agent cmsg--charts" key={m.id}>
              {m.charts.map((c, i) => (
                <div className="cmsg__chart" key={i}>
                  <p className="cmsg__charttitle">{c.title || c.chart_id}</p>
                  {c.description && <p className="cmsg__chartdesc">{c.description}</p>}
                  <AgentChart chart={c} height={240} />
                </div>
              ))}
            </div>
          ) : m.kind === 'error' ? (
            <div className="cmsg cmsg--error" key={m.id}>{m.text}</div>
          ) : m.kind === 'note' ? (
            <div className="cmsg cmsg--note" key={m.id}>{m.text}</div>
          ) : (
            <div className="cmsg cmsg--agent" key={m.id}><Rich text={m.text} /></div>
          ),
        )}
        {busy && <div className="cmsg cmsg--status"><span className="cdots"><i /><i /><i /></span>{status}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="chatdock__input">
        <input
          value={input}
          placeholder={placeholder || 'Ask about the data or request a chart…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send() }}
          disabled={busy}
        />
        <button className="chatdock__send" onClick={send} disabled={busy || !input.trim()} aria-label="Send">
          <SendIcon width={18} height={18} />
        </button>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { queryBuilderWsUrl } from '../api/queryBuilder.js'
import { Rich } from '../utils/text.jsx'
import { CheckIcon, ChatIcon, CloseIcon, PlusIcon, SendIcon } from './Icons.jsx'

let mid = 0
const nextId = () => ++mid

const STAGE_LABELS = { 1: 'Brand', 2: 'Queries', 3: 'Competitors', 4: 'Refine' }
// Stages active in the current (reduced) flow. Brand (1) and Competitors (3) are
// disabled server-side; keep them in STAGE_LABELS for when they're turned back on.
const ACTIVE_STAGES = [2, 4]

// ---- artifact cards (Claude-style highlighted boxes) ----------------------

function BrandArtifact({ brand }) {
  if (!brand) return null
  return (
    <div className="qbart">
      <p className="qbart__label">Primary Brand</p>
      <div className="qbart__box qbart__box--brand">{brand}</div>
    </div>
  )
}

function CompetitorsArtifact({ competitors }) {
  if (!competitors?.length) return null
  return (
    <div className="qbart">
      <p className="qbart__label">Competitors</p>
      <div className="qbart__chips">
        {competitors.map((c, i) => <span className="qbart__chip qbart__chip--comp" key={i}>{c}</span>)}
      </div>
    </div>
  )
}

function QueryGroupsArtifact({ groups, topics, geography }) {
  if (!groups?.length) return null
  const total = groups.reduce((n, g) => n + (g.queries?.length || 0), 0)
  return (
    <div className="qbart qbart--scroll">
      {topics?.length > 0 && (
        <>
          <p className="qbart__label">Topics</p>
          <div className="qbart__chips">
            {topics.map((t, i) => <span className="qbart__chip" key={i}>{t}</span>)}
          </div>
        </>
      )}
      {geography && (
        <>
          <p className="qbart__label">Geography</p>
          <div className="qbart__box">{geography}</div>
        </>
      )}
      <p className="qbart__label">Search Queries · {total}</p>
      {groups.map((g, i) => (
        <div className="qbgroup" key={i}>
          <p className="qbgroup__label">{g.label} <span className="qbgroup__count">{g.queries?.length || 0}</span></p>
          {(g.queries || []).map((q, j) => <code className="qbquery__val" key={j}>{q}</code>)}
        </div>
      ))}
    </div>
  )
}

// Bottom-docked chat over /ws/query-builder. One socket stays open for the whole
// multi-turn conversation (the agent's state lives server-side per connection).
export default function QueryBuilderDock({ projectId, onSaved }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(2) // flow opens on the Queries stage
  const [thread, setThread] = useState([])
  const [opts, setOpts] = useState(null) // { options:[...], selected:Set, custom:'' }
  const [canSave, setCanSave] = useState(false) // a Save/Cancel prompt is pending
  const wsRef = useRef(null)
  const bottomRef = useRef(null)

  const push = (m) => setThread((t) => [...t, { id: nextId(), ...m }])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [thread, busy, opts])

  // Open one socket while the panel is open; close it when collapsed/unmounted.
  useEffect(() => {
    if (!open) return undefined
    setThread([])
    setOpts(null)
    setCanSave(false)
    setBusy(true)
    const ws = new WebSocket(queryBuilderWsUrl(projectId))
    wsRef.current = ws

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'agent':
          push({ role: 'agent', kind: 'text', text: msg.message || '' })
          if (Array.isArray(msg.options) && msg.options.length) {
            setOpts({ options: msg.options, selected: new Set(), custom: '' })
          }
          break
        case 'artifact':
          // Confirmed-value card, already in the right spot in the turn order.
          if (msg.artifact === 'brand') push({ role: 'agent', kind: 'brand', brand: msg.brand })
          else if (msg.artifact === 'competitors') push({ role: 'agent', kind: 'competitors', competitors: msg.competitors })
          else if (msg.artifact === 'query_groups') push({ role: 'agent', kind: 'query_groups', groups: msg.query_groups, topics: msg.topics, geography: msg.geography })
          break
        case 'confirm':
          setCanSave(true) // show the Save / Cancel buttons
          break
        case 'saved':
          setCanSave(false)
          push({ role: 'agent', kind: 'note', text: '✓ Saved — a monitoring session was created for this project.' })
          onSaved?.(msg.session)
          break
        case 'state':
          if (msg.state?.stage) setStage(msg.state.stage)
          setBusy(false) // last frame of a turn → ready for input
          break
        case 'error':
          push({ role: 'agent', kind: 'error', text: msg.detail || 'The agent failed.' })
          setBusy(false)
          break
        default:
          break
      }
    }
    ws.onerror = () => {
      push({ role: 'agent', kind: 'error', text: 'Connection error — is the backend running?' })
      setBusy(false)
    }
    ws.onclose = () => setBusy(false)

    return () => {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  function sendMessage(message) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      push({ role: 'agent', kind: 'error', text: 'Not connected — reopen the chat.' })
      return
    }
    push({ role: 'user', text: message })
    ws.send(JSON.stringify({ message }))
    setOpts(null) // any reply clears a pending option picker
    setCanSave(false) // …and a pending Save/Cancel prompt
    setBusy(true)
  }

  function saveConfig() {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    setCanSave(false)
    setBusy(true)
    ws.send(JSON.stringify({ action: 'save' }))
  }

  function cancelSave() {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    setCanSave(false)
    setBusy(true)
    ws.send(JSON.stringify({ action: 'cancel' }))
  }

  function send() {
    const message = input.trim()
    if (!message || busy) return
    setInput('')
    sendMessage(message)
  }

  function toggleOpt(name) {
    setOpts((o) => {
      if (!o) return o
      const selected = new Set(o.selected)
      selected.has(name) ? selected.delete(name) : selected.add(name)
      return { ...o, selected }
    })
  }

  function confirmOpts() {
    if (!opts) return
    const picked = [...opts.selected]
    const custom = opts.custom.split(',').map((s) => s.trim()).filter(Boolean)
    const all = [...new Set([...picked, ...custom])]
    if (!all.length) return
    // Generic — the agent maps the selection to the current stage (competitors / topics).
    sendMessage(`My selection: ${all.join(', ')}`)
  }

  if (!open) {
    return (
      <button className="chatlauncher" onClick={() => setOpen(true)} aria-label="Open query builder">
        <ChatIcon width={20} height={20} />
        <span>Create with natural language</span>
      </button>
    )
  }

  const canConfirm = opts && (opts.selected.size > 0 || opts.custom.trim())

  // Step indicator for the active flow (e.g. "Step 1/2 · Queries").
  const stepIndex = ACTIVE_STAGES.indexOf(stage)
  const stepLabel = stepIndex >= 0
    ? `Step ${stepIndex + 1}/${ACTIVE_STAGES.length} · ${STAGE_LABELS[stage]}`
    : (STAGE_LABELS[stage] || '')

  return (
    <div className="chatdock" role="dialog" aria-label="Query builder">
      <header className="chatdock__head">
        <span className="chatdock__title">
          <ChatIcon width={17} height={17} /> Query builder
          <span className="qb__stage">{stepLabel}</span>
        </span>
        <button className="chatdock__close" onClick={() => setOpen(false)} aria-label="Close">
          <CloseIcon width={16} height={16} />
        </button>
      </header>

      <div className="chatdock__thread">
        {thread.length === 0 && !busy && <div className="chatdock__empty"><p>Connecting…</p></div>}
        {thread.map((m) => {
          if (m.role === 'user') return <div className="cmsg cmsg--user" key={m.id}>{m.text}</div>
          if (m.kind === 'brand') return <div className="cmsg cmsg--agent cmsg--art" key={m.id}><BrandArtifact brand={m.brand} /></div>
          if (m.kind === 'competitors') return <div className="cmsg cmsg--agent cmsg--art" key={m.id}><CompetitorsArtifact competitors={m.competitors} /></div>
          if (m.kind === 'query_groups') return <div className="cmsg cmsg--agent cmsg--art" key={m.id}><QueryGroupsArtifact groups={m.groups} topics={m.topics} geography={m.geography} /></div>
          if (m.kind === 'error') return <div className="cmsg cmsg--error" key={m.id}>{m.text}</div>
          if (m.kind === 'note') return <div className="cmsg cmsg--note" key={m.id}>{m.text}</div>
          return <div className="cmsg cmsg--agent" key={m.id}><Rich text={m.text} /></div>
        })}

        {opts && !busy && (
          <div className="qbopts">
            <p className="qbopts__hint">Select all that apply (multi-select), then confirm:</p>
            <div className="qbopts__list">
              {opts.options.map((name) => {
                const on = opts.selected.has(name)
                return (
                  <button key={name} className={`qbopt${on ? ' qbopt--on' : ''}`} onClick={() => toggleOpt(name)}>
                    <span className="qbopt__check">{on && <CheckIcon width={12} height={12} />}</span>
                    {name}
                  </button>
                )
              })}
            </div>
            <div className="qbopts__custom">
              <PlusIcon width={15} height={15} />
              <input
                placeholder="Add your own (comma-separated)…"
                value={opts.custom}
                onChange={(e) => setOpts((o) => ({ ...o, custom: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmOpts() }}
              />
            </div>
            <button className="btn btn--primary qbopts__confirm" onClick={confirmOpts} disabled={!canConfirm}>
              Confirm selection
            </button>
          </div>
        )}

        {canSave && !busy && (
          <div className="qbsave">
            <button className="btn btn--primary" onClick={saveConfig}>
              <CheckIcon width={14} height={14} /> Save
            </button>
            <button className="btn btn--ghost" onClick={cancelSave}>Cancel</button>
          </div>
        )}

        {busy && <div className="cmsg cmsg--status"><span className="cdots"><i /><i /><i /></span></div>}
        <div ref={bottomRef} />
      </div>

      <div className="chatdock__input">
        <input
          value={input}
          placeholder="Type a reply…"
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

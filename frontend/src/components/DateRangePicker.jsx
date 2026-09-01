import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// A single-popup calendar that selects a date range. Emits YYYY-MM-DD strings
// (from, to) so it's a drop-in for the two native date inputs it replaces.
// The popup is positioned with `fixed` coordinates so it isn't clipped by the
// horizontally-scrolling table it lives inside.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
function toYmd(d) {
  if (!d) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function sameDay(a, b) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function fmtLabel(from, to) {
  const f = parseYmd(from)
  const t = parseYmd(to)
  const opt = { month: 'short', day: 'numeric', year: 'numeric' }
  if (!f && !t) return 'All dates'
  if (f && t) return `${f.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${t.toLocaleDateString('en-US', opt)}`
  if (f) return `From ${f.toLocaleDateString('en-US', opt)}`
  return `Until ${t.toLocaleDateString('en-US', opt)}`
}

export default function DateRangePicker({ from, to, onChange }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => parseYmd(from) || parseYmd(to) || new Date())
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const fromD = parseYmd(from)
  const toD = parseYmd(to)

  const reposition = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const W = 270
    const H = 310 // estimated height of the calendar popup
    const spaceBelow = window.innerHeight - r.bottom
    const showAbove = spaceBelow < H && r.top > H
    setPos({
      top: showAbove ? r.top - H - 6 : r.bottom + 6,
      left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8))
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return undefined
    reposition()
    const onDoc = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    document.addEventListener('mousedown', onDoc)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open, reposition])

  // Sync the visible month to the selection whenever the popup opens.
  useEffect(() => {
    if (open) setView(parseYmd(from) || parseYmd(to) || new Date())
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const cells = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1)
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()
    const lead = first.getDay()
    const out = []
    for (let i = 0; i < lead; i += 1) out.push(null)
    for (let d = 1; d <= days; d += 1) out.push(new Date(view.getFullYear(), view.getMonth(), d))
    return out
  }, [view])

  function pickDay(day) {
    // No start, or a complete range already → begin a new range.
    if (!fromD || (fromD && toD)) {
      onChange(toYmd(day), '')
      return
    }
    // Have a start, picking the end → order them.
    if (day < fromD) onChange(toYmd(day), toYmd(fromD))
    else onChange(toYmd(fromD), toYmd(day))
  }

  const today = new Date()
  const inRange = (d) => fromD && toD && d > fromD && d < toD

  return (
    <div className="drp" style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
      <button
        type="button"
        ref={btnRef}
        className={`drp__btn${open ? ' drp__btn--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        style={{ flex: 1, minWidth: 0, paddingRight: (from || to) ? '24px' : '8px' }}
      >
        <span
          className={fromD || toD ? undefined : 'muted'}
          style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {fmtLabel(from, to)}
        </span>
      </button>
      {(from || to) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onChange('', '')
            setOpen(false)
          }}
          title="Clear date filter"
          style={{
            position: 'absolute',
            right: '8px',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--text-soft)',
            fontSize: '16px',
            lineHeight: 1,
            zIndex: 2,
          }}
        >
          ×
        </button>
      )}

      {open && createPortal(
        <div className="drp__pop" ref={popRef} style={{ top: pos.top, left: pos.left }}>
          <div className="drp__head">
            <button type="button" className="drp__nav" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
            <span className="drp__title">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
            <button type="button" className="drp__nav" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))} aria-label="Next month">›</button>
          </div>

          <div className="drp__grid drp__grid--wd">
            {WEEKDAYS.map((w) => (
              <span className="drp__wd" key={w}>{w}</span>
            ))}
          </div>

          <div className="drp__grid">
            {cells.map((d, i) => {
              if (!d) return <span className="drp__day drp__day--blank" key={`b${i}`} />
              const isStart = sameDay(d, fromD)
              const isEnd = sameDay(d, toD)
              const cls = [
                'drp__day',
                inRange(d) ? 'drp__day--inrange' : '',
                isStart ? 'drp__day--start' : '',
                isEnd ? 'drp__day--end' : '',
                (isStart || isEnd) ? 'drp__day--sel' : '',
                sameDay(d, today) ? 'drp__day--today' : '',
              ].filter(Boolean).join(' ')
              return (
                <button type="button" className={cls} key={toYmd(d)} onClick={() => pickDay(d)}>
                  {d.getDate()}
                </button>
              )
            })}
          </div>

          <div className="drp__foot">
            <button type="button" className="linkbtn" onClick={() => { onChange('', ''); setOpen(false); }}>Clear</button>
            <button type="button" className="btn btn--ghost drp__done" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

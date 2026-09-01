import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDownIcon } from '../components/Icons.jsx'
import { Rich } from '../utils/text.jsx'
import MonitoringHero from '../components/MonitoringHero.jsx'
import { downloadMediaMonitoringReport, moveMediaMonitoringArticle } from '../api/charts.js'
import { updateSectionsOrders } from '../api/projects.js'

const DASHBOARD_KEY = 'media_monitoring'
const SECTION_CHART_ID = 'section_articles'

const SENT = {
  POS: { label: 'Positive', cls: 'sent--pos', color: '#059669' },
  NEG: { label: 'Negative', cls: 'sent--neg', color: '#dc2626' },
  NEU: { label: 'Neutral', cls: 'sent--neu', color: 'var(--text-soft)' },
}

// Stable slug so the section nav can scroll to its card.
function slug(name) {
  return `mmsec-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Normalize any date value to a local YYYY-MM-DD key.
function dayKey(d) {
  if (!d) return ''
  const s = String(d)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const dt = new Date(s)
  return Number.isNaN(dt.getTime()) ? '' : ymd(dt)
}

// Format a Date as a local YYYY-MM-DD key (no timezone shift).
function ymd(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function fmtDay(key) {
  if (!key) return ''
  const dt = new Date(`${key}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return key
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

// "May 6, 2026"
function fmtShort(key) {
  if (!key) return ''
  const dt = new Date(`${key}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return key
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// "Tuesday"
function weekday(key) {
  if (!key) return ''
  const dt = new Date(`${key}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return key
  return dt.toLocaleDateString('en-US', { weekday: 'long' })
}

function nf(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

// Author can arrive as a string or a list of names; join into a display string.
function authorText(author) {
  if (Array.isArray(author)) return author.filter(Boolean).join(', ')
  return author ? String(author).trim() : ''
}

// Overlay user article moves (id -> target section) on top of the section data
// derived from the charts payload, so a drag is reflected immediately and stays
// put even though `chartsData` still has the article in its original section.
function applyArticleMoves(sections, moves) {
  if (!moves || moves.size === 0) return sections
  const clone = sections.map((s) => ({ ...s, articles: [...s.articles] }))
  const byName = new Map(clone.map((s) => [s.name, s]))
  moves.forEach((target, id) => {
    const dest = byName.get(target)
    if (!dest) return
    let moved = null
    for (const s of clone) {
      const idx = s.articles.findIndex((a) => String(a.id) === id)
      if (idx === -1) continue
      if (s === dest) break // already where it should be
      moved = s.articles.splice(idx, 1)[0]
      break
    }
    if (moved) dest.articles.push(moved)
  })
  return clone
}

// Six-dot drag handle used on each section header.
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="3" r="1.4" /><circle cx="11" cy="3" r="1.4" />
      <circle cx="5" cy="8" r="1.4" /><circle cx="11" cy="8" r="1.4" />
      <circle cx="5" cy="13" r="1.4" /><circle cx="11" cy="13" r="1.4" />
    </svg>
  )
}

// --- calendar ---------------------------------------------------------------

// Month grid. Days that have articles get a dot and are selectable; clicking a
// day toggles it in/out of the selection (multi-select). `available` and
// `selected` are both Sets of YYYY-MM-DD keys.
function MiniCalendar({ available, selected, onToggle, initialMonth }) {
  const [view, setView] = useState(() => {
    const base = initialMonth ? new Date(`${initialMonth}T00:00:00`) : new Date()
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })

  const grid = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1)
    const startPad = first.getDay()
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < startPad; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.getFullYear(), view.getMonth(), d))
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [view])

  const shiftMonth = (delta) =>
    setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1))

  return (
    <div className="mmcal">
      <div className="mmcal__head">
        <button className="mmcal__nav" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
          <ChevronDownIcon width={16} height={16} style={{ transform: 'rotate(90deg)' }} />
        </button>
        <span className="mmcal__label">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
        <button className="mmcal__nav" aria-label="Next month" onClick={() => shiftMonth(1)}>
          <ChevronDownIcon width={16} height={16} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>

      <div className="mmcal__grid mmcal__grid--head">
        {WEEKDAYS.map((w) => (
          <span key={w} className="mmcal__wd">{w}</span>
        ))}
      </div>

      <div className="mmcal__grid">
        {grid.map((date, i) => {
          if (!date) return <span key={`b${i}`} className="mmcal__cell mmcal__cell--blank" />
          const key = ymd(date)
          const has = available.has(key)
          const isSelected = selected.has(key)
          return (
            <button
              key={key}
              type="button"
              className={`mmcal__cell${has ? ' mmcal__cell--has' : ''}${isSelected ? ' mmcal__cell--on' : ''}`}
              disabled={!has}
              title={has ? fmtDay(key) : undefined}
              onClick={() => onToggle(key)}
            >
              {date.getDate()}
              {has && <span className="mmcal__dot" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// --- main screen ------------------------------------------------------------

export default function MediaMonitoringScreen({ project, session, chartsData, chartsLoading = false, chartsError = '', onBack, onBackToReview }) {
  // Multi-select set of YYYY-MM-DD day keys. Empty = show all dates.
  const [selectedDays, setSelectedDays] = useState(() => new Set())
  // Which report variant is currently downloading ('' = none).
  const [downloading, setDownloading] = useState('')
  const [downloadError, setDownloadError] = useState('')

  // Article drag-and-drop between sections. `articleMoves` maps an article id to
  // the section the user dropped it into; it overlays the charts-derived data.
  const [articleMoves, setArticleMoves] = useState(() => new Map())
  const [dragArticle, setDragArticle] = useState(null)
  const [articleDropTarget, setArticleDropTarget] = useState(null)

  // Download the current view (respecting the date filter) as a .docx report.
  const handleDownloadReport = async (variant = 'coverage') => {
    if (!session?.id || downloading) return
    setDownloading(variant)
    setDownloadError('')
    try {
      await downloadMediaMonitoringReport(session.id, [...selectedDays].sort(), variant)
    } catch (err) {
      setDownloadError(err.message || 'Failed to download report.')
    } finally {
      setDownloading('')
    }
  }

  // Otsuka has two report layouts; every other brand has one. Keyed off the
  // first brand keyword, matching the backend's dispatch in report_api.
  const isOtsuka = (project?.brand_keywords?.[0] || '').toLowerCase().includes('otsuka')

  const downloads = useMemo(() => {
    if (!session?.id) return []
    if (!isOtsuka) {
      return [{
        key: 'coverage',
        label: 'Download report',
        busy: downloading === 'coverage',
        onClick: () => handleDownloadReport('coverage'),
      }]
    }
    return [
      {
        key: 'coverage',
        label: 'Coverage report',
        busy: downloading === 'coverage',
        onClick: () => handleDownloadReport('coverage'),
      },
      {
        key: 'summary',
        label: 'Summary report',
        busy: downloading === 'summary',
        onClick: () => handleDownloadReport('summary'),
      },
    ]
  }, [session?.id, isOtsuka, downloading, selectedDays])

  const toggleDay = (key) =>
    setSelectedDays((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // The section → articles dict produced by the backend (section_articles chart).
  const baseSections = useMemo(() => {
    const arr = chartsData?.[DASHBOARD_KEY]
    const chart = Array.isArray(arr) ? arr.find((c) => c?.chart_id === SECTION_CHART_ID) : null
    const data = chart?.data
    if (!data || typeof data !== 'object') return []
    return Object.entries(data).map(([name, articles]) => ({
      name,
      articles: Array.isArray(articles) ? articles : [],
    }))
  }, [chartsData])

  // Sections with the user's pending article moves applied.
  const sections = useMemo(
    () => applyArticleMoves(baseSections, articleMoves),
    [baseSections, articleMoves],
  )

  // All distinct day-keys across every section, for the calendar dots.
  const availableDays = useMemo(() => {
    const set = new Set()
    sections.forEach((s) => s.articles.forEach((a) => {
      const k = dayKey(a.date)
      if (k) set.add(k)
    }))
    return set
  }, [sections])

  const latestDay = useMemo(() => {
    let max = ''
    availableDays.forEach((k) => { if (k > max) max = k })
    return max
  }, [availableDays])

  // Apply the day filter (when any days are selected) to each section.
  const filtered = useMemo(() => {
    if (selectedDays.size === 0) return sections
    return sections.map((s) => ({
      ...s,
      articles: s.articles.filter((a) => selectedDays.has(dayKey(a.date))),
    }))
  }, [sections, selectedDays])

  // Collapsed sections (by name) and a user-defined display order. `order` is
  // reconciled whenever the underlying section set changes: existing positions
  // are kept, new sections are appended, removed ones drop out.
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [order, setOrder] = useState([])
  const [dragName, setDragName] = useState(null)

  useEffect(() => {
    setOrder((prev) => {
      const names = sections.map((s) => s.name)
      const kept = prev.filter((n) => names.includes(n))
      const added = names.filter((n) => !kept.includes(n))
      const next = [...kept, ...added]
      const same = next.length === prev.length && next.every((n, i) => n === prev[i])
      return same ? prev : next
    })
  }, [sections])

  // Sections in the user's chosen order (falling back to data order).
  const orderedSections = useMemo(() => {
    if (order.length === 0) return filtered
    const byName = new Map(filtered.map((s) => [s.name, s]))
    const out = order.map((n) => byName.get(n)).filter(Boolean)
    // Surface any section missing from `order` (e.g. mid-reconcile) at the end.
    filtered.forEach((s) => { if (!order.includes(s.name)) out.push(s) })
    return out
  }, [filtered, order])

  const toggleCollapse = (name) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })

  // Live reorder: while dragging, moving the dragged section over another swaps
  // it into that slot (handled on dragEnter so it fires once per crossing).
  const handleDragEnter = (overName) => {
    if (!dragName || dragName === overName) return
    setOrder((prev) => {
      const from = prev.indexOf(dragName)
      const to = prev.indexOf(overName)
      if (from === -1 || to === -1 || from === to) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(to, 0, dragName)
      return next
    })
  }

  // Persist the chosen section order to the project when a drag finishes.
  const persistOrder = useCallback((names) => {
    if (!project?.id || !names.length) return
    const prev = project.sections_orders || []
    const same = prev.length === names.length && prev.every((n, i) => n === names[i])
    if (same) return
    project.sections_orders = names // keep in-memory project in sync
    updateSectionsOrders(project.id, names, session?.id).catch((err) => {
      console.error('Failed to save section order:', err)
    })
  }, [project, session])

  const handleDragEnd = () => {
    setDragName(null)
    persistOrder(order)
  }

  // Move an article into another section: overlay it locally for instant feedback,
  // then persist to the charts + tagged files on S3.
  const moveArticle = useCallback((articleId, fromSection, toSection) => {
    if (articleId == null || fromSection === toSection) return
    const id = String(articleId)
    setArticleMoves((prev) => {
      const next = new Map(prev)
      next.set(id, toSection)
      return next
    })
    if (session?.id) {
      moveMediaMonitoringArticle(session.id, id, fromSection, toSection).catch((err) => {
        console.error('Failed to move article:', err)
      })
    }
  }, [session])

  // Total + per-sentiment counts across the (date-filtered) feed.
  const stats = useMemo(() => {
    const out = { total: 0, POS: 0, NEG: 0, NEU: 0 }
    filtered.forEach((s) => s.articles.forEach((a) => {
      out.total += 1
      if (a.sentiment in out) out[a.sentiment] += 1
    }))
    return out
  }, [filtered])

  const summary = chartsData?.[`${DASHBOARD_KEY}_overall_summary`] || ''
  const hasData = sections.length > 0

  // Dataset-wide hero stat tiles (not affected by the date filter).
  const totalAll = useMemo(
    () => sections.reduce((n, s) => n + s.articles.length, 0),
    [sections],
  )
  const heroStats = useMemo(() => {
    const daysAvailable = availableDays.size
    const avgPerDay = daysAvailable ? Math.round(totalAll / daysAvailable) : 0
    return [
      { n: nf(daysAvailable), l: 'Days available' },
      { n: nf(avgPerDay), l: 'Avg / day' },
      { n: nf(sections.length), l: 'Sections' },
    ]
  }, [availableDays, totalAll, sections])

  // Hero headline/sub differ for single-day vs range (or all-dates) selections.
  const hero = useMemo(() => {
    const { total, POS: pos, NEG: neg, NEU: neu } = stats
    if (!hasData || total === 0) {
      return {
        kicker: 'Daily Monitoring · No coverage in window',
        headLead: 'Pick a window.',
        headEm: 'Build the report.',
        sub: 'Select a day or range with coverage (marked with a dot) to assemble a monitoring report.',
      }
    }
    const posPct = Math.round((pos / total) * 100)
    if (selectedDays.size === 1) {
      const key = [...selectedDays][0]
      return {
        kicker: `Daily Monitoring · ${fmtDay(key)}`,
        headLead: `${weekday(key)}:`,
        headEm: `${pos} of ${total} articles ran positive.`,
        sub: `${pos} positive · ${neu} neutral · ${neg} negative across ${total} articles on ${fmtShort(key)}.`,
      }
    }
    const days = (selectedDays.size ? [...selectedDays] : [...availableDays]).sort()
    const nDays = days.length
    const windowLabel = selectedDays.size ? 'the selected window' : 'all dates'
    return {
      kicker: `Daily Monitoring · ${fmtShort(days[0])} – ${fmtShort(days[nDays - 1])} · ${nDays} days`,
      headLead: `${nf(total)} articles across ${nDays} days.`,
      headEm: `${posPct}% ran positive.`,
      sub: `${nf(pos)} positive · ${nf(neu)} neutral · ${nf(neg)} negative across ${windowLabel}.`,
    }
  }, [stats, selectedDays, availableDays, hasData])

  // KPI "report" card shown above the section list — its title/range reflect the
  // current selection (single day vs N-day range / all dates).
  const report = useMemo(() => {
    const { total, POS, NEG, NEU } = stats
    if (selectedDays.size === 1) {
      const key = [...selectedDays][0]
      return { title: weekday(key), sub: fmtShort(key), total, POS, NEG, NEU, range: false }
    }
    const days = (selectedDays.size ? [...selectedDays] : [...availableDays]).sort()
    const nDays = days.length
    return {
      title: `${nDays}-Day Report`,
      sub: nDays ? `${fmtShort(days[0])} → ${fmtShort(days[nDays - 1])}` : '',
      total, POS, NEG, NEU, range: true, nDays,
    }
  }, [stats, selectedDays, availableDays])

  const scrollToSection = (name) => {
    document.getElementById(slug(name))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <>
      <MonitoringHero
        kicker={hero.kicker}
        headLead={hero.headLead}
        headEm={hero.headEm}
        sub={hero.sub}
        stats={heroStats}
        onBack={onBack}
        onBackToReview={onBackToReview}
        downloads={downloads}
        downloadDisabled={stats.total === 0}
        downloadError={downloadError}
      />

      {chartsLoading ? (
        <div className="state">
          <span className="loader" />
          <p>Loading dashboard…</p>
        </div>
      ) : chartsError ? (
        <div className="state state--error">
          <p>{chartsError}</p>
        </div>
      ) : !hasData ? (
        <div className="state">
          <p>No section data available for this dashboard yet.</p>
        </div>
      ) : (
        <>
        {summary && (
          <section className="summary">
            <p className="summary__kicker">OVERALL SUMMARY</p>
            <p className="summary__body"><Rich text={summary} /></p>
          </section>
        )}

        <div className="mmlayout">
          {/* Left — calendar */}
          <aside className="mmlayout__side">
            <div className="panel mmcalpanel">
              <div className="mmcalpanel__head">
                <h3 className="mmcalpanel__title">Filter by date</h3>
                <button
                  className="linkbtn"
                  onClick={() => setSelectedDays(new Set())}
                  disabled={selectedDays.size === 0}
                >
                  All dates
                </button>
              </div>
              <MiniCalendar
                available={availableDays}
                selected={selectedDays}
                onToggle={toggleDay}
                initialMonth={latestDay}
              />
              <p className="mmcalpanel__hint">
                {availableDays.size} {availableDays.size === 1 ? 'day' : 'days'} with coverage.
                Pick one or more days to filter; click a selected day to remove it.
              </p>
            </div>

            <div className="panel mmnav">
              <h3 className="mmnav__title">Sections</h3>
              <ul className="mmnav__list">
                {orderedSections.map((section) => (
                  <li key={section.name}>
                    <button className="mmnav__item" onClick={() => scrollToSection(section.name)}>
                      <span className="mmnav__name">{section.name}</span>
                      <span className="mmnav__count">{section.articles.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          {/* Right — KPI report + section list */}
          <div className="mmlayout__main">
            <div className="mmreport">
              <div className="mmreport__head">
                <h2 className="mmreport__title">{report.title}</h2>
                {report.sub && <p className="mmreport__sub">{report.sub}</p>}
              </div>
              <div className="mmreport__kpis">
                <div className="mmreport__kpi">
                  <span className="mmreport__n">{nf(report.total)}</span>
                  <span className="mmreport__l">Articles</span>
                </div>
                <div className="mmreport__kpi">
                  <span className="mmreport__n" style={{ color: SENT.POS.color }}>{nf(report.POS)}</span>
                  <span className="mmreport__l">Positive</span>
                </div>
                <div className="mmreport__kpi">
                  <span className="mmreport__n" style={{ color: SENT.NEU.color }}>{nf(report.NEU)}</span>
                  <span className="mmreport__l">Neutral</span>
                </div>
                <div className="mmreport__kpi">
                  <span className="mmreport__n" style={{ color: SENT.NEG.color }}>{nf(report.NEG)}</span>
                  <span className="mmreport__l">Negative</span>
                </div>
              </div>
            </div>
            {report.range && report.total > 0 && (
              <p className="mmreport__agg">
                Aggregated coverage across {report.nDays} {report.nDays === 1 ? 'day' : 'days'}:{' '}
                {nf(report.total)} articles ({nf(report.POS)} positive · {nf(report.NEU)} neutral · {nf(report.NEG)} negative).
              </p>
            )}

            {orderedSections.map((section) => {
              const isCollapsed = collapsed.has(section.name)
              const isDragging = dragName === section.name
              const isDropTarget = articleDropTarget === section.name
              return (
              <section
                className={`panel mmsection${isCollapsed ? ' mmsection--collapsed' : ''}${isDragging ? ' mmsection--dragging' : ''}${isDropTarget ? ' mmsection--droptarget' : ''}`}
                key={section.name}
                id={slug(section.name)}
                onDragEnter={() => {
                  if (dragArticle) {
                    if (dragArticle.fromSection !== section.name) setArticleDropTarget(section.name)
                  } else {
                    handleDragEnter(section.name)
                  }
                }}
                onDragOver={(e) => { if (dragName || dragArticle) e.preventDefault() }}
                onDrop={() => {
                  if (dragArticle) {
                    moveArticle(dragArticle.id, dragArticle.fromSection, section.name)
                    setDragArticle(null)
                    setArticleDropTarget(null)
                  }
                }}
              >
                <header
                  className="mmsection__head"
                  draggable
                  onDragStart={(e) => { setDragName(section.name); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={handleDragEnd}
                >
                  <span className="mmsection__grip" title="Drag to reorder"><GripIcon /></span>
                  <button
                    type="button"
                    className="mmsection__toggle"
                    onClick={() => toggleCollapse(section.name)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? 'Expand section' : 'Collapse section'}
                  >
                    <ChevronDownIcon
                      width={16}
                      height={16}
                      style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s ease' }}
                    />
                    <h2 className="mmsection__title">{section.name}</h2>
                  </button>
                  <span className="mmsection__count">{section.articles.length}</span>
                </header>

                {isCollapsed ? null : section.articles.length === 0 ? (
                  <p className="muted mmsection__empty">
                    No articles{selectedDays.size > 0 ? ' on the selected dates' : ''}.
                  </p>
                ) : (
                  <ul className="mmfeed">
                    {section.articles.map((a, i) => {
                      const sent = SENT[a.sentiment] || { label: a.sentiment || '—', cls: 'sent--neu' }
                      return (
                        <li className="mmfeed__item" key={a.id ?? i}>
                          {a.id != null && (
                            <span
                              className="mmfeed__grip"
                              draggable
                              title="Drag to move to another section"
                              onDragStart={(e) => {
                                setDragArticle({ id: a.id, fromSection: section.name })
                                e.dataTransfer.effectAllowed = 'move'
                              }}
                              onDragEnd={() => { setDragArticle(null); setArticleDropTarget(null) }}
                            >
                              <GripIcon />
                            </span>
                          )}
                          <div className="mmfeed__main">
                            <p className="mmfeed__meta mmfeed__meta--top">
                              {a.domain || 'Unknown source'} · {fmtDay(dayKey(a.date)) || '—'}
                            </p>
                            <p className="mmfeed__title">
                              {a.url ? (
                                <a href={a.url} target="_blank" rel="noreferrer">{a.title || 'Untitled'}</a>
                              ) : (
                                a.title || 'Untitled'
                              )}
                            </p>
                            {(a.summary || a.content) && <p className="mmfeed__snippet">{a.summary || a.content}</p>}
                            {a.similar_articles && Object.keys(a.similar_articles).length > 0 && (
                              <p className="mmfeed__similar">
                                <span className="mmfeed__similar-label">Similar Articles:</span>{' '}
                                {Object.entries(a.similar_articles).map(([domain, url], idx) => (
                                  <Fragment key={domain}>
                                    {idx > 0 && ', '}
                                    {url ? (
                                      <a href={url} target="_blank" rel="noreferrer">{domain}</a>
                                    ) : (
                                      domain
                                    )}
                                  </Fragment>
                                ))}
                              </p>
                            )}
                            {(authorText(a.author) || (a.reach != null && a.reach !== '')) && (
                              <p className="mmfeed__meta mmfeed__meta--bottom">
                                {authorText(a.author) && <>By {authorText(a.author)}</>}
                                {authorText(a.author) && a.reach != null && a.reach !== '' && ' · '}
                                {a.reach != null && a.reach !== '' && <>reach {nf(a.reach)}</>}
                              </p>
                            )}
                          </div>
                          <div className="mmfeed__tags">
                            {a.priority && <span className="sent sent--neg">Priority</span>}
                            <span className={`sent ${sent.cls}`}>{sent.label}</span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
              )
            })}
          </div>
        </div>
        </>
      )}
    </>
  )
}

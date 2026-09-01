import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { listReportComparisons, updateMissingArticle } from '../api/sessions.js'
import { ArrowLeftIcon, ChevronDownIcon, SpreadsheetIcon } from '../components/Icons.jsx'

// Report-comparison history for a project: how much of each delivered report the
// tool had already collected, as a table plus two charts. Expanding a row shows
// the articles the tool missed and, separately, the ones it found but filed under
// a different section than the report did.
//
// Coverage % is computed here rather than stored — it is just found/report, and
// deriving it keeps the stored row to the raw counts the API returns.

const FOUND_COLOR = '#10b981'
const MISSING_COLOR = '#ef4444'
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Format the date's own YYYY-MM-DD part — never via `new Date()`, which parses
// day keys as UTC midnight and can shift the day in the viewer's timezone.
function fmtDate(d) {
  if (!d) return ''
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return String(d)
  return `${MONTH_ABBR[Number(m[2]) - 1] || m[2]} ${Number(m[3])}`
}

function pct(found, total) {
  if (!total) return 0
  return Math.round((found / total) * 100)
}

// Respect the OS "reduce motion" setting — chart entrance animations are
// decorative, so we disable them when the user asks for less motion.
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return undefined
    const onChange = (e) => setReduced(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

// Themed tooltip so both charts match the app surface in light and dark mode.
function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="ctip">
      <div className="ctip__label">{fmtDate(label) || label}</div>
      {payload.map((p, i) => (
        <div className="ctip__row" key={i}>
          <span className="ctip__swatch" style={{ background: p.color || p.fill || p.stroke }} />
          <span className="ctip__name">{p.name}</span>
          <span className="ctip__val">{p.value}{p.unit || ''}</span>
        </div>
      ))}
    </div>
  )
}

// The missing articles of one comparison: title, url, and the two editable cells
// (keywords, and why the tool didn't find the article).
//
// Each cell saves on blur (or Enter) and only when the text actually changed, so
// tabbing through the table doesn't fire a PUT per cell. `saved` marks the cells
// that were just written so the user gets confirmation without a toast. State is
// keyed `<articleId>:<field>` so the two cells of a row save independently.
function MissingArticlesTable({ articles, onSaved }) {
  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState({})
  const [saved, setSaved] = useState({})
  const [error, setError] = useState('')

  const keyOf = (m, field) => `${m.id}:${field}`
  const valueFor = (m, field) => {
    const draft = drafts[keyOf(m, field)]
    return draft !== undefined ? draft : m[field] || ''
  }
  const clearDraft = (key) =>
    setDrafts((d) => {
      const { [key]: _drop, ...rest } = d
      return rest
    })

  async function commit(m, field) {
    const key = keyOf(m, field)
    const next = valueFor(m, field).trim()
    if (next === (m[field] || '')) return
    setSaving((s) => ({ ...s, [key]: true }))
    setError('')
    try {
      const row = await updateMissingArticle(m.id, { [field]: next })
      onSaved(m.id, { [field]: row?.[field] ?? (next || null) })
      clearDraft(key)
      setSaved((s) => ({ ...s, [key]: true }))
      setTimeout(() => setSaved((s) => ({ ...s, [key]: false })), 1600)
    } catch (err) {
      setError(err.message || 'Failed to save.')
    } finally {
      setSaving((s) => ({ ...s, [key]: false }))
    }
  }

  function cell(m, field, placeholder) {
    const key = keyOf(m, field)
    return (
      <span className="misstbl__kw">
        <input
          className="field__input misstbl__input"
          placeholder={placeholder}
          value={valueFor(m, field)}
          disabled={!!saving[key]}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
          onBlur={() => commit(m, field)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              clearDraft(key)
              e.currentTarget.blur()
            }
          }}
        />
        {saving[key] && <span className="misstbl__hint">Saving…</span>}
        {!saving[key] && saved[key] && <span className="misstbl__hint misstbl__hint--ok">Saved</span>}
      </span>
    )
  }

  return (
    <div className="misstbl">
      <div className="misstbl__row misstbl__row--head">
        <span className="th">TITLE</span>
        <span className="th">URL</span>
        <span className="th">KEYWORDS</span>
        <span className="th">REASON NOT FOUND</span>
      </div>
      {articles.map((m) => (
        <div className="misstbl__row" key={m.id}>
          <span className="misstbl__title" title={m.title || ''}>{m.title || '—'}</span>
          <a className="misstbl__url" href={m.url} target="_blank" rel="noreferrer" title={m.url}>
            {m.url}
          </a>
          {cell(m, 'keywords', 'Add keywords…')}
          {cell(m, 'reason_for_not_found', 'Add reason…')}
        </div>
      ))}
      {error && <p className="form__error misstbl__err">{error}</p>}
    </div>
  )
}

// The articles the tool did find but filed under a different section than the
// delivered report did. Read-only — the fix belongs on the review screen, not here.
function SectionMismatchTable({ articles }) {
  return (
    <div className="misstbl">
      <div className="misstbl__row misstbl__row--head">
        <span className="th">TITLE</span>
        <span className="th">URL</span>
        <span className="th">AI SECTION</span>
        <span className="th">CORRECT SECTION</span>
      </div>
      {articles.map((m) => (
        <div className="misstbl__row" key={m.id}>
          <span className="misstbl__title" title={m.title || ''}>{m.title || '—'}</span>
          <a className="misstbl__url" href={m.url} target="_blank" rel="noreferrer" title={m.url}>
            {m.url}
          </a>
          <span className="misstbl__sect misstbl__sect--ai">{m.ai_section || '—'}</span>
          <span className="misstbl__sect">{m.correct_section || '—'}</span>
        </div>
      ))}
    </div>
  )
}

export default function ComparisonsScreen({ project, onBack }) {
  const reduced = usePrefersReducedMotion()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    listReportComparisons(project.id)
      .then((data) => {
        if (alive) setRows(Array.isArray(data) ? data : [])
      })
      .catch((err) => {
        if (alive) setError(err.message || 'Failed to load comparisons.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [project.id])

  const series = useMemo(
    () =>
      rows.map((r) => ({
        date: r.report_date,
        found: r.total_articles_found_in_tool,
        missing: r.total_report_articles - r.total_articles_found_in_tool,
        coverage: pct(r.total_articles_found_in_tool, r.total_report_articles),
      })),
    [rows],
  )

  // Totals across every comparison, so the header reads as one coverage figure.
  const totals = useMemo(() => {
    const report = rows.reduce((s, r) => s + r.total_report_articles, 0)
    const found = rows.reduce((s, r) => s + r.total_articles_found_in_tool, 0)
    const mismatched = rows.reduce((s, r) => s + (r.section_mismatches?.length || 0), 0)
    const irrelevant = rows.reduce((s, r) => s + (r.tagged_irrelevant || 0), 0)
    return {
      report,
      found,
      mismatched,
      irrelevant,
      missing: report - found,
      coverage: pct(found, report),
    }
  }, [rows])

  // Fold a saved field back into the loaded rows so collapsing and re-expanding
  // shows the new value without refetching the whole list.
  function applyArticlePatch(comparisonId, articleId, patch) {
    setRows((prev) =>
      prev.map((r) =>
        r.id !== comparisonId
          ? r
          : { ...r, missing: r.missing.map((m) => (m.id === articleId ? { ...m, ...patch } : m)) },
      ),
    )
  }

  function toggle(id) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <>
      <button className="backlink" onClick={onBack}>
        <ArrowLeftIcon width={18} height={18} /> {project.name}
      </button>

      <section className="subhead">
        <p className="subhead__kicker">REPORT COMPARISONS</p>
        <h1 className="subhead__title">Report coverage</h1>
        <p className="subhead__meta">
          {rows.length === 0
            ? 'How much of each delivered report the tool had already collected.'
            : `${rows.length} ${rows.length === 1 ? 'report' : 'reports'} compared · ${totals.found} of ${totals.report} articles found (${totals.coverage}%) · ${totals.mismatched} in the wrong section · ${totals.irrelevant} tagged irrelevant`}
        </p>
      </section>

      {loading && <div className="state">Loading comparisons…</div>}

      {!loading && error && (
        <div className="state state--error">
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="state">
          <SpreadsheetIcon width={26} height={26} />
          <p>No reports compared yet.</p>
          <p className="muted">
            Open a session's review screen and use <strong>Compare</strong> to upload a delivered report.
          </p>
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <div className="chartgrid cmpcharts">
            <div className="chartcard">
              <div className="chartcard__head">
                <h3 className="chartcard__title">Found vs not found</h3>
                <p className="chartcard__sub">Report articles per date, split by whether the tool has them.</p>
              </div>
              <div className="chartcard__body">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={series} margin={{ top: 8, right: 8, bottom: 4, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 12 }} stroke="var(--text-faint)" />
                    <YAxis tick={{ fontSize: 12 }} stroke="var(--text-faint)" allowDecimals={false} />
                    <Tooltip content={<ChartTip />} />
                    <Legend />
                    <Bar dataKey="found" name="Found in tool" stackId="a" fill={FOUND_COLOR} isAnimationActive={!reduced} />
                    <Bar dataKey="missing" name="Not found" stackId="a" fill={MISSING_COLOR} radius={[6, 6, 0, 0]} isAnimationActive={!reduced} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="chartcard">
              <div className="chartcard__head">
                <h3 className="chartcard__title">Coverage over time</h3>
                <p className="chartcard__sub">Share of each report the tool already had.</p>
              </div>
              <div className="chartcard__body">
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={series} margin={{ top: 8, right: 8, bottom: 4, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 12 }} stroke="var(--text-faint)" />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} stroke="var(--text-faint)" unit="%" />
                    <Tooltip content={<ChartTip />} />
                    <Line
                      type="monotone"
                      dataKey="coverage"
                      name="Coverage"
                      unit="%"
                      stroke="var(--accent)"
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                      isAnimationActive={!reduced}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <section className="panel">
            <div className="cmptbl">
              <div className="cmptbl__row cmptbl__row--head">
                <span className="th">REPORT DATE</span>
                <span className="th">IN REPORT</span>
                <span className="th">FOUND</span>
                <span className="th">NOT FOUND</span>
                <span className="th">WRONG SECTION</span>
                <span className="th">IRRELEVANT</span>
                <span className="th">COVERAGE</span>
                <span className="th">IN SESSION</span>
                <span className="th" />
              </div>
              {rows.map((r) => {
                const missing = r.total_report_articles - r.total_articles_found_in_tool
                const mismatches = r.section_mismatches || []
                const coverage = pct(r.total_articles_found_in_tool, r.total_report_articles)
                const open = expanded.has(r.id)
                return (
                  <div className="cmptbl__group" key={r.id}>
                    <div className="cmptbl__row">
                      <span className="cmptbl__date">{fmtDate(r.report_date)}</span>
                      <span>{r.total_report_articles}</span>
                      <span className="cmptbl__found">{r.total_articles_found_in_tool}</span>
                      <span className={missing ? 'cmptbl__miss' : undefined}>{missing}</span>
                      <span className={mismatches.length ? 'cmptbl__warn' : undefined}>
                        {mismatches.length}
                      </span>
                      <span className={r.tagged_irrelevant ? 'cmptbl__warn' : undefined}>
                        {r.tagged_irrelevant || 0}
                      </span>
                      <span>
                        <span className="cmpbar" title={`${coverage}%`}>
                          <span className="cmpbar__fill" style={{ width: `${coverage}%` }} />
                        </span>
                        <span className="cmptbl__pct">{coverage}%</span>
                      </span>
                      <span className="muted">{r.total_session_articles}</span>
                      <span>
                        {(missing > 0 || mismatches.length > 0) && (
                          <button className="btn btn--ghost btn--mini" onClick={() => toggle(r.id)}>
                            <ChevronDownIcon
                              width={14}
                              height={14}
                              style={{ transform: open ? 'rotate(180deg)' : 'none' }}
                            />
                            {open ? 'Hide' : `Show ${missing + mismatches.length}`}
                          </button>
                        )}
                      </span>
                    </div>
                    {open && missing > 0 && (
                      <MissingArticlesTable
                        articles={r.missing}
                        onSaved={(articleId, patch) => applyArticlePatch(r.id, articleId, patch)}
                      />
                    )}
                    {open && mismatches.length > 0 && (
                      <>
                        <p className="cmptbl__subhead">Found, but filed under a different section</p>
                        <SectionMismatchTable articles={mismatches} />
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
    </>
  )
}

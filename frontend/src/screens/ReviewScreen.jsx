import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { addTaggedArticles, approveTaggedArticles, deleteTaggedArticle, fetchArticleByUrl, tagManualArticle, getTaggedArticles, markArticlesRelevant, markArticlesIrrelevant, taggingWsUrl, updateTaggedArticles } from '../api/tagging.js'
import { chartsWsUrl } from '../api/charts.js'
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, CloseIcon, DashboardIcon, DownloadIcon, EditIcon, PlusIcon, RefreshIcon, SearchIcon, SpreadsheetIcon, TrashIcon } from '../components/Icons.jsx'
import DateRangePicker from '../components/DateRangePicker.jsx'
import DownloadArticlesModal from '../components/DownloadArticlesModal.jsx'
import CompareReportModal from '../components/CompareReportModal.jsx'
import { formatWindow, prettyFileName, sessionWindow } from '../utils/files.js'

const SENTIMENT = {
  POS: { label: 'Positive', cls: 'sent--pos' },
  NEG: { label: 'Negative', cls: 'sent--neg' },
  NEU: { label: 'Neutral', cls: 'sent--neu' },
}

// Per-field confidences — stored as 0–1 floats, edited/shown as 0–100 percents.
const CONFIDENCE_FIELDS = ['sentiment_confidence', 'theme_confidence', 'section_category_confidence', 'relevancy_confidence']

// Edits to these fields on a main article cascade to its syndicated copies
// (same story across domains → kept in sync). Mirrors the backend's
// `_SYNDICATION_CASCADE_FIELDS`, `similar_group_id` included: a copy has no grouping of
// its own, so re-grouping a main by hand has to move its copies with it.
const SYNDICATION_CASCADE_FIELDS = ['section', 'sentiment', 'theme', 'similar_group_id']

// A classification and its reason belong together: when the user edits any
// `triggers` field (the value and/or its confidence), the matching `reason`
// field must be updated too — otherwise the reason is stale. Enforced on save.
const REASON_GROUPS = [
  { label: 'Relevancy', triggers: ['relevancy_confidence'], reason: 'relevancy_reason', reasonLabel: 'Relevancy Reason' },
  { label: 'Section', triggers: ['section', 'section_category_confidence'], reason: 'section_reason', reasonLabel: 'Section Reason' },
  { label: 'Sentiment', triggers: ['sentiment', 'sentiment_confidence'], reason: 'xai_sentiment_reason', reasonLabel: 'Sentiment Reason' },
  { label: 'Theme', triggers: ['theme', 'theme_confidence'], reason: 'xai_theme_reason', reasonLabel: 'Theme Reason' },
]

// The tagged fields the review table lets you edit, keyed by article field name.
// `title`, `content`, `url` and `date` are body/metadata (not AI tags) but are
// editable in the table too; the three EDIT_FIELDS loops below skip them
// (see EXPLICIT_FIELDS) because they're handled explicitly (omit-if-empty +
// date-format conversion). Editing `title`/`content` makes the server re-tag the
// article, so those two are never sent alongside a hand-edited tag by accident —
// the user's own value wins server-side either way.
const EDIT_FIELDS = {
  title: { type: 'text' },
  // The article body. Only editable on a paywalled row, where it's the sentinel
  // "Subscription" — see the is_subscription cell in renderRow.
  content: { type: 'text' },
  url: { type: 'text' },
  date: { type: 'date' },
  domain_name: { type: 'text' },
  summary: { type: 'text' },
  relevancy_confidence: { type: 'number' },
  relevancy_reason: { type: 'text' },
  keyword_matched: { type: 'list' },
  sentiment: { type: 'select', options: ['POS', 'NEG', 'NEU'] },
  theme: { type: 'text' },
  sentiment_confidence: { type: 'number' },
  theme_confidence: { type: 'number' },
  xai_sentiment_reason: { type: 'text' },
  xai_theme_reason: { type: 'text' },
  section_category_confidence: { type: 'number' },
  brand_of_interest: { type: 'list' },
  competitors: { type: 'list' },
  priority_watch: { type: 'bool' },
  section: { type: 'text' },
  section_reason: { type: 'text' },
  peoples: { type: 'list' },
  countries: { type: 'list' },
  organizations: { type: 'list' },
  // Relation fields. `relation: true` keeps them out of the Add-by-URL form and gates
  // editing behind `relationEditable`. Editing one moves the article in the grouped view.
  // `syndication_of` holds the parent (main) article's id; `similar_group_id` holds the
  // uuid of the story group — paste another article's to merge them into one story, or
  // clear it to leave (the server mints a fresh group rather than un-grouping the row).
  syndication_of: { type: 'text', relation: true },
  similar_group_id: { type: 'text', relation: true },
}

// EDIT_FIELDS entries the add-article forms set explicitly, so their loops over
// EDIT_FIELDS must skip them.
const EXPLICIT_FIELDS = new Set(['title', 'content', 'url', 'date'])

function list(val) {
  if (Array.isArray(val)) return val.filter(Boolean)
  if (val == null || val === '') return []
  return [val]
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Display the stored date/time exactly as saved — the article's own wall-clock
// time and timezone offset, never converted to the viewer's browser timezone
// (e.g. "Jul 22, 2026, 22:19 UTC" or "… UTC+05:30"). A pure date renders as a
// calendar date; a value that doesn't look like ISO is shown raw.
function fmtDate(d) {
  if (!d) return '—'
  const s = String(d).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/)
  if (!m) return s
  const [, y, mo, day, hh, mm, off] = m
  const datePart = `${MONTH_ABBR[Number(mo) - 1] || mo} ${Number(day)}, ${y}`
  if (!hh) return datePart
  const tz = !off ? '' : (off === 'Z' || /^[+-]00:?00$/.test(off)) ? ' UTC' : ` UTC${off}`
  return `${datePart}, ${hh}:${mm}${tz}`
}

// Normalize any date value to a YYYY-MM-DD key for range comparison.
function dayKey(d) {
  if (!d) return ''
  const s = String(d)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const dt = new Date(s)
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10)
}

const FILTER_INIT = {
  id: '', title: '', subscription: '', summary: '', domain: '', url: '', dateFrom: '', dateTo: '',
  relConfOp: '>=', relConfVal: '', relevancy_reason: '', keyword_matched: '',
  section: '', section_reason: '', author: '',
  sentiment: '', theme: '',
  sentiment_reason: '', theme_reason: '',
  secConfOp: '>=', secConfVal: '',
  sentConfOp: '>=', sentConfVal: '',
  themeConfOp: '>=', themeConfVal: '',
  brand_of_interest: '', competitors: '', priority: '',
  peoples: '', countries: '', organizations: '', addedType: '',
}

// Filter keys that hold an operator (not a value) — ignored by "filters active".
const FILTER_OP_KEYS = new Set(['secConfOp', 'sentConfOp', 'themeConfOp', 'relConfOp'])

// Does an article's confidence (0–1) pass a "op value%" filter? Empty value = pass.
function confPass(val, op, raw) {
  if (raw === '' || raw == null) return true
  const num = parseFloat(raw)
  if (Number.isNaN(num)) return true
  if (typeof val !== 'number') return false
  const cp = val * 100
  if (op === '<=') return cp <= num
  if (op === '=') return Math.round(cp) === Math.round(num)
  return cp >= num // default '>='
}

// Author may be a string or a list of names; join for display/filtering.
function authorText(author) {
  if (Array.isArray(author)) return author.filter(Boolean).join(', ')
  return author ? String(author).trim() : ''
}

// Starting values for an "add article" row (editor representations).
const newRow = (key) => ({ _key: key, title: '', content: '', date: '', sentiment: 'NEU', priority_watch: false })

// The editor's working value for a field: the draft if present, else the
// article's value coerced to the editor's representation (CSV for lists).
function editorValue(article, drafts, field, type) {
  const dv = drafts?.[field]
  if (dv !== undefined) return dv
  if (type === 'list') return list(article[field]).join(', ')
  if (type === 'bool') return !!article[field]
  // Dates are stored as canonical ISO but edited as a datetime-local value.
  if (type === 'date') return toDateTimeLocal(article[field])
  // Confidences are stored as 0–1 floats but edited as 0–100 percents.
  if (CONFIDENCE_FIELDS.includes(field)) return typeof article[field] === 'number' ? Math.round(article[field] * 100) : ''
  return article[field] ?? ''
}

// Coerce an editor value back to the API shape for the given field type.
function coerce(type, v) {
  if (type === 'list') return String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (type === 'number') {
    const n = parseFloat(v)
    return Number.isNaN(n) ? null : n
  }
  if (type === 'bool') return !!v
  return String(v ?? '').trim()
}

// Original value in API shape, so we can diff drafts against it.
function originalValue(article, field, type) {
  if (type === 'list') return list(article[field])
  if (type === 'bool') return !!article[field]
  // Compare against the datetime-local form of the stored date, so an untouched
  // date isn't flagged as changed just because its ISO string looks different.
  if (type === 'date') return toDateTimeLocal(article[field])
  if (type === 'number') {
    if (typeof article[field] !== 'number') return null
    // Compare against the percent shown in the editor (confidences stored 0–1).
    return CONFIDENCE_FIELDS.includes(field) ? Math.round(article[field] * 100) : article[field]
  }
  return article[field] ?? ''
}

function sameValue(type, a, b) {
  if (type === 'list') return JSON.stringify(a) === JSON.stringify(b)
  return a === b
}

function CellEditor({ field, type, value, onChange, options = null, placeholder = '' }) {
  if (type === 'select') {
    const base = options || EDIT_FIELDS[field].options
    const current = value ?? ''
    // An off-list current value stays selectable so opening the editor can't lose it.
    const opts = current && !base.includes(current) ? [current, ...base] : base
    return (
      <select className="ecell" value={current} onChange={(e) => onChange(e.target.value)}>
        {options && <option value="">—</option>}
        {opts.map((o) => (
          <option key={o} value={o}>{options ? o : (SENTIMENT[o]?.label || o)}</option>
        ))}
      </select>
    )
  }
  if (type === 'bool') {
    return (
      <input type="checkbox" className="ecell__check" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
    )
  }
  if (type === 'date') {
    // Calendar + clock picker; its `YYYY-MM-DDTHH:MM` value is normalized to
    // canonical ISO (UTC) by the backend on save.
    return (
      <input className="ecell" type="datetime-local" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    )
  }
  if (type === 'number') {
    // Confidence is edited as a 0–100 percent; the API converts it to a 0–1 float.
    return (
      <input
        className="ecell ecell--num"
        type="number"
        min="0"
        max="100"
        step="1"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <input
      className="ecell"
      value={value ?? ''}
      placeholder={placeholder || (type === 'list' ? 'comma, separated' : '')}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

// A checkbox that can render the tri-state "indeterminate" look (set via DOM ref).
function TriCheckbox({ checked, indeterminate = false, onChange, ariaLabel }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="rtbl__check"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
    />
  )
}

function ListCell({ value }) {
  const items = list(value)
  if (items.length === 0) return <span className="muted">—</span>
  const joined = items.join(', ')
  return <span className="clamp" title={joined}>{joined}</span>
}

// Title/content: clamped by default; click to toggle the full text inline.
// Hovering still shows the native tooltip while collapsed.
function ExpandableCell({ text }) {
  const [open, setOpen] = useState(false)
  const value = text || '—'
  return (
    <span
      role="button"
      tabIndex={0}
      className={open ? 'xcell xcell--open' : 'xcell clamp'}
      title={open ? undefined : value}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen((o) => !o)
        }
      }}
    >
      {value}
    </span>
  )
}

// Subscription flag, shown where the body text used to be — the list endpoint omits
// the body, so this is all the review table gets about it. Only the paywalled case is
// called out (red); a fetched body needs no badge.
function SubscriptionCell({ value }) {
  if (!value) return <span className="muted">—</span>
  return <span className="subpill" title="The article body couldn't be fetched (paywalled / subscription-only)">Subscription</span>
}

// Tag fields shown (in order) in the "Add by URL" modal, after the body fields.
const URL_TAG_FIELDS = [
  ['summary', 'Summary'],
  ['relevancy_confidence', 'Relevancy Confidence'],
  ['relevancy_reason', 'Relevancy Reason'],
  ['section', 'Section'],
  ['section_category_confidence', 'Section Confidence'],
  ['section_reason', 'Section Reason'],
  ['brand_of_interest', 'Brand of interest'],
  ['sentiment', 'Sentiment'],
  ['sentiment_confidence', 'Sentiment Confidence'],
  ['xai_sentiment_reason', 'Sentiment Reason'],
  ['theme', 'Theme'],
  ['theme_confidence', 'Theme Confidence'],
  ['xai_theme_reason', 'Theme Reason'],
  ['competitors', 'Competitors'],
  ['priority_watch', 'Priority watch'],
  ['peoples', 'People'],
  ['countries', 'Countries'],
  ['organizations', 'Organizations'],
]

// A stored date value (canonical ISO, e.g. "2026-06-11T20:23:37.000+00:00") →
// the `YYYY-MM-DDTHH:MM` string a <input type="datetime-local"> expects. The
// stored wall-clock is shown as-is (no timezone conversion), matching the
// display cell, and a round-trip is stable. Returns "" when the value is empty
// or unparseable so the picker starts blank.
function toDateTimeLocal(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  if (m) return `${m[1]}T${m[2]}`
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

// A fetched+tagged article → the modal's editable form representation (lists as
// CSV, confidences as 0–100 percents — matching the inline add-row editors).
function articleToForm(a) {
  const f = {
    title: a.title || '',
    content: a.content || '',
    url: a.url || '',
    // datetime-local format; the backend normalizes it back to canonical ISO.
    date: toDateTimeLocal(a.date),
    author: authorText(a.author),
  }
  for (const [field, cfg] of Object.entries(EDIT_FIELDS)) {
    if (cfg.relation) continue
    if (EXPLICIT_FIELDS.has(field)) continue // set explicitly above
    if (cfg.type === 'list') f[field] = list(a[field]).join(', ')
    else if (cfg.type === 'bool') f[field] = !!a[field]
    else if (cfg.type === 'number') f[field] = typeof a[field] === 'number' ? a[field] : (a[field] ?? '')
    else f[field] = a[field] ?? ''
  }
  return f
}

// Build the add-article payload from the modal form (one article). Confidences
// stay 0–100 here; the API converts them to 0–1 floats on save.
function formToPayload(form) {
  const title = String(form.title || '').trim()
  const content = String(form.content || '').trim()
  const payload = { title, content }
  const date = String(form.date || '').trim()
  const url = String(form.url || '').trim()
  const author = String(form.author || '').trim()
  if (date) payload.date = date
  if (url) payload.url = url
  if (author) payload.author = author
  for (const [field, cfg] of Object.entries(EDIT_FIELDS)) {
    if (cfg.relation) continue
    if (EXPLICIT_FIELDS.has(field)) continue // set explicitly above
    const v = coerce(cfg.type, form[field])
    if (cfg.type === 'list' && (!v || v.length === 0)) continue
    payload[field] = v
  }
  return payload
}

// Modal: paste a URL → fetch + AI-tag the article → review/edit every field →
// Save appends it to the tagged file. Paywalled URLs surface a subscription error.
function AddByUrlModal({ sessionId, onClose, onSaved }) {
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState('')
  const [form, setForm] = useState(null) // null until an article is fetched
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  // Manual entry: when a URL can't be fetched, we reveal blank body fields for
  // the user to fill in, then AI-tag those directly. `manual` = in manual mode;
  // `manualTagged` = the manual article has been tagged and is ready to save.
  const [manual, setManual] = useState(false)
  const [manualTagged, setManualTagged] = useState(false)
  const [tagging, setTagging] = useState(false)

  const setField = (field, value) => setForm((f) => ({ ...f, [field]: value }))
  const hasBody = !!(form && (String(form.title || '').trim() || String(form.content || '').trim()))
  // Show the AI tag fields once we have them (a normal fetch, or after a manual tag).
  const showTagFields = !!form && (!manual || manualTagged)

  const doFetch = async () => {
    const u = url.trim()
    if (!u || fetching) return
    setFetching(true)
    setFetchErr('')
    setForm(null)
    setManual(false)
    setManualTagged(false)
    setSaveErr('')
    try {
      const article = await fetchArticleByUrl(sessionId, u)
      setForm(articleToForm(article))
    } catch (err) {
      // Couldn't fetch (e.g. paywalled). Fall back to manual entry: show blank
      // body fields (URL prefilled) so the user can fill them in and tag manually.
      setFetchErr(err.message || 'Failed to fetch the article.')
      setForm(articleToForm({ url: u }))
      setManual(true)
    } finally {
      setFetching(false)
    }
  }

  // Tag the manually-entered body fields (no URL fetch), then show the tags.
  const doTag = async () => {
    if (!form || tagging) return
    if (!hasBody) {
      setSaveErr('Add a title or content before tagging.')
      return
    }
    setTagging(true)
    setSaveErr('')
    try {
      const preview = await tagManualArticle(sessionId, {
        title: String(form.title || '').trim(),
        content: String(form.content || '').trim(),
        url: String(form.url || '').trim(),
        date: String(form.date || '').trim(),
        author: String(form.author || '').trim(),
      })
      setForm(articleToForm(preview))
      setManualTagged(true)
    } catch (err) {
      setSaveErr(err.message || 'Failed to tag the article.')
    } finally {
      setTagging(false)
    }
  }

  const doSave = async () => {
    if (!form || saving) return
    const payload = formToPayload(form)
    if (!payload.title && !payload.content) {
      setSaveErr('The article needs a title or content.')
      return
    }
    setSaving(true)
    setSaveErr('')
    try {
      const created = await addTaggedArticles(sessionId, [payload])
      onSaved(Array.isArray(created) ? created : [created])
    } catch (err) {
      setSaveErr(err.message || 'Failed to add the article.')
    } finally {
      setSaving(false)
    }
  }

  const tagField = (field, label) => {
    const cfg = EDIT_FIELDS[field]
    return (
      <label className="field" key={field}>
        <span className="field__label">{label}</span>
        {cfg.type === 'bool' ? (
          <input type="checkbox" checked={!!form[field]} onChange={(e) => setField(field, e.target.checked)} />
        ) : cfg.type === 'select' ? (
          <select className="field__input" value={form[field] ?? ''} onChange={(e) => setField(field, e.target.value)}>
            {cfg.options.map((o) => <option key={o} value={o}>{SENTIMENT[o]?.label || o}</option>)}
          </select>
        ) : cfg.type === 'number' ? (
          <input className="field__input" type="number" min="0" max="100" step="1" value={form[field] ?? ''} onChange={(e) => setField(field, e.target.value)} />
        ) : (
          <input className="field__input" value={form[field] ?? ''} placeholder={cfg.type === 'list' ? 'comma, separated' : ''} onChange={(e) => setField(field, e.target.value)} />
        )}
      </label>
    )
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal modal--url" role="dialog" aria-modal="true" aria-labelledby="url-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="url-title" className="modal__title">Add article by URL</h2>
        <p className="modal__sub">Paste an article URL — we’ll fetch it and AI-tag every field for you to review.</p>

        <div className="urlfetch">
          <input
            className="field__input"
            placeholder="https://example.com/news/article"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doFetch() } }}
            disabled={fetching}
          />
          <button className="btn btn--primary" onClick={doFetch} disabled={fetching || !url.trim()}>
            {fetching ? 'Fetching…' : form ? 'Re-fetch' : 'Fetch'}
          </button>
        </div>
        {fetchErr && <div className="savenote savenote--err">{fetchErr}</div>}
        {manual && !manualTagged && (
          <div className="savenote savenote--hint">
            Couldn’t fetch this article automatically. Fill in the details below, then click “Tag article” to AI-tag it.
          </div>
        )}

        {form && (
          <>
            <div className="urlform">
              <label className="field urlform__full">
                <span className="field__label">Title</span>
                <input className="field__input" value={form.title} onChange={(e) => setField('title', e.target.value)} />
              </label>
              <label className="field urlform__full">
                <span className="field__label">Content</span>
                <textarea className="field__input" rows={4} value={form.content} onChange={(e) => setField('content', e.target.value)} />
              </label>
              <label className="field urlform__full">
                <span className="field__label">URL</span>
                <input className="field__input" value={form.url} onChange={(e) => setField('url', e.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Date</span>
                <input className="field__input" type="datetime-local" value={form.date} onChange={(e) => setField('date', e.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Author</span>
                <input className="field__input" value={form.author} onChange={(e) => setField('author', e.target.value)} />
              </label>
              {showTagFields && URL_TAG_FIELDS.map(([field, label]) => tagField(field, label))}
            </div>
            {saveErr && <div className="savenote savenote--err">{saveErr}</div>}
          </>
        )}

        <div className="form__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving || fetching || tagging}>Cancel</button>
          {manual && !manualTagged ? (
            <button type="button" className="btn btn--primary" onClick={doTag} disabled={tagging || !hasBody}>
              {tagging ? 'Tagging…' : 'Tag article'}
            </button>
          ) : (
            <>
              {manual && manualTagged && (
                <button type="button" className="btn btn--ghost" onClick={doTag} disabled={tagging || saving || !hasBody}>
                  {tagging ? 'Tagging…' : 'Re-tag'}
                </button>
              )}
              <button type="button" className="btn btn--primary" onClick={doSave} disabled={!form || saving || fetching || tagging}>
                {saving ? 'Saving…' : 'Save article'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const IDLE_JOB = {
  kind: null, // 'tagging' | 'charts'
  active: false,
  phase: 'idle', // idle | connecting | running | complete | error
  messages: [],
  progress: { done: 0, total: 0 },
  totalArticles: 0,
  errorMsg: '',
}

// Column keys in render order (the checkbox column is always shown and not
// listed here). `columns` prop, when given, restricts the table to a subset.
export const ALL_COL_KEYS = [
  'status', 'id', 'title', 'is_subscription', 'summary', 'domain', 'url', 'date', 'keyword_matched', 'relevancy_confidence', 'relevancy_reason',
  'section', 'section_confidence', 'section_reason',
  'brand', 'sentiment', 'sentiment_confidence', 'sentiment_reason', 'theme', 'theme_confidence', 'theme_reason',
  'competitors', 'author', 'priority', 'people', 'countries', 'organizations',
  'syndication', 'similar', 'added_type', 'mark_relevant', 'mark_irrelevant',
]

// Header labels + default widths (px) per column. Widths seed the resizable
// <colgroup>; users drag the header border to override (persisted in state).
const COLUMN_LABELS = {
  status: 'Status', id: 'ID', title: 'Title', is_subscription: 'Subscription', summary: 'Summary', domain: 'Publication', url: 'URL', date: 'Date',
  relevancy_confidence: 'Relevancy Confidence', relevancy_reason: 'Relevancy Reason', keyword_matched: 'Keyword Matched',
  section: 'Section', section_confidence: 'Section Confidence', section_reason: 'Section Reason',
  brand: 'Brand of interest', sentiment: 'Sentiment', sentiment_confidence: 'Sentiment Confidence',
  sentiment_reason: 'Sentiment Reason', theme: 'Theme', theme_confidence: 'Theme Confidence',
  theme_reason: 'Theme Reason', competitors: 'Competitors', author: 'Author', priority: 'Priority',
  people: 'People', countries: 'Countries', organizations: 'Organizations',
  syndication: 'Syndication of', similar: 'Story group', added_type: 'Added Type',
  mark_relevant: 'Action', mark_irrelevant: 'Action',
}
const DEFAULT_COL_WIDTHS = {
  status: 124, id: 96, title: 240, is_subscription: 130, summary: 300, domain: 160, url: 170, date: 150,
  relevancy_confidence: 140, relevancy_reason: 300, keyword_matched: 180, section: 150, section_confidence: 140, section_reason: 260,
  brand: 160, sentiment: 120, sentiment_confidence: 150, sentiment_reason: 260,
  theme: 160, theme_confidence: 140, theme_reason: 260, competitors: 170, author: 160,
  priority: 110, people: 160, countries: 150, organizations: 170,
  // `similar` holds a uuid, so it needs more room than the A{n} ref it replaced.
  syndication: 140, similar: 200, added_type: 130, mark_relevant: 160, mark_irrelevant: 160,
}
const CHECKCOL_WIDTH = 38
const MIN_COL_WIDTH = 60

// Column sets for the two review contexts. Monitoring gets the trimmed set with
// the relation columns; Dashboards gets the full set minus Section / Section
// Confidence. Shared by the Review popups (WorkflowScreen) and the main review
// screen's two tabs.
export const MONITORING_COLUMNS = [
  'status', 'id', 'title', 'is_subscription', 'summary', 'domain', 'url', 'date', 'relevancy_confidence', 'relevancy_reason', 'keyword_matched',
  'section', 'section_confidence', 'section_reason', 'author', 'syndication', 'similar', 'added_type', 'mark_irrelevant',
]
// Dashboards: full set minus the Section columns and the Irrelevant-tab-only
// promote action. `mark_irrelevant` (the per-row demote action) is kept.
export const DASHBOARD_COLUMNS = ALL_COL_KEYS.filter(
  (k) => !['section', 'section_confidence', 'section_reason', 'mark_relevant'].includes(k),
)

// Columns for the read-only Irrelevant tab (subset of ALL_COL_KEYS). Irrelevant
// articles are pre-tagging, so they carry only body/metadata fields plus the
// not-relevant reason and the fetch-time keyword match — none of the AI tag
// columns. Reuses the same table as the other tabs (resize, filters, expand,
// sticky columns, scroll sync).
export const IRRELEVANT_COLUMNS = [
  'id', 'title', 'is_subscription', 'domain', 'url', 'date', 'keyword_matched', 'relevancy_confidence', 'relevancy_reason', 'mark_relevant',
]

export default function ReviewScreen({ project, session, runTagging = false, nameHint = null, onBack, onCreated, asModal = false, onClose, columns = null, relationEditable = false, approvalField = 'is_approved', tabbed = false }) {
  // Tabbed mode (the main review screen): two tabs that switch the visible
  // columns + approval flag — "Monitoring Data" (Media Monitoring popup columns,
  // monitoring approval) and "Dashboards Data" (other-dashboard columns).
  const [activeTab, setActiveTab] = useState('monitoring') // 'monitoring' | 'dashboards' | 'irrelevant'
  // The read-only Irrelevant tab shows the pre-tagging articles the relevancy
  // agent filtered out, in the SAME table (its own column set + dataset).
  const showIrrelevant = tabbed && activeTab === 'irrelevant'
  const effColumns = tabbed
    ? (activeTab === 'irrelevant' ? IRRELEVANT_COLUMNS : activeTab === 'monitoring' ? MONITORING_COLUMNS : DASHBOARD_COLUMNS)
    : columns
  const effApprovalField = tabbed ? (activeTab === 'monitoring' ? 'is_approved_for_monitoring' : 'is_approved') : approvalField
  const effRelationEditable = tabbed && !showIrrelevant ? activeTab === 'monitoring' : (tabbed ? false : relationEditable)

  // Which tagged-file flag this review's approvals read/write. Media Monitoring
  // uses `is_approved_for_monitoring`; every other review uses `is_approved`.
  const forMonitoring = effApprovalField === 'is_approved_for_monitoring'
  // Column visibility: `effColumns` (array of keys) restricts the table; null = all.
  const visibleCols = effColumns ? new Set(effColumns) : null
  const show = useCallback((key) => !visibleCols || visibleCols.has(key), [effColumns]) // eslint-disable-line react-hooks/exhaustive-deps
  const groupColSpan = (visibleCols ? ALL_COL_KEYS.filter((k) => visibleCols.has(k)).length : ALL_COL_KEYS.length) + 1
  const [articles, setArticles] = useState([])
  const [loading, setLoading] = useState(!runTagging)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  // The tagged file now holds BOTH relevant and irrelevant articles (the latter
  // with is_relevant === false + blank tags), so both tabs derive from `articles`
  // — no separate fetch. `markingIds` = the ids currently being promoted to
  // relevant (one row, or a bulk selection).
  const [markingIds, setMarkingIds] = useState(() => new Set())

  // Inline tag editing. `drafts` holds per-article, per-field editor values
  // keyed by article id: { [id]: { [field]: editorValue } }.
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveNote, setSaveNote] = useState('')
  const [editWarn, setEditWarn] = useState('') // inline validation notice while editing (doesn't hide the table)

  // Per-column filters (plus the global search box).
  const [filters, setFilters] = useState(FILTER_INIT)

  // Section names saved on the project (project.sections_orders) — used as the
  // Section column's edit dropdown. Empty list → the editor stays free text.
  const sectionOptions = useMemo(() => (
    Array.isArray(project?.sections_orders)
      ? project.sections_orders.map((s) => String(s).trim()).filter(Boolean)
      : []
  ), [project])

  // Row selection (checkbox column). Keyed by article id. Always starts blank —
  // it is what the Approve/Disapprove buttons act on, not the approval state itself
  // (that lives on the article and is shown in the Status column).
  const [selected, setSelected] = useState(() => new Set())
  const [approving, setApproving] = useState(false)

  // Table view: 'flat' (every article in a row) or 'grouped' (main article with
  // its similar + syndicated children nested beneath it). `rawViewMode` is the
  // user's choice; the Irrelevant tab is always flat (see `viewMode` below), and
  // reading it through a derived value keeps that choice intact for the other
  // tabs instead of resetting it on every visit.
  const [rawViewMode, setViewMode] = useState('grouped')
  const viewMode = showIrrelevant ? 'flat' : rawViewMode
  // Expanded sub-groups in grouped view, keyed by `${mainId}:similar|syndicated`.
  // Sections are collapsed by default — a key is present only once expanded.
  const [expanded, setExpanded] = useState(() => new Set())
  const toggleCollapse = useCallback((key) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])
  // Monitoring tab only: an extra outer grouping by `section`. Section headers are
  // expanded by default, so a key present in this set means that section is
  // COLLAPSED (inverse of `expanded` above).
  const [collapsedSections, setCollapsedSections] = useState(() => new Set())
  const toggleSection = useCallback((name) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }, [])

  // Adding brand-new articles via editable rows at the bottom of the table.
  // `newRows` holds one draft object per pending row (empty = not adding).
  const [newRows, setNewRows] = useState([])
  const [addSaving, setAddSaving] = useState(false)
  const rowKeyRef = useRef(0)
  const adding = newRows.length > 0

  // "Add by URL" modal — fetch + AI-tag a single article, then review & save it.
  const [urlModalOpen, setUrlModalOpen] = useState(false)

  // Excel download popup — picks the relevance buckets and columns to export.
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const onUrlSaved = useCallback((created) => {
    setArticles((prev) => [...prev, ...created])
    setUrlModalOpen(false)
    const n = created.length
    setSaveNote(`Added ${n} article${n === 1 ? '' : 's'}. Dashboards will rebuild on next Create Dashboard.`)
  }, [])

  // A single WebSocket "job" — tagging or charts — surfaced inline (no modal).
  // Only one runs at a time, so they share one progress panel.
  const [job, setJob] = useState(() =>
    runTagging ? { ...IDLE_JOB, kind: 'tagging', active: true, phase: 'connecting' } : IDLE_JOB,
  )
  const wsRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await getTaggedArticles(session.id)
      const list = Array.isArray(data) ? data : []
      setArticles(list)
      // The checkbox is a plain selection, not the approval state — start blank.
      // Saved approval is shown in the Status column instead.
      setSelected(new Set())
    } catch (err) {
      setError(err.message || 'Failed to load tagged articles.')
    } finally {
      setLoading(false)
    }
  }, [session.id])

  // Generic runner shared by both sockets. `onDone(msg)` fires on "complete".
  const runJob = useCallback(
    (kind, url, onDone) => {
      try {
        wsRef.current?.close()
      } catch {
        /* already closed */
      }

      setError('')
      setJob({ ...IDLE_JOB, kind, active: true, phase: 'connecting' })

      const push = (text) => setJob((j) => ({ ...j, messages: [...j.messages, text] }))
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setJob((j) => ({ ...j, phase: 'running' }))
        push(kind === 'charts' ? 'Connected — building dashboards…' : 'Connected — starting tagging…')
        // name_hint (tagging only) names the fetched raw file after the query;
        // the charts WS simply ignores the extra field.
        ws.send(JSON.stringify({ session_id: session.id, name_hint: nameHint || undefined }))
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
            setJob((j) => ({ ...j, totalArticles: msg.total_articles || 0 }))
            push(
              kind === 'charts'
                ? `Crunching ${msg.total_articles} articles across ${(msg.dashboards || []).length} dashboards…`
                : `Tagging ${msg.total_articles} articles…`,
            )
            break
          case 'batch': // tagging only
            setJob((j) => ({
              ...j,
              progress: { done: msg.completed_batches || 0, total: msg.total_batches || 0 },
            }))
            push(
              `Batch ${(msg.batch_index ?? 0) + 1} done — ${msg.completed_batches}/${msg.total_batches} batches (${msg.tagged_count} tagged)`,
            )
            break
          case 'progress': // stage messages (tagging + charts)
            push(msg.message || `Working on ${msg.stage}…`)
            break
          case 'fetch_progress': {
            // Live fetched-article counter — rewrite the counter line in place
            // (20 → 40 → 52…) instead of appending a log line per update.
            const line = `Fetching articles… ${msg.fetched} fetched`
            setJob((j) => {
              const messages = [...j.messages]
              const last = messages[messages.length - 1]
              if (typeof last === 'string' && /^Fetching articles… \d+ fetched$/.test(last)) {
                messages[messages.length - 1] = line
              } else {
                messages.push(line)
              }
              return { ...j, messages }
            })
            break
          }
          case 'complete':
            setJob((j) => ({
              ...j,
              phase: 'complete',
              progress: { done: j.progress.total || j.progress.done, total: j.progress.total || j.progress.done },
            }))
            push(
              kind === 'charts'
                ? `Dashboards ready${msg.elapsed_seconds ? ` in ${msg.elapsed_seconds}s` : ''}.`
                : `Completed ${msg.total_tagged} articles in ${msg.elapsed_seconds}s.`,
            )
            onDone?.(msg)
            break
          case 'error':
            setJob((j) => ({ ...j, phase: 'error', errorMsg: msg.detail || 'Something went wrong.' }))
            push(`Error: ${msg.detail}`)
            break
          default:
            break
        }
      }

      ws.onerror = () => {
        setJob((j) =>
          j.phase === 'complete'
            ? j
            : { ...j, phase: 'error', errorMsg: j.errorMsg || 'Connection error — is the backend running?' },
        )
      }
    },
    [session.id, nameHint],
  )

  const startTagging = useCallback(() => {
    runJob('tagging', taggingWsUrl(), () => load())
  }, [runJob, load])

  const startCharts = useCallback(() => {
    runJob('charts', chartsWsUrl(), (msg) => onCreated?.(msg.charts_data))
  }, [runJob, onCreated])

  // On mount: either kick off tagging (Generate dashboards) or just load tags.
  useEffect(() => {
    if (runTagging) startTagging()
    else load()
    return () => {
      try {
        wsRef.current?.close()
      } catch {
        /* already closed */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Toggle body class for page-specific styling (e.g. animated colorful background)
  useEffect(() => {
    document.body.classList.add('review-page-active')
    return () => {
      document.body.classList.remove('review-page-active')
    }
  }, [])


  // The tagged file holds both relevant and irrelevant articles; split them by
  // the is_relevant flag (missing → relevant, for older files). The Irrelevant
  // tab shows the excluded ones; every other tab shows the relevant set.
  const relevantArticles = useMemo(() => articles.filter((a) => a.is_relevant !== false), [articles])
  // Highest relevancy score first — the near-misses worth promoting float to the
  // top. A missing score (nothing judged the article) sorts last, not as a 0.
  const irrelevantArticles = useMemo(() => {
    const score = (a) => (typeof a.relevancy_confidence === 'number' ? a.relevancy_confidence : -1)
    return articles.filter((a) => a.is_relevant === false).sort((a, b) => score(b) - score(a))
  }, [articles])
  const dataset = showIrrelevant ? irrelevantArticles : relevantArticles

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const f = filters
    const textIncl = (val, term) => !term || String(val ?? '').toLowerCase().includes(term.toLowerCase())
    const listIncl = (val, term) => !term || list(val).join(', ').toLowerCase().includes(term.toLowerCase())

    return dataset.filter((a) => {
      if (q) {
        // No body text here — the list endpoint omits it, so search covers the
        // title, the tags and the reasons.
        const hay = [a.id, a.title, a.theme, a.section, a.section_reason, a.relevancy_reason, a.domain_name, authorText(a.author), ...list(a.keyword_matched), ...list(a.brand_of_interest), ...list(a.competitors)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      // Text / list contains.
      if (!textIncl(a.id, f.id)) return false
      if (!textIncl(a.title, f.title)) return false
      if (!textIncl(a.summary, f.summary)) return false
      if (!textIncl(a.domain_name, f.domain)) return false
      if (!textIncl(a.url, f.url)) return false
      if (!textIncl(a.theme, f.theme)) return false
      if (!textIncl(a.section, f.section)) return false
      if (!textIncl(a.section_reason, f.section_reason)) return false
      if (!textIncl(a.relevancy_reason, f.relevancy_reason)) return false
      if (!listIncl(a.keyword_matched, f.keyword_matched)) return false
      if (!textIncl(a.xai_sentiment_reason, f.sentiment_reason)) return false
      if (!textIncl(a.xai_theme_reason, f.theme_reason)) return false
      // Per-field confidence ranges (0–100 scale).
      if (!confPass(a.relevancy_confidence, f.relConfOp, f.relConfVal)) return false
      if (!confPass(a.section_category_confidence, f.secConfOp, f.secConfVal)) return false
      if (!confPass(a.sentiment_confidence, f.sentConfOp, f.sentConfVal)) return false
      if (!confPass(a.theme_confidence, f.themeConfOp, f.themeConfVal)) return false
      if (!textIncl(authorText(a.author), f.author)) return false
      if (!listIncl(a.brand_of_interest, f.brand_of_interest)) return false
      if (!listIncl(a.competitors, f.competitors)) return false
      if (!listIncl(a.peoples, f.peoples)) return false
      if (!listIncl(a.countries, f.countries)) return false
      if (!listIncl(a.organizations, f.organizations)) return false
      // Exact / boolean.
      if (f.sentiment && a.sentiment !== f.sentiment) return false
      if (f.subscription === 'yes' && !a.is_subscription) return false
      if (f.subscription === 'no' && a.is_subscription) return false
      if (f.priority === 'watch' && !a.priority_watch) return false
      if (f.priority === 'no' && a.priority_watch) return false
      if (f.addedType === 'manual' && (a.added_type || '') !== 'Manual') return false
      if (f.addedType === 'auto' && (a.added_type || '') === 'Manual') return false
      // Date range (inclusive).
      if (f.dateFrom || f.dateTo) {
        const dk = dayKey(a.date)
        if (!dk) return false
        if (f.dateFrom && dk < f.dateFrom) return false
        if (f.dateTo && dk > f.dateTo) return false
      }
      return true
    })
  }, [dataset, query, filters])

  const setDraft = useCallback((id, field, value) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }))
  }, [])

  // Selection derived from the currently-visible (filtered) rows.
  const selectedCount = rows.reduce((n, r) => (selected.has(r.id) ? n + 1 : n), 0)
  const allVisibleSelected = rows.length > 0 && selectedCount === rows.length
  const someVisibleSelected = selectedCount > 0 && !allVisibleSelected

  // Selected irrelevant rows → ids to bulk-promote to relevant (Irrelevant tab).
  const selectedToMove = useMemo(
    () => (showIrrelevant ? irrelevantArticles.filter((a) => selected.has(a.id)).map((a) => a.id) : []),
    [showIrrelevant, irrelevantArticles, selected],
  )

  // The articles currently carrying this tab's approval flag.
  const approvedIds = useMemo(
    () => new Set(articles.filter((a) => a[effApprovalField]).map((a) => a.id)),
    [articles, effApprovalField],
  )
  // Both actions act on the SELECTION only: approve the ticked rows that aren't
  // approved yet, disapprove the ticked rows that are.
  const toApprove = useMemo(() => [...selected].filter((id) => !approvedIds.has(id)), [selected, approvedIds])
  const toDisapprove = useMemo(() => [...selected].filter((id) => approvedIds.has(id)), [selected, approvedIds])
  const approvedCount = approvedIds.size

  // Per-tab approved counts (independent of the active tab) — the single Create
  // Dashboard button gates on both, and warns when only one tab has approvals.
  const monApprovedCount = useMemo(
    () => articles.filter((a) => a.is_approved_for_monitoring).length,
    [articles],
  )
  const dashApprovedCount = useMemo(
    () => articles.filter((a) => a.is_approved).length,
    [articles],
  )

  // Switch tabs with a blank selection: each tab has its own approval flag and
  // its own rows, so carrying ticks across would apply an action to the wrong set.
  const switchTab = useCallback((tab) => {
    if (tab === activeTab) return
    setActiveTab(tab)
    setSelected(new Set())
  }, [activeTab])

  // Promote one or more irrelevant articles to relevant: the backend AI-tags them
  // and flips is_relevant, then we patch them into `articles` so they leave the
  // Irrelevant tab and show up (fully tagged) on the relevant tabs.
  const markRelevant = useCallback(async (ids) => {
    const list = [...new Set((ids || []).filter(Boolean))]
    if (list.length === 0 || markingIds.size > 0) return
    setMarkingIds(new Set(list))
    setError('')
    setSaveNote('')
    try {
      const updated = await markArticlesRelevant(session.id, list)
      const byId = new Map((updated || []).map((u) => [u.id, u]))
      setArticles((prev) => prev.map((a) => (byId.has(a.id) ? { ...a, ...byId.get(a.id) } : a)))
      // Drop the moved ids from the selection (they're no longer on this tab).
      setSelected((prev) => {
        const next = new Set(prev)
        list.forEach((id) => next.delete(id))
        return next
      })
      const n = (updated || []).length
      setSaveNote(`Moved ${n} article${n === 1 ? '' : 's'} to relevant and tagged ${n === 1 ? 'it' : 'them'}. Dashboards will rebuild on next Create Dashboard.`)
    } catch (err) {
      setError(err.message || 'Failed to move to relevant.')
    } finally {
      setMarkingIds(new Set())
    }
  }, [session.id, markingIds])

  // Demote relevant articles to irrelevant. A reason is REQUIRED, collected via a
  // popup; tags are kept (only is_relevant flips). `irrIds` holds the ids the open
  // modal will act on (the selection captured when the modal opened).
  const [irrModalOpen, setIrrModalOpen] = useState(false)
  const [irrReason, setIrrReason] = useState('')
  const [irrIds, setIrrIds] = useState([])
  const [movingIrr, setMovingIrr] = useState(false)
  const [irrErr, setIrrErr] = useState('')

  const openMoveIrrelevant = useCallback((ids) => {
    const list = [...new Set((ids || []).filter(Boolean))]
    if (list.length === 0) return
    setIrrIds(list)
    setIrrReason('')
    setIrrErr('')
    setIrrModalOpen(true)
  }, [])

  const confirmMoveIrrelevant = useCallback(async () => {
    const reason = irrReason.trim()
    if (!reason) { setIrrErr('A reason is required.'); return }
    if (irrIds.length === 0 || movingIrr) return
    setMovingIrr(true)
    setIrrErr('')
    try {
      const updated = await markArticlesIrrelevant(session.id, irrIds, reason)
      const byId = new Map((updated || []).map((u) => [u.id, u]))
      setArticles((prev) => prev.map((a) => (byId.has(a.id) ? { ...a, ...byId.get(a.id) } : a)))
      // The moved ids leave the relevant tabs → drop them from the selection.
      setSelected((prev) => {
        const next = new Set(prev)
        irrIds.forEach((id) => next.delete(id))
        return next
      })
      setIrrModalOpen(false)
      const n = (updated || []).length
      setSaveNote(`Moved ${n} article${n === 1 ? '' : 's'} to irrelevant. Dashboards will rebuild on next Create Dashboard.`)
    } catch (err) {
      setIrrErr(err.message || 'Failed to move to irrelevant.')
    } finally {
      setMovingIrr(false)
    }
  }, [irrReason, irrIds, movingIrr, session.id])

  // Create Dashboard gating across both tabs. Disabled only when neither tab has
  // approvals. When exactly one tab is missing approvals, warn before building.
  const anyApproved = tabbed ? (monApprovedCount > 0 || dashApprovedCount > 0) : approvedCount > 0
  const missingTab =
    monApprovedCount === 0 ? 'Monitoring Data' : dashApprovedCount === 0 ? 'Dashboards Data' : null
  const [confirmCreate, setConfirmCreate] = useState(false)
  const handleCreateDashboard = useCallback(() => {
    if (tabbed && missingTab) setConfirmCreate(true)
    else startCharts()
  }, [tabbed, missingTab, startCharts])

  // Ids that pass the active filters/search (rows is already filtered).
  const matchIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows])

  // Grouped view: one row per story, its similar and syndicated children nested
  // beneath. Membership comes from `similar_group_id` — the uuid every telling of one
  // story shares — not from a pointer at the story's "main" article. That is what keeps a
  // story whole when the session's date window excludes the article the group started
  // from: there is no main to be missing, so the earliest member present leads instead.
  //
  // Filters apply per-row: a group is shown when its main or any child matches; only
  // matching children are listed.
  const groups = useMemo(() => {
    const dk = (a) => `${a.date || '9999'}|${a.id}`
    const byDate = (x, y) => (dk(x) < dk(y) ? -1 : dk(x) > dk(y) ? 1 : 0)

    // Syndicated copies nest under their own main, so they never lead a group even when
    // they are the earliest thing present.
    const synKids = new Map()
    for (const a of dataset) {
      if (!a.syndication_of) continue
      if (!synKids.has(a.syndication_of)) synKids.set(a.syndication_of, [])
      synKids.get(a.syndication_of).push(a)
    }

    // Bucket the non-copies by story. A row with no group id (one predating the grouping
    // backfill) gets a bucket of its own, keyed so it can't collide with a real uuid.
    const stories = new Map()
    for (const a of dataset) {
      if (a.syndication_of) continue
      const key = a.similar_group_id || ` ungrouped:${a.id}`
      if (!stories.has(key)) stories.set(key, [])
      stories.get(key).push(a)
    }

    const out = []
    const seen = new Set()
    for (const members of stories.values()) {
      const ordered = [...members].sort(byDate)
      const [m, ...rest] = ordered
      const allSyn = synKids.get(m.id) || []
      seen.add(m.id)
      rest.forEach((a) => seen.add(a.id))
      allSyn.forEach((a) => seen.add(a.id))

      const similar = rest.filter((a) => matchIds.has(a.id))
      const syndicated = allSyn.filter((a) => matchIds.has(a.id)).sort(byDate)
      // Skip the whole group when nothing in it matches the filters.
      if (!matchIds.has(m.id) && similar.length === 0 && syndicated.length === 0) continue
      out.push({ main: m, similar, syndicated })
    }
    out.sort((x, y) => byDate(x.main, y.main))

    // Safety net: surface any matching orphan not placed above — a syndicated copy whose
    // main isn't in the window, so nothing nested it.
    for (const a of dataset) {
      if (!seen.has(a.id) && matchIds.has(a.id)) out.push({ main: a, similar: [], syndicated: [] })
    }
    return out
  }, [dataset, matchIds])

  // Monitoring tab: an extra outer layer that buckets the grouped rows by the
  // main article's `section`, preserving group order (mains are date-sorted).
  // Empty/missing sections fall into an "Unsectioned" bucket rendered last.
  const sectionGrouped = tabbed && activeTab === 'monitoring' && viewMode === 'grouped'
  const sectionGroups = useMemo(() => {
    if (!sectionGrouped) return []
    const order = []
    const bySection = new Map()
    for (const g of groups) {
      const name = String(g.main.section || '').trim() || 'Unsectioned'
      if (!bySection.has(name)) {
        bySection.set(name, [])
        order.push(name)
      }
      bySection.get(name).push(g)
    }
    // "Unsectioned" always sorts to the end.
    order.sort((a, b) => (a === 'Unsectioned' ? 1 : b === 'Unsectioned' ? -1 : 0))
    return order.map((name) => {
      const secGroups = bySection.get(name)
      const count = secGroups.reduce((n, g) => n + 1 + g.similar.length + g.syndicated.length, 0)
      return { section: name, groups: secGroups, count }
    })
  }, [sectionGrouped, groups])

  // Collapse / expand every section header in one click.
  const allSectionsCollapsed = sectionGroups.length > 0 && sectionGroups.every((s) => collapsedSections.has(s.section))
  const toggleAllSections = useCallback(() => {
    setCollapsedSections((prev) => (
      sectionGroups.every((s) => prev.has(s.section))
        ? new Set()
        : new Set(sectionGroups.map((s) => s.section))
    ))
  }, [sectionGroups])

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      const everyVisible = rows.length > 0 && rows.every((r) => next.has(r.id))
      if (everyVisible) rows.forEach((r) => next.delete(r.id))
      else rows.forEach((r) => next.add(r.id))
      return next
    })
  }, [rows])

  // Persist an approval change for a set of ids (approve = true, disapprove = false).
  const applyApproval = useCallback(async (ids, isApproved) => {
    if (!ids.length) return
    setApproving(true)
    setError('')
    try {
      await approveTaggedArticles(session.id, ids, isApproved, forMonitoring)
      const idSet = new Set(ids)
      // Approving for monitoring approves for the dashboards too (the server does the
      // same), so reflect both here — otherwise the Dashboard tab shows the article as
      // unapproved until the page is reloaded. Disapproving does not cascade.
      const patch = forMonitoring && isApproved
        ? { is_approved_for_monitoring: true, is_approved: true }
        : { [effApprovalField]: isApproved }
      setArticles((prev) => prev.map((a) => (idSet.has(a.id) ? { ...a, ...patch } : a)))
      const verb = isApproved ? 'Approved' : 'Disapproved'
      setSaveNote(`${verb} ${ids.length} article${ids.length === 1 ? '' : 's'}.`)
    } catch (err) {
      setError(err.message || 'Failed to update approval.')
    } finally {
      setApproving(false)
    }
  }, [session.id, effApprovalField, forMonitoring])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setDrafts({})
    setEditWarn('')
  }, [])

  // Diff drafts against the originals → array of { id, ...changedFields }.
  const buildUpdates = useCallback(() => {
    const updates = []
    for (const [id, fields] of Object.entries(drafts)) {
      const article = articles.find((a) => String(a.id) === String(id))
      if (!article) continue
      const changed = {}
      for (const [field, raw] of Object.entries(fields)) {
        const cfg = EDIT_FIELDS[field]
        if (!cfg) continue
        const next = coerce(cfg.type, raw)
        if (!sameValue(cfg.type, next, originalValue(article, field, cfg.type))) {
          changed[field] = next
        }
      }
      if (Object.keys(changed).length) updates.push({ id: article.id, ...changed })
    }
    return updates
  }, [drafts, articles])

  const saveEdits = useCallback(async () => {
    const updates = buildUpdates()
    if (updates.length === 0) {
      cancelEdit()
      return
    }
    // A changed classification must come with an updated reason — the reason
    // explains the value, so leaving it stale is not allowed.
    const missing = []
    for (const u of updates) {
      const changed = new Set(Object.keys(u).filter((k) => k !== 'id'))
      for (const g of REASON_GROUPS) {
        if (g.triggers.some((t) => changed.has(t)) && !changed.has(g.reason)) {
          missing.push(`${u.id}: ${g.reasonLabel}`)
        }
      }
    }
    if (missing.length) {
      setEditWarn(`Please also update the reason for what you changed — ${missing.join('; ')}.`)
      return
    }
    setEditWarn('')
    setSaving(true)
    setSaveNote('')
    setError('')
    try {
      const res = await updateTaggedArticles(session.id, updates)
      // Articles whose title/content changed were re-tagged server-side, so their
      // new tags can't be derived from what we sent — take the server's version whole.
      const retagged = new Map((res?.retagged || []).map((a) => [String(a.id), a]))
      // Apply locally so the table reflects the saved tags without a refetch.
      // section/sentiment/theme edits on a main article cascade to its syndicated
      // copies (mirrors the backend) so the table stays consistent immediately.
      setArticles((prev) =>
        prev.map((a) => {
          const fresh = retagged.get(String(a.id))
          if (fresh) return { ...a, ...fresh }
          const u = updates.find((x) => String(x.id) === String(a.id))
          if (u) {
            const { id: _id, ...fields } = u
            // The API stores confidences as 0–1 floats; mirror that locally (sent as 0–100).
            CONFIDENCE_FIELDS.forEach((cf) => {
              if (typeof fields[cf] === 'number') fields[cf] = fields[cf] / 100
            })
            return { ...a, ...fields }
          }
          // Syndicated child: inherit the cascaded fields from its main's update.
          if (a.syndication_of) {
            const mainUpd = updates.find((x) => String(x.id) === String(a.syndication_of))
            if (mainUpd) {
              const cascade = {}
              SYNDICATION_CASCADE_FIELDS.forEach((f) => {
                if (f in mainUpd) cascade[f] = mainUpd[f]
              })
              if (Object.keys(cascade).length) return { ...a, ...cascade }
            }
          }
          return a
        }),
      )
      setDrafts({})
      setEditing(false)
      const retag = retagged.size ? ` Re-tagged ${retagged.size} with an edited body.` : ''
      setSaveNote(`Saved ${updates.length} article${updates.length === 1 ? '' : 's'}.${retag} Dashboards will rebuild on next Create Dashboard.`)
    } catch (err) {
      setError(err.message || 'Failed to save tag edits.')
    } finally {
      setSaving(false)
    }
  }, [buildUpdates, cancelEdit, session.id])

  const dirtyCount = Object.keys(drafts).length
  // A body edit makes the server re-run the tagger, which takes far longer than a
  // plain field patch — worth saying so instead of a bare "Saving…".
  const bodyEdited = Object.values(drafts).some((f) => 'title' in f || 'content' in f)

  const setRowField = useCallback((key, field, value) => {
    setNewRows((rows) => rows.map((r) => (r._key === key ? { ...r, [field]: value } : r)))
  }, [])
  const startAdd = useCallback(() => {
    setSaveNote('')
    rowKeyRef.current += 1
    setNewRows([newRow(rowKeyRef.current)])
  }, [])
  const addAnotherRow = useCallback(() => {
    rowKeyRef.current += 1
    setNewRows((rows) => [...rows, newRow(rowKeyRef.current)])
  }, [])
  const removeRow = useCallback((key) => {
    setNewRows((rows) => rows.filter((r) => r._key !== key))
  }, [])
  const cancelAdd = useCallback(() => setNewRows([]), [])

  const deleteArticle = useCallback(async (article) => {
    if (!window.confirm('Delete this manually-added article?')) return
    const prev = articles
    // Optimistic removal; restore on failure.
    setArticles((list) => list.filter((a) => a.id !== article.id))
    setSelected((sel) => {
      const next = new Set(sel)
      next.delete(article.id)
      return next
    })
    try {
      await deleteTaggedArticle(session.id, article.id)
      setSaveNote('Article deleted. Dashboards will rebuild on next Create Dashboard.')
    } catch (err) {
      setArticles(prev)
      setError(err.message || 'Failed to delete article.')
    }
  }, [articles, session.id])

  // Drafts → API payloads. Empty rows (no title and no content) are dropped;
  // empty lists / blank url & date are omitted so optional fields stay unset.
  const buildNewArticles = useCallback(() => {
    const out = []
    for (const row of newRows) {
      const title = String(row.title || '').trim()
      const content = String(row.content || '').trim()
      if (!title && !content) continue
      const payload = { title, content }
      const date = String(row.date || '').trim()
      const url = String(row.url || '').trim()
      const author = String(row.author || '').trim()
      if (date) payload.date = date
      if (url) payload.url = url
      if (author) payload.author = author
      for (const [field, cfg] of Object.entries(EDIT_FIELDS)) {
        if (EXPLICIT_FIELDS.has(field)) continue // set explicitly above
        const v = coerce(cfg.type, row[field])
        if (cfg.type === 'list' && (!v || v.length === 0)) continue
        payload[field] = v
      }
      out.push(payload)
    }
    return out
  }, [newRows])

  const saveNewArticles = useCallback(async () => {
    const payloads = buildNewArticles()
    if (payloads.length === 0) {
      setError('Add a title or content to at least one new article.')
      return
    }
    setAddSaving(true)
    setError('')
    try {
      const created = await addTaggedArticles(session.id, payloads)
      setArticles((prev) => [...prev, ...(Array.isArray(created) ? created : [created])])
      setNewRows([])
      const n = Array.isArray(created) ? created.length : 1
      setSaveNote(`Added ${n} article${n === 1 ? '' : 's'}. Dashboards will rebuild on next Create Dashboard.`)
    } catch (err) {
      setError(err.message || 'Failed to add articles.')
    } finally {
      setAddSaving(false)
    }
  }, [buildNewArticles, session.id])

  // An editor cell for an "add article" row (tag fields reuse CellEditor).
  const newCell = (row, field) => {
    const cfg = EDIT_FIELDS[field]
    const value = cfg.type === 'bool' ? !!row[field] : (row[field] ?? '')
    const opts = field === 'section' && sectionOptions.length ? sectionOptions : null
    return <CellEditor field={field} type={opts ? 'select' : cfg.type} options={opts} value={value} onChange={(v) => setRowField(row._key, field, v)} />
  }

  // A confidence range filter (operator + percent) for a column's filter cell.
  const confFilter = (opKey, valKey) => (
    <div className="fcell__range">
      <select className="fcell fcell--op" value={filters[opKey]} onChange={(e) => setFilter(opKey, e.target.value)}>
        <option value=">=">≥</option>
        <option value="<=">≤</option>
        <option value="=">=</option>
      </select>
      <input className="fcell fcell--num" type="number" min="0" max="100" placeholder="%" value={filters[valKey]} onChange={(e) => setFilter(valKey, e.target.value)} />
    </div>
  )

  // One article row — shared by the flat and grouped views. `rowClass` adds
  // grouping styles (e.g. indented child rows) without touching the columns.
  const renderRow = (a, i, rowClass = '') => {
    const sent = SENTIMENT[a.sentiment] || { label: a.sentiment || '—', cls: 'sent--neu' }
    const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—')
    const d = drafts[a.id]
    const ed = (field, display, placeholder = '') => {
      // The Irrelevant tab is always read-only, even if an edit was in progress
      // on another tab when the user switched.
      if (!editing || showIrrelevant) return display
      const cfg = EDIT_FIELDS[field]
      // Relation fields (syndication_of / similar_group_id) are only editable where the
      // caller opts in (the Media Monitoring popup); elsewhere they stay read-only.
      if (cfg.relation && !effRelationEditable) return display
      // Section is picked from the project's saved section list when one exists.
      const opts = field === 'section' && sectionOptions.length ? sectionOptions : null
      return (
        <CellEditor
          field={field}
          type={opts ? 'select' : cfg.type}
          options={opts}
          placeholder={placeholder}
          value={editorValue(a, d, field, cfg.type)}
          onChange={(v) => setDraft(a.id, field, v)}
        />
      )
    }
    const isSel = selected.has(a.id)
    const cls = ['', d ? 'rtbl__row--dirty' : '', isSel ? 'rtbl__row--sel' : '', rowClass]
      .filter(Boolean).join(' ').trim()
    return (
      <tr key={a.id ?? i} className={cls || undefined}>
        <td className="rtbl__checkcol">
          <TriCheckbox checked={isSel} onChange={() => toggleSelect(a.id)} ariaLabel={`Select ${a.id}`} />
        </td>
        {show('status') && (
          <td className="cell--status">
            {a[effApprovalField]
              ? <span className="apstat apstat--yes">Approved</span>
              : <span className="apstat apstat--no">Disapproved</span>}
          </td>
        )}
        {show('id') && <td className="cell--id">{a.id ?? '—'}</td>}
        {show('title') && <td className="cell--title">{ed('title', <ExpandableCell text={a.title} />)}</td>}
        {/* The Subscription column doubles as the body editor, but only on a
            paywalled row: that's the one case where there is no body and typing
            one in is useful. Anywhere else the body is already there (the list
            endpoint just doesn't ship it) and an empty editor would wipe it. */}
        {show('is_subscription') && (
          <td className="cell--sub">
            {a.is_subscription
              ? ed('content', <SubscriptionCell value={a.is_subscription} />, 'Paste the article body…')
              : <SubscriptionCell value={a.is_subscription} />}
          </td>
        )}
        {show('summary') && <td className="cell--content">{ed('summary', <ExpandableCell text={a.summary} />)}</td>}
        {show('domain') && (
          <td className="cell--domain">
            {ed('domain_name', <span className="clamp" title={a.domain_name || ''}>{a.domain_name || '—'}</span>)}
          </td>
        )}
        {show('url') && (
          <td className="cell--url">
            {ed('url', a.url ? (
              <a className="clamp" href={a.url} target="_blank" rel="noreferrer" title={a.url}>{a.url}</a>
            ) : (
              <span className="muted">—</span>
            ))}
          </td>
        )}
        {show('date') && <td className="cell--date">{ed('date', fmtDate(a.date))}</td>}
        {show('keyword_matched') && <td>{ed('keyword_matched', <ListCell value={a.keyword_matched} />)}</td>}
        {show('relevancy_confidence') && <td>{ed('relevancy_confidence', pct(a.relevancy_confidence))}</td>}
        {show('relevancy_reason') && <td className="cell--reason">{ed('relevancy_reason', <ExpandableCell text={a.relevancy_reason} />)}</td>}
        {show('section') && <td>{ed('section', <span className="clamp" title={a.section || ''}>{a.section || '—'}</span>)}</td>}
        {show('section_confidence') && <td>{ed('section_category_confidence', pct(a.section_category_confidence))}</td>}
        {show('section_reason') && <td className="cell--reason">{ed('section_reason', <ExpandableCell text={a.section_reason} />)}</td>}
        {show('brand') && <td>{ed('brand_of_interest', <ListCell value={a.brand_of_interest} />)}</td>}
        {show('sentiment') && <td>{ed('sentiment', (
          <span
            className={`sent ${sent.cls}`}
            title={a.xai_sentiment_reason || undefined}
            style={a.xai_sentiment_reason ? { cursor: 'help' } : undefined}
          >
            {sent.label}
          </span>
        ))}</td>}
        {show('sentiment_confidence') && <td>{ed('sentiment_confidence', pct(a.sentiment_confidence))}</td>}
        {show('sentiment_reason') && <td className="cell--reason">{ed('xai_sentiment_reason', <ExpandableCell text={a.xai_sentiment_reason} />)}</td>}
        {show('theme') && <td>{ed('theme', (
          <span
            className="clamp"
            title={a.xai_theme_reason || a.theme || ''}
            style={a.xai_theme_reason ? { cursor: 'help' } : undefined}
          >
            {a.theme || '—'}
          </span>
        ))}</td>}
        {show('theme_confidence') && <td>{ed('theme_confidence', pct(a.theme_confidence))}</td>}
        {show('theme_reason') && <td className="cell--reason">{ed('xai_theme_reason', <ExpandableCell text={a.xai_theme_reason} />)}</td>}
        {show('competitors') && <td>{ed('competitors', <ListCell value={a.competitors} />)}</td>}
        {show('author') && (
          <td className="cell--author">
            <span className="clamp" title={authorText(a.author) || ''}>{authorText(a.author) || '—'}</span>
          </td>
        )}
        {show('priority') && (
          <td>
            {ed(
              'priority_watch',
              a.priority_watch ? <span className="sent sent--neg">Watch</span> : <span className="muted">No</span>,
            )}
          </td>
        )}
        {show('people') && <td>{ed('peoples', <ListCell value={a.peoples} />)}</td>}
        {show('countries') && <td>{ed('countries', <ListCell value={a.countries} />)}</td>}
        {show('organizations') && <td>{ed('organizations', <ListCell value={a.organizations} />)}</td>}
        {show('syndication') && (
          <td className="cell--rel">
            {ed('syndication_of', a.syndication_of ? <span className="badge badge--rel">{a.syndication_of}</span> : <span className="muted">—</span>)}
          </td>
        )}
        {show('similar') && (
          <td className="cell--rel">
            {ed('similar_group_id', a.similar_group_id ? (
              // A uuid is too wide for the cell — show its leading segment and put the
              // full value in the tooltip, which is what a reviewer copies to merge two
              // stories. The editor (above) still holds the whole thing.
              <span className="badge badge--rel" title={a.similar_group_id}>{String(a.similar_group_id).slice(0, 8)}</span>
            ) : <span className="muted">—</span>)}
          </td>
        )}
        {show('added_type') && (
          <td className="cell--added">
            {a.added_type === 'Manual' ? (
              <div className="addedcell">
                <span className="badge badge--manual">Manual</span>
                <button
                  className="iconaction iconaction--danger"
                  aria-label="Delete article"
                  title="Delete this manually-added article"
                  onClick={() => deleteArticle(a)}
                >
                  <TrashIcon width={16} height={16} />
                </button>
              </div>
            ) : (
              <span className="muted">—</span>
            )}
          </td>
        )}
        {show('mark_relevant') && (
          <td className="cell--added">
            <button
              className="linkbtn"
              onClick={() => markRelevant([a.id])}
              disabled={markingIds.size > 0}
              title="AI-tag this article and move it to the relevant set"
            >
              {markingIds.has(a.id) ? 'Tagging…' : 'Move to relevant'}
            </button>
          </td>
        )}
        {show('mark_irrelevant') && (
          <td className="cell--added">
            <button
              className="linkbtn"
              onClick={() => openMoveIrrelevant([a.id])}
              disabled={movingIrr}
              title="Move this article to irrelevant (keeps its tags; asks for a reason)"
            >
              Move to irrelevant
            </button>
          </td>
        )}
      </tr>
    )
  }

  // A collapsible sub-group (Similar / Syndicated) under a main article.
  const renderSection = (main, kind, items, label) => {
    if (!items.length) return null
    const key = `${main.id}:${kind}`
    const isCollapsed = !expanded.has(key)
    return (
      <Fragment key={key}>
        <tr className="rtbl__grouplabel">
          <td colSpan={groupColSpan}>
            <button className="rtbl__grouptoggle" onClick={() => toggleCollapse(key)} aria-expanded={!isCollapsed}>
              <ChevronDownIcon width={14} height={14} style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none' }} />
              {label} ({items.length})
            </button>
          </td>
        </tr>
        {!isCollapsed && items.map((c) => renderRow(c, 0, 'rtbl__row--child'))}
      </Fragment>
    )
  }

  const setFilter = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])
  const clearFilters = useCallback(() => {
    setFilters(FILTER_INIT)
    setQuery('')
  }, [])
  const filtersActive =
    query.trim() !== '' || Object.entries(filters).some(([k, v]) => !FILTER_OP_KEYS.has(k) && v !== '')

  // A second horizontal scrollbar above the table, kept in sync with the real one.
  const topScrollRef = useRef(null)
  const bottomScrollRef = useRef(null)
  const tableRef = useRef(null)
  const headRowRef = useRef(null)
  const syncingRef = useRef(false)
  const [tableWidth, setTableWidth] = useState(0)
  const [headH, setHeadH] = useState(0) // height of the title row → filter row sticky offset

  // Per-column widths (px), overriding DEFAULT_COL_WIDTHS. Drag a header's right
  // border to resize; the <colgroup> below applies the widths to every row.
  const [colWidths, setColWidths] = useState({})
  const colW = useCallback((key) => colWidths[key] ?? DEFAULT_COL_WIDTHS[key] ?? 140, [colWidths])
  const startResize = useCallback((key, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colWidths[key] ?? DEFAULT_COL_WIDTHS[key] ?? 140
    const onMove = (ev) => {
      const next = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX))
      setColWidths((w) => ({ ...w, [key]: next }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [colWidths])
  // Visible columns in render order + the table's total pixel width (checkbox +
  // every visible column), which drives the <colgroup> and the mirror scrollbar.
  const visibleColKeys = ALL_COL_KEYS.filter((k) => show(k))
  const tableTotalWidth = CHECKCOL_WIDTH + visibleColKeys.reduce((sum, k) => sum + colW(k), 0)

  useLayoutEffect(() => {
    const el = bottomScrollRef.current
    if (!el) return undefined
    const measure = () => {
      // Use the table's own width so the top bar tracks content-width changes
      // (tab/column switches, expanded cells) that don't resize the container.
      const w = tableRef.current ? tableRef.current.offsetWidth : el.scrollWidth
      setTableWidth(w)
      if (headRowRef.current) setHeadH(headRowRef.current.offsetHeight)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (tableRef.current) ro.observe(tableRef.current)
    return () => ro.disconnect()
  }, [rows.length, editing, articles.length, activeTab])

  const syncScroll = useCallback((from, to) => {
    if (syncingRef.current) return
    syncingRef.current = true
    if (to.current && from.current) to.current.scrollLeft = from.current.scrollLeft
    syncingRef.current = false
  }, [])

  const busy = job.active && (job.phase === 'connecting' || job.phase === 'running')
  const taggingBusy = busy && job.kind === 'tagging'
  const chartsBusy = busy && job.kind === 'charts'
  // Charts is stage-based (no batch count) → indeterminate bar while running.
  const indeterminate = job.phase === 'running' && (job.kind === 'charts' || job.progress.total === 0)
  const pct =
    job.phase === 'complete'
      ? 100
      : job.progress.total
      ? Math.round((job.progress.done / job.progress.total) * 100)
      : 0
  const showProgress = job.active && job.phase !== 'idle' && !(job.kind === 'charts' && job.phase === 'complete')

  // Both tabs derive from the one tagged file, so they share the load state.
  const viewLoading = loading
  const viewError = error
  const viewCount = dataset.length
  const retryLoad = load

  // The session's own name, matching how the Data tab labels it.
  const sessionTitle = session?.name ? prettyFileName(session.name) : project?.name || 'Articles'
  const reviewWindow = sessionWindow(session)

  const body = (
    <>
      {!asModal && (
        <button className="backlink" onClick={onBack}>
          <ArrowLeftIcon width={18} height={18} /> Back to {project?.name || 'project'}
        </button>
      )}

      <section className="subhead">
        <p className="subhead__kicker">REVIEW · TAGGED ARTICLES</p>
        {!asModal && <h1 className="subhead__title">{sessionTitle}</h1>}
        <p className="subhead__meta">
          {reviewWindow && <>{formatWindow(reviewWindow)}{' · '}</>}
          {showIrrelevant ? (
            <>
              {irrelevantArticles.length} irrelevant {irrelevantArticles.length === 1 ? 'article' : 'articles'}
              {' · '}filtered out by the relevancy agent — move any back to relevant to tag it
            </>
          ) : (
            <>
              {relevantArticles.length} tagged {relevantArticles.length === 1 ? 'article' : 'articles'}
              {' · '}<span className="subhead__hl">{approvedCount} approved</span>
              {' · '}review the AI tags before building dashboards
            </>
          )}
        </p>
      </section>

      {showProgress && (
        <section className={`tagpanel${job.phase === 'error' ? ' tagpanel--error' : ''}`}>
          <div className="tagpanel__head">
            <h2 className="tagpanel__title">
              {job.phase === 'error'
                ? job.kind === 'charts'
                  ? 'Dashboard generation failed'
                  : 'Tagging failed'
                : job.phase === 'complete'
                ? job.kind === 'charts'
                  ? 'Dashboards ready'
                  : `Tagging complete${job.totalArticles ? ` · ${job.totalArticles} articles` : ''}`
                : job.kind === 'charts'
                ? 'Building dashboards…'
                : `Generating tags${job.totalArticles ? ` · ${job.totalArticles} articles` : ''}`}
            </h2>
            {job.progress.total > 0 && job.phase !== 'error' && (
              <span className="tagpanel__count">
                {job.progress.done}/{job.progress.total} batches · {pct}%
              </span>
            )}
          </div>

          {job.phase !== 'error' && (
            <div className={`progress${indeterminate ? ' progress--indeterminate' : ''}`}>
              <div className="progress__bar" style={{ width: indeterminate ? '40%' : `${pct}%` }} />
            </div>
          )}

          <div className="log">
            {job.messages.map((m, i) => (
              <div className="log__line" key={i}>{m}</div>
            ))}
          </div>

          {job.phase === 'error' && (
            <div className="tagpanel__actions">
              <button
                className="btn btn--primary"
                onClick={job.kind === 'charts' ? startCharts : startTagging}
              >
                <RefreshIcon width={16} height={16} /> Retry
              </button>
            </div>
          )}
        </section>
      )}

      <section className={`panel${asModal ? ' panel--flat' : ''}`}>
        {tabbed && (
          <div className="rtabs" role="tablist" aria-label="Review data">
            <button
              className={`rtab${activeTab === 'monitoring' ? ' rtab--on' : ''}`}
              role="tab"
              aria-selected={activeTab === 'monitoring'}
              onClick={() => switchTab('monitoring')}
            >
              Monitoring Data
            </button>
            <button
              className={`rtab${activeTab === 'dashboards' ? ' rtab--on' : ''}`}
              role="tab"
              aria-selected={activeTab === 'dashboards'}
              onClick={() => switchTab('dashboards')}
            >
              Dashboards Data
            </button>
            <button
              className={`rtab${activeTab === 'irrelevant' ? ' rtab--on' : ''}`}
              role="tab"
              aria-selected={activeTab === 'irrelevant'}
              onClick={() => switchTab('irrelevant')}
            >
              Irrelevant
            </button>
          </div>
        )}
        {showIrrelevant && (
          <div className="savenote savenote--hint">
            These articles were judged not relevant by the relevancy agent and were excluded before tagging.
          </div>
        )}
        <div className="toolbar">
          <div className="search">
            <SearchIcon width={18} height={18} />
            <input
              className="search__input"
              placeholder="Search title, content, theme, brand…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {/* Irrelevant articles are pre-tagging and ungrouped — they carry no
              syndication or story-group relations to group by, so the tab is
              always the flat list, ordered by relevancy score. */}
          {!showIrrelevant && (
            <div className="segmented" role="tablist" aria-label="Table view">
              <button
                className={`segmented__btn${rawViewMode === 'grouped' ? ' segmented__btn--on' : ''}`}
                onClick={() => setViewMode('grouped')}
                title="Group by story → similar & syndicated"
              >
                Grouped
              </button>
              <button
                className={`segmented__btn${rawViewMode === 'flat' ? ' segmented__btn--on' : ''}`}
                onClick={() => setViewMode('flat')}
              >
                Flat
              </button>
            </div>
          )}
          {!editing && (
            <button
              className="btn btn--ghost"
              onClick={() => { setSaveNote(''); setDownloadOpen(true) }}
              disabled={busy || articles.length === 0}
              title="Download the articles as an Excel file"
            >
              <DownloadIcon width={18} height={18} /> Download
            </button>
          )}
          {!editing && (
            <button
              className="btn btn--ghost"
              onClick={() => setCompareOpen(true)}
              disabled={busy}
              title="Compare a delivered report against this session's articles"
            >
              <SpreadsheetIcon width={18} height={18} /> Compare
            </button>
          )}
          {!showIrrelevant && (editing ? (
            <>
              <button className="btn btn--ghost" onClick={cancelEdit} disabled={saving}>
                <CloseIcon width={18} height={18} /> Cancel
              </button>
              <button className="btn btn--primary" onClick={saveEdits} disabled={saving || dirtyCount === 0}>
                <EditIcon width={18} height={18} className={saving ? 'spin' : undefined} />
                {saving ? (bodyEdited ? 'Re-tagging…' : 'Saving…') : `Save${dirtyCount ? ` (${dirtyCount})` : ''}`}
              </button>
            </>
          ) : (
            <>
              {toApprove.length > 0 && (
                <button
                  className="btn btn--approve"
                  onClick={() => applyApproval(toApprove, true)}
                  disabled={approving || busy}
                  title="Approve the selected articles"
                >
                  <CheckIcon width={18} height={18} className={approving ? 'spin' : undefined} />
                  {approving ? 'Saving…' : `Approve (${toApprove.length})`}
                </button>
              )}
              {toDisapprove.length > 0 && (
                <button
                  className="btn btn--disapprove"
                  onClick={() => applyApproval(toDisapprove, false)}
                  disabled={approving || busy}
                  title="Disapprove the selected articles"
                >
                  <CloseIcon width={18} height={18} className={approving ? 'spin' : undefined} />
                  {approving ? 'Saving…' : `Disapprove (${toDisapprove.length})`}
                </button>
              )}
              <button
                className="btn btn--ghost"
                onClick={() => { setSaveNote(''); setUrlModalOpen(true) }}
                disabled={busy}
                title="Fetch an article by URL and AI-tag it"
              >
                <PlusIcon width={18} height={18} /> Add by URL
              </button>
              <button
                className="btn btn--ghost"
                onClick={() => { setSaveNote(''); setEditWarn(''); setEditing(true) }}
                disabled={busy || articles.length === 0}
                title="Edit the AI tags inline"
              >
                <EditIcon width={18} height={18} /> Edit tags
              </button>
              <button
                className="btn btn--ghost"
                onClick={startTagging}
                disabled={busy}
                title="Re-run AI tagging for this file"
              >
                <RefreshIcon width={18} height={18} className={taggingBusy ? 'spin' : undefined} />
                {taggingBusy ? 'Tagging…' : 'Regenerate'}
              </button>
              {!asModal && (
                <button
                  className="btn btn--primary"
                  onClick={handleCreateDashboard}
                  disabled={busy || articles.length === 0 || !anyApproved}
                  title={!anyApproved
                    ? 'Approve at least one article to build dashboards'
                    : 'Generate dashboards from the tagged articles'}
                >
                  <DashboardIcon width={18} height={18} className={chartsBusy ? 'spin' : undefined} />
                  {chartsBusy ? 'Building…' : 'Create Dashboard'}
                </button>
              )}
            </>
          ))}
          {showIrrelevant && (
            <button
              className="btn btn--approve"
              onClick={() => markRelevant(selectedToMove)}
              disabled={markingIds.size > 0 || selectedToMove.length === 0}
              title={selectedToMove.length === 0
                ? 'Select one or more articles to move to relevant'
                : 'AI-tag the selected articles and move them to the relevant set'}
            >
              <CheckIcon width={18} height={18} className={markingIds.size > 0 ? 'spin' : undefined} />
              {markingIds.size > 0 ? 'Moving…' : `Move ${selectedToMove.length || ''} to relevant`.replace('  ', ' ')}
            </button>
          )}
        </div>

        {saveNote && <div className="savenote">{saveNote}</div>}
        {editWarn && <div className="savenote savenote--err">{editWarn}</div>}
        {editing && (
          <div className="savenote savenote--hint">
            Editing tags — only changed fields are saved. Title and content can’t be edited. Lists are comma-separated.
            When you change a value or its confidence (Relevancy, Section, Sentiment, Theme), update the matching reason too.
          </div>
        )}

        {!viewLoading && !viewError && viewCount > 0 && filtersActive && (
          <div className="filterbar">
            <span>Showing {rows.length} of {viewCount}</span>
            <button className="linkbtn" onClick={clearFilters}>Clear all filters</button>
          </div>
        )}

        {!viewLoading && !viewError && selectedCount > 0 && (
          <div className="filterbar">
            <span>{selectedCount} selected</span>
            <button className="linkbtn" onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
        )}

        {viewLoading && <div className="state"><p>{showIrrelevant ? 'Loading irrelevant articles…' : 'Loading tagged articles…'}</p></div>}

        {!viewLoading && viewError && (
          <div className="state state--error">
            <p>{viewError}</p>
            <button className="btn btn--ghost" onClick={retryLoad}>Retry</button>
          </div>
        )}

        {!viewLoading && !viewError && viewCount === 0 && (
          <div className="state">
            <p>{showIrrelevant
              ? 'No irrelevant articles — everything passed the relevancy check.'
              : taggingBusy ? 'Tagging in progress — articles will appear here once ready.' : 'No tagged articles found for this session.'}</p>
          </div>
        )}

        {!viewLoading && !viewError && viewCount > 0 && (
          <>
            <div
              className="rtbl__topscroll"
              ref={topScrollRef}
              onScroll={() => syncScroll(topScrollRef, bottomScrollRef)}
            >
              <div className="rtbl__topscroll-inner" style={{ width: tableTotalWidth }} />
            </div>
            <div
              className="rtbl__scroll"
              ref={bottomScrollRef}
              onScroll={() => syncScroll(bottomScrollRef, topScrollRef)}
            >
            <table
              className="rtbl"
              ref={tableRef}
              style={{
                ...(showIrrelevant ? { width: '100%', minWidth: tableTotalWidth } : { width: tableTotalWidth }),
                // The frozen ID column sits after the (also frozen) Status column
                // when it's visible, so its sticky offset tracks Status's width.
                '--idcol-left': `${CHECKCOL_WIDTH + (show('status') ? colW('status') : 0)}px`,
              }}
            >
              <colgroup>
                <col style={{ width: CHECKCOL_WIDTH }} />
                {visibleColKeys.map((k) => {
                  // On the Irrelevant tab, let the last column (Reason) absorb any
                  // leftover width so it stretches to the end — unless the user has
                  // manually resized it, in which case honor that fixed width.
                  const stretch = showIrrelevant && k === 'relevancy_reason' && colWidths[k] == null
                  return <col key={k} style={stretch ? undefined : { width: colW(k) }} />
                })}
              </colgroup>
              <thead>
                <tr ref={headRowRef}>
                  <th className="rtbl__checkcol">
                    <TriCheckbox
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected}
                      onChange={toggleSelectAll}
                      ariaLabel="Select all"
                    />
                  </th>
                  {visibleColKeys.map((k) => (
                    <th key={k} className={k === 'id' ? 'rtbl__idcol' : k === 'status' ? 'rtbl__statuscol' : undefined}>
                      {COLUMN_LABELS[k]}
                      <span
                        className="rtbl__resizer"
                        onMouseDown={(e) => startResize(k, e)}
                        title="Drag to resize"
                      />
                    </th>
                  ))}
                </tr>
                <tr className="rtbl__filters" style={{ '--filter-top': `${headH}px` }}>
                  <th className="rtbl__checkcol" />
                  {/* The Status column has no filter, so it hosts the collapse-all toggle. */}
                  {show('status') && (
                    <th className="rtbl__statuscol">
                      {sectionGrouped && sectionGroups.length > 0 && (
                        <button
                          className="linkbtn collapseall"
                          onClick={toggleAllSections}
                          title={allSectionsCollapsed ? 'Expand every section' : 'Collapse every section'}
                        >
                          <ChevronDownIcon
                            width={13}
                            height={13}
                            style={{ transform: allSectionsCollapsed ? 'rotate(-90deg)' : 'none' }}
                          />
                          {allSectionsCollapsed ? 'Expand all' : 'Collapse all'}
                        </button>
                      )}
                    </th>
                  )}
                  {show('id') && (
                    <th className="rtbl__idcol">
                      <input className="fcell fcell--id" placeholder="ID" value={filters.id} onChange={(e) => setFilter('id', e.target.value)} />
                    </th>
                  )}
                  {show('title') && <th><input className="fcell" placeholder="Filter…" value={filters.title} onChange={(e) => setFilter('title', e.target.value)} /></th>}
                  {show('is_subscription') && (
                    <th>
                      <select className="fcell" value={filters.subscription} onChange={(e) => setFilter('subscription', e.target.value)}>
                        <option value="">All</option>
                        <option value="yes">Subscription</option>
                        <option value="no">Fetched</option>
                      </select>
                    </th>
                  )}
                  {show('summary') && <th><input className="fcell" placeholder="Filter…" value={filters.summary} onChange={(e) => setFilter('summary', e.target.value)} /></th>}
                  {show('domain') && <th><input className="fcell" placeholder="Filter…" value={filters.domain} onChange={(e) => setFilter('domain', e.target.value)} /></th>}
                  {show('url') && <th><input className="fcell" placeholder="Filter…" value={filters.url} onChange={(e) => setFilter('url', e.target.value)} /></th>}
                  {show('date') && (
                    <th>
                      <DateRangePicker
                        from={filters.dateFrom}
                        to={filters.dateTo}
                        onChange={(f, t) => setFilters((prev) => ({ ...prev, dateFrom: f, dateTo: t }))}
                      />
                    </th>
                  )}
                  {show('keyword_matched') && <th><input className="fcell" placeholder="Filter…" value={filters.keyword_matched} onChange={(e) => setFilter('keyword_matched', e.target.value)} /></th>}
                  {show('relevancy_confidence') && <th>{confFilter('relConfOp', 'relConfVal')}</th>}
                  {show('relevancy_reason') && <th><input className="fcell" placeholder="Filter…" value={filters.relevancy_reason} onChange={(e) => setFilter('relevancy_reason', e.target.value)} /></th>}
                  {show('section') && <th><input className="fcell" placeholder="Filter…" value={filters.section} onChange={(e) => setFilter('section', e.target.value)} /></th>}
                  {show('section_confidence') && <th>{confFilter('secConfOp', 'secConfVal')}</th>}
                  {show('section_reason') && <th><input className="fcell" placeholder="Filter…" value={filters.section_reason} onChange={(e) => setFilter('section_reason', e.target.value)} /></th>}
                  {show('brand') && <th><input className="fcell" placeholder="Filter…" value={filters.brand_of_interest} onChange={(e) => setFilter('brand_of_interest', e.target.value)} /></th>}
                  {show('sentiment') && (
                    <th>
                      <select className="fcell" value={filters.sentiment} onChange={(e) => setFilter('sentiment', e.target.value)}>
                        <option value="">All</option>
                        <option value="POS">Positive</option>
                        <option value="NEG">Negative</option>
                        <option value="NEU">Neutral</option>
                      </select>
                    </th>
                  )}
                  {show('sentiment_confidence') && <th>{confFilter('sentConfOp', 'sentConfVal')}</th>}
                  {show('sentiment_reason') && <th><input className="fcell" placeholder="Filter…" value={filters.sentiment_reason} onChange={(e) => setFilter('sentiment_reason', e.target.value)} /></th>}
                  {show('theme') && <th><input className="fcell" placeholder="Filter…" value={filters.theme} onChange={(e) => setFilter('theme', e.target.value)} /></th>}
                  {show('theme_confidence') && <th>{confFilter('themeConfOp', 'themeConfVal')}</th>}
                  {show('theme_reason') && <th><input className="fcell" placeholder="Filter…" value={filters.theme_reason} onChange={(e) => setFilter('theme_reason', e.target.value)} /></th>}
                  {show('competitors') && <th><input className="fcell" placeholder="Filter…" value={filters.competitors} onChange={(e) => setFilter('competitors', e.target.value)} /></th>}
                  {show('author') && <th><input className="fcell" placeholder="Filter…" value={filters.author} onChange={(e) => setFilter('author', e.target.value)} /></th>}
                  {show('priority') && (
                    <th>
                      <select className="fcell" value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
                        <option value="">All</option>
                        <option value="watch">Watch</option>
                        <option value="no">No</option>
                      </select>
                    </th>
                  )}
                  {show('people') && <th><input className="fcell" placeholder="Filter…" value={filters.peoples} onChange={(e) => setFilter('peoples', e.target.value)} /></th>}
                  {show('countries') && <th><input className="fcell" placeholder="Filter…" value={filters.countries} onChange={(e) => setFilter('countries', e.target.value)} /></th>}
                  {show('organizations') && <th><input className="fcell" placeholder="Filter…" value={filters.organizations} onChange={(e) => setFilter('organizations', e.target.value)} /></th>}
                  {show('syndication') && <th />}
                  {show('similar') && <th />}
                  {show('added_type') && (
                    <th>
                      <select className="fcell" value={filters.addedType} onChange={(e) => setFilter('addedType', e.target.value)}>
                        <option value="">All</option>
                        <option value="manual">Manual</option>
                        <option value="auto">Tagged</option>
                      </select>
                    </th>
                  )}
                  {show('mark_relevant') && <th />}
                  {show('mark_irrelevant') && <th />}
                </tr>
              </thead>
              <tbody>
                {viewMode === 'grouped' && groups.length === 0 && (
                  <tr><td colSpan={groupColSpan} className="rtbl__empty">No articles match the current filters.</td></tr>
                )}
                {/* Monitoring tab: bucket the grouped rows under collapsible section headers. */}
                {viewMode === 'grouped' && sectionGrouped && sectionGroups.map((sec) => {
                  const collapsed = collapsedSections.has(sec.section)
                  return (
                    <Fragment key={`sec-${sec.section}`}>
                      <tr className="rtbl__grouplabel rtbl__sectionlabel">
                        <td colSpan={groupColSpan}>
                          <button
                            className="rtbl__grouptoggle rtbl__sectiontoggle"
                            onClick={() => toggleSection(sec.section)}
                            aria-expanded={!collapsed}
                          >
                            <ChevronDownIcon width={15} height={15} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }} />
                            {sec.section} ({sec.count})
                          </button>
                        </td>
                      </tr>
                      {!collapsed && sec.groups.map((g) => (
                        <Fragment key={`g-${g.main.id}`}>
                          {renderRow(g.main, 0, 'rtbl__row--main rtbl__row--insection')}
                          {renderSection(g.main, 'similar', g.similar, '↳ Similar')}
                          {renderSection(g.main, 'syndicated', g.syndicated, '↳ Syndicated')}
                        </Fragment>
                      ))}
                    </Fragment>
                  )
                })}
                {viewMode === 'grouped' && !sectionGrouped && (
                  groups.map((g) => (
                    <Fragment key={`g-${g.main.id}`}>
                      {renderRow(g.main, 0, 'rtbl__row--main')}
                      {renderSection(g.main, 'similar', g.similar, '↳ Similar')}
                      {renderSection(g.main, 'syndicated', g.syndicated, '↳ Syndicated')}
                    </Fragment>
                  ))
                )}

                {viewMode === 'flat' && rows.length === 0 && (
                  <tr><td colSpan={groupColSpan} className="rtbl__empty">No articles match the current filters.</td></tr>
                )}
                {viewMode === 'flat' && rows.map((a, i) => renderRow(a, i))}

                {!showIrrelevant && viewMode === 'flat' && !editing && adding && (
                  <>
                    {newRows.map((row) => (
                      <tr className="rtbl__addrow" key={row._key}>
                        <td className="rtbl__checkcol" />
                        {show('status') && <td className="cell--status" />}
                        {show('id') && (
                          <td className="cell--id">
                            <button
                              className="rtbl__rowdel"
                              title="Remove this row"
                              onClick={() => removeRow(row._key)}
                              disabled={addSaving}
                            >
                              <CloseIcon width={14} height={14} />
                            </button>
                          </td>
                        )}
                        {show('title') && (
                          <td className="cell--title">
                            <input className="ecell" placeholder="Title" value={row.title || ''} onChange={(e) => setRowField(row._key, 'title', e.target.value)} />
                          </td>
                        )}
                        {/* The Subscription column's slot on a draft row takes the body
                            instead: a new article still needs one to be tagged, and the
                            flag means nothing until it's saved. */}
                        {show('is_subscription') && (
                          <td className="cell--content">
                            <input className="ecell" placeholder="Content" value={row.content || ''} onChange={(e) => setRowField(row._key, 'content', e.target.value)} />
                          </td>
                        )}
                        {show('summary') && (
                          <td className="cell--content">
                            <input className="ecell" placeholder="Summary" value={row.summary || ''} onChange={(e) => setRowField(row._key, 'summary', e.target.value)} />
                          </td>
                        )}
                        {show('domain') && (
                          <td className="cell--domain"><span className="muted" title="Derived from the URL on save">auto</span></td>
                        )}
                        {show('url') && (
                          <td className="cell--url">
                            <input className="ecell" placeholder="https://…" value={row.url || ''} onChange={(e) => setRowField(row._key, 'url', e.target.value)} />
                          </td>
                        )}
                        {show('date') && (
                          <td>
                            <input className="ecell" type="date" value={row.date || ''} onChange={(e) => setRowField(row._key, 'date', e.target.value)} />
                          </td>
                        )}
                        {show('keyword_matched') && <td><span className="muted">—</span></td>}
                        {show('relevancy_confidence') && <td>{newCell(row, 'relevancy_confidence')}</td>}
                        {show('relevancy_reason') && <td>{newCell(row, 'relevancy_reason')}</td>}
                        {show('section') && <td>{newCell(row, 'section')}</td>}
                        {show('section_confidence') && <td>{newCell(row, 'section_category_confidence')}</td>}
                        {show('section_reason') && <td>{newCell(row, 'section_reason')}</td>}
                        {show('brand') && <td>{newCell(row, 'brand_of_interest')}</td>}
                        {show('sentiment') && <td>{newCell(row, 'sentiment')}</td>}
                        {show('sentiment_confidence') && <td>{newCell(row, 'sentiment_confidence')}</td>}
                        {show('sentiment_reason') && <td>{newCell(row, 'xai_sentiment_reason')}</td>}
                        {show('theme') && <td>{newCell(row, 'theme')}</td>}
                        {show('theme_confidence') && <td>{newCell(row, 'theme_confidence')}</td>}
                        {show('theme_reason') && <td>{newCell(row, 'xai_theme_reason')}</td>}
                        {show('competitors') && <td>{newCell(row, 'competitors')}</td>}
                        {show('author') && (
                          <td className="cell--author">
                            <input className="ecell" placeholder="Author" value={row.author || ''} onChange={(e) => setRowField(row._key, 'author', e.target.value)} />
                          </td>
                        )}
                        {show('priority') && <td>{newCell(row, 'priority_watch')}</td>}
                        {show('people') && <td>{newCell(row, 'peoples')}</td>}
                        {show('countries') && <td>{newCell(row, 'countries')}</td>}
                        {show('organizations') && <td>{newCell(row, 'organizations')}</td>}
                        {show('syndication') && <td className="cell--rel"><span className="muted">—</span></td>}
                        {show('similar') && <td className="cell--rel"><span className="muted">—</span></td>}
                        {show('added_type') && <td className="cell--added"><span className="badge badge--manual">Manual</span></td>}
                        {show('mark_relevant') && <td />}
                        {show('mark_irrelevant') && <td />}
                      </tr>
                    ))}
                    <tr className="rtbl__addactions">
                      <td colSpan={groupColSpan}>
                        <div className="rtbl__addbar">
                          <button className="rtbl__addlink" onClick={addAnotherRow} disabled={addSaving}>
                            + Add another row
                          </button>
                          <span className="rtbl__addbtns">
                            <span className="muted">{newRows.length} new {newRows.length === 1 ? 'row' : 'rows'} · title or content required</span>
                            <button className="btn btn--ghost" onClick={cancelAdd} disabled={addSaving}>
                              <CloseIcon width={16} height={16} /> Cancel
                            </button>
                            <button className="btn btn--primary" onClick={saveNewArticles} disabled={addSaving}>
                              {addSaving ? 'Adding…' : `Add ${newRows.length} article${newRows.length === 1 ? '' : 's'}`}
                            </button>
                          </span>
                        </div>
                      </td>
                    </tr>
                  </>
                )}

                {!showIrrelevant && viewMode === 'flat' && !editing && !adding && (
                  <tr className="rtbl__addtrigger">
                    <td colSpan={groupColSpan}>
                      <button className="rtbl__addlink" onClick={startAdd} disabled={busy}>
                        + Add article
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </>
        )}
      </section>

      {urlModalOpen && (
        <AddByUrlModal sessionId={session.id} onClose={() => setUrlModalOpen(false)} onSaved={onUrlSaved} />
      )}

      <DownloadArticlesModal
        open={downloadOpen}
        sessionId={session.id}
        onClose={() => setDownloadOpen(false)}
      />

      <CompareReportModal
        open={compareOpen}
        sessionId={session.id}
        onClose={() => setCompareOpen(false)}
      />

      {irrModalOpen && (
        <div className="overlay" onMouseDown={() => { if (!movingIrr) setIrrModalOpen(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="irr-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="irr-title" className="modal__title">
              Move {irrIds.length} article{irrIds.length === 1 ? '' : 's'} to irrelevant
            </h2>
            <p className="modal__sub">
              A reason is required. It’s saved as the not-relevant reason and shown on the Irrelevant tab.
              The article’s tags are kept, so you can move it back later.
            </p>
            <label className="field">
              <span className="field__label">Reason (required)</span>
              <textarea
                className="field__input field__textarea"
                rows={3}
                value={irrReason}
                placeholder="Why aren’t these articles relevant?"
                onChange={(e) => setIrrReason(e.target.value)}
                autoFocus
                disabled={movingIrr}
                style={{ height: 96, maxHeight: 200, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              />
            </label>
            {irrErr && <div className="savenote savenote--err">{irrErr}</div>}
            <div className="form__actions">
              <button className="btn btn--ghost" onClick={() => setIrrModalOpen(false)} disabled={movingIrr}>Cancel</button>
              <button
                className="btn btn--primary"
                onClick={confirmMoveIrrelevant}
                disabled={movingIrr || !irrReason.trim()}
              >
                {movingIrr ? 'Moving…' : 'Move to irrelevant'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmCreate && missingTab && (
        <div className="overlay" onMouseDown={() => setConfirmCreate(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cc-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="cc-title" className="modal__title">No articles approved in {missingTab}</h2>
            <p className="modal__sub">
              You haven’t approved any articles in the <strong>{missingTab}</strong> tab, so its
              dashboards won’t include any articles. Approve some there first, or continue without them.
            </p>
            <div className="form__actions">
              <button className="btn btn--ghost" onClick={() => setConfirmCreate(false)}>Cancel</button>
              <button
                className="btn btn--primary"
                onClick={() => { setConfirmCreate(false); startCharts() }}
              >
                Continue anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  if (asModal) {
    return (
      <div className="rvmodal" role="dialog" aria-modal="true">
        <div className="rvmodal__backdrop" onClick={onClose} />
        <div className="rvmodal__panel">
          <button className="rvmodal__close" onClick={onClose} aria-label="Close review">
            <CloseIcon width={20} height={20} />
          </button>
          <div className="rvmodal__scroll">{body}</div>
        </div>
      </div>
    )
  }

  return body
}

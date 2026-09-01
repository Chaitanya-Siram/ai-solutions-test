import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteSession, listSessions, listGeneratedQueries, listOnedriveFiles, deleteOnedriveFile, getSession, mergeSessions, renameSession, updateGeneratedQuery, runGeneratedQuery } from '../api/sessions.js'
import { addSectionsPrompt, addRelevancyPrompt, scheduleGeneratedQuery, updateProject } from '../api/projects.js'
import UploadModal from '../components/UploadModal.jsx'
import ConfirmModal from '../components/ConfirmModal.jsx'
import ProjectKeywordsModal from '../components/ProjectKeywordsModal.jsx'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  DashboardIcon,
  DownloadIcon,
  EditIcon,
  EyeIcon,
  PlayIcon,
  FileIcon,
  FileTextIcon,
  MergeIcon,
  SearchIcon,
  SettingsIcon,
  SpreadsheetIcon,
  TrashIcon,
  UploadIcon,
  WorkflowIcon,
} from '../components/Icons.jsx'
import SectionPromptModal from '../components/SectionPromptModal.jsx'
import RelevancyPromptModal from '../components/RelevancyPromptModal.jsx'
import RunWindowModal from '../components/RunWindowModal.jsx'
import ScheduleModal from '../components/ScheduleModal.jsx'
import GeneratedQueryEditModal from '../components/GeneratedQueryEditModal.jsx'
import RenameFileModal from '../components/RenameFileModal.jsx'
import QueryBuilderDock from '../components/QueryBuilderDock.jsx'
import {
  dateGroupLabel,
  dateKey,
  formatDate,
  formatWindow,
  prettyFileName,
  sessionExt,
  sessionWindow,
  uploadedDate,
} from '../utils/files.js'

const FILE_TYPE = {
  CSV: { Icon: SpreadsheetIcon, bg: '#d1fae5', fg: '#059669' },
  XLSX: { Icon: SpreadsheetIcon, bg: '#d1fae5', fg: '#059669' },
  XLS: { Icon: SpreadsheetIcon, bg: '#d1fae5', fg: '#059669' },
  PDF: { Icon: FileTextIcon, bg: '#fee2e2', fg: '#dc2626' },
  JSON: { Icon: BracesIcon, bg: '#dbeafe', fg: '#2563eb' },
  QUERY: { Icon: SearchIcon, bg: '#ede9fe', fg: '#7c3aed' },
}
function typeFor(ext) {
  return FILE_TYPE[ext] || { Icon: FileIcon, bg: '#e5e7eb', fg: '#6b7280' }
}

export default function ProjectScreen({ project, onBack, onOpenReview, onOpenWorkflow, onOpenComparisons }) {
  const [sessions, setSessions] = useState([])
  const [generated, setGenerated] = useState([])
  const [onedrive, setOnedrive] = useState([])
  const [deleteOnedriveFor, setDeleteOnedriveFor] = useState(null) // synced file pending delete
  const [deletingOnedrive, setDeletingOnedrive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sortDesc, setSortDesc] = useState(true)
  const [selected, setSelected] = useState(() => new Set())
  const [uploadOpen, setUploadOpen] = useState(false)
  const [tab, setTab] = useState('uploading') // uploading (Data) | auto (Generated Query) | onedrive (Onedrive Syncs)
  const [expanded, setExpanded] = useState(() => new Set()) // session ids with queries shown
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set()) // date-group keys collapsed
  const [scheduleFor, setScheduleFor] = useState(null) // generated query being scheduled
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [editQuery, setEditQuery] = useState(null) // generated query being edited
  const [editSaving, setEditSaving] = useState(false)
  const [runningId, setRunningId] = useState(null) // generated query id being run manually
  const [runFor, setRunFor] = useState(null) // generated query awaiting its run window
  const [merging, setMerging] = useState(false) // merge request in flight
  const [renameFor, setRenameFor] = useState(null) // row being renamed via the popup
  const [renameSaving, setRenameSaving] = useState(false)

  function toggleExpand(id) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleGroup(key) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Persist (or clear) a generated query's hourly schedule, then sync local state.
  const saveSchedule = useCallback(
    async (time, timezone) => {
      if (!scheduleFor) return
      setScheduleSaving(true)
      try {
        const updated = await scheduleGeneratedQuery(project.id, scheduleFor.id, time, timezone)
        setGenerated((list) => list.map((g) => (g.id === updated.id ? updated : g)))
        setScheduleFor(null)
      } catch (err) {
        alert(`Could not save schedule: ${err.message}`)
      } finally {
        setScheduleSaving(false)
      }
    },
    [scheduleFor, project.id],
  )
  const unschedule = useCallback(() => saveSchedule(null, null), [saveSchedule])

  // Persist edits to a generated query's name/queries, then sync local state.
  const saveQueryEdits = useCallback(
    async (fields) => {
      if (!editQuery) return
      setEditSaving(true)
      try {
        const updated = await updateGeneratedQuery(project.id, editQuery.id, fields)
        setGenerated((list) => list.map((g) => (g.id === updated.id ? updated : g)))
        setEditQuery(null)
      } catch (err) {
        alert(`Could not save query: ${err.message}`)
      } finally {
        setEditSaving(false)
      }
    },
    [editQuery, project.id],
  )

  // Project-level keywords — editable via the settings (gear) popup.
  const [keywords, setKeywords] = useState(() => ({
    brand_keywords: project.brand_keywords || [],
    competitor_keywords: project.competitor_keywords || [],
    message_keywords: project.message_keywords || [],
  }))
  const [keywordsOpen, setKeywordsOpen] = useState(false)
  const [keywordsSaving, setKeywordsSaving] = useState(false)
  const saveKeywords = useCallback(
    async (next) => {
      setKeywordsSaving(true)
      try {
        const updated = await updateProject(project.id, next)
        // Keep both the in-memory project and local state in sync.
        project.brand_keywords = updated.brand_keywords
        project.competitor_keywords = updated.competitor_keywords
        project.message_keywords = updated.message_keywords
        setKeywords({
          brand_keywords: updated.brand_keywords || [],
          competitor_keywords: updated.competitor_keywords || [],
          message_keywords: updated.message_keywords || [],
        })
        setKeywordsOpen(false)
      } catch (err) {
        alert(`Could not save keywords: ${err.message}`)
      } finally {
        setKeywordsSaving(false)
      }
    },
    [project],
  )

  // Media Monitoring section prompt — persisted on the project via the API.
  const [sectionOpen, setSectionOpen] = useState(false)
  const [sectionPrompt, setSectionPrompt] = useState(project.monitoring_sections_prompt || '')
  const [sectionSaving, setSectionSaving] = useState(false)
  const saveSectionPrompt = useCallback(
    async (value) => {
      setSectionSaving(true)
      try {
        const updated = await addSectionsPrompt(project.id, value)
        // Keep the in-memory project in sync so reopening shows the saved value.
        project.monitoring_sections_prompt = updated?.monitoring_sections_prompt ?? value
        setSectionPrompt(updated?.monitoring_sections_prompt ?? value)
        setSectionOpen(false)
      } catch (err) {
        alert(`Could not save section prompt: ${err.message}`)
      } finally {
        setSectionSaving(false)
      }
    },
    [project],
  )

  // Relevancy prompt — the criteria the relevancy agent uses to filter articles
  // before tagging. Persisted on the project via the API.
  const [relevancyOpen, setRelevancyOpen] = useState(false)
  const [relevancyPrompt, setRelevancyPrompt] = useState(project.relevancy_prompt || '')
  const [relevancySaving, setRelevancySaving] = useState(false)
  const saveRelevancyPrompt = useCallback(
    async (value) => {
      setRelevancySaving(true)
      try {
        const updated = await addRelevancyPrompt(project.id, value)
        project.relevancy_prompt = updated?.relevancy_prompt ?? value
        setRelevancyPrompt(updated?.relevancy_prompt ?? value)
        setRelevancyOpen(false)
      } catch (err) {
        alert(`Could not save relevancy prompt: ${err.message}`)
      } finally {
        setRelevancySaving(false)
      }
    },
    [project],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [data, gen, od] = await Promise.all([
        listSessions(project.id),
        listGeneratedQueries(project.id).catch(() => []),
        listOnedriveFiles(project.id).catch(() => []),
      ])
      const list = Array.isArray(data) ? data : []
      setSessions(list)
      setGenerated(Array.isArray(gen) ? gen : [])
      setOnedrive(Array.isArray(od) ? od : [])
      setSelected(new Set()) // default: nothing selected
    } catch (err) {
      setError(err.message || 'Failed to load sessions.')
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    load()
  }, [load])

  // Manually trigger a generated query for a date window — creates a QUERY session
  // carrying that window, then opens the review screen with runTagging so the tagging
  // WebSocket tags whatever in the project's pool has no tags yet before the table loads
  // the window. It fetches first only for an unscheduled query; a scheduled one's pool is
  // already kept current by the hourly scheduler.
  const handleRunQuery = useCallback(
    async (startIso, endIso) => {
      const gq = runFor
      if (!gq) return
      setRunningId(gq.id)
      try {
        const session = await runGeneratedQuery(project.id, gq.id, startIso, endIso)
        setRunFor(null)
        onOpenReview?.(session, { runTagging: true, nameHint: gq.name })
      } catch (err) {
        alert(`Could not start run: ${err.message}`)
      } finally {
        setRunningId(null)
      }
    },
    [project.id, onOpenReview, runFor],
  )

  const isQueryTab = tab === 'auto'
  const isOnedriveTab = tab === 'onedrive'

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Data tab → every session (no session-type filter). Generated Query tab →
    // the project's generated-query records. Onedrive Syncs → the synced files.
    const source = isOnedriveTab ? onedrive : isQueryTab ? generated : sessions
    // Map session id -> its display file name, so a merged session can name the
    // files it was built from.
    const nameById = new Map(sessions.map((s) => [s.id, prettyFileName(s.name)]))
    let list = source.map((s) => ({
      ...s,
      _name: isOnedriveTab
        ? s.file_name
        : isQueryTab
        ? (s.name || (s.brand_keywords?.[0] ? `${s.brand_keywords[0]} — Generated Query` : `Generated Query #${s.id}`))
        : prettyFileName(s.name),
      _ext: isOnedriveTab
        ? (s.file_name || '').split('.').pop()?.toUpperCase() || 'FILE'
        : isQueryTab ? 'QUERY' : sessionExt(s),
      // A synced file has no session to date — it carries its own created_at.
      _date: isOnedriveTab ? (s.created_at ? new Date(s.created_at) : null) : uploadedDate(s),
      // Only sessions carry a run window; generated-query and synced records have none.
      _window: isQueryTab || isOnedriveTab ? null : sessionWindow(s),
      _mergedNames:
        !isQueryTab && !isOnedriveTab && s.session_type === 'merged' && Array.isArray(s.merged_session_ids)
          ? s.merged_session_ids.map((id) => nameById.get(id)).filter(Boolean)
          : null,
    }))
    if (q) {
      list = list.filter((s) => {
        const hay = [
          s._name,
          s.folder_name || '',
          s.status || '',
          ...(s.brand_keywords || []),
          ...(s.competitor_keywords || []),
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
    }
    list.sort((a, b) => {
      const av = a._date ? a._date.getTime() : 0
      const bv = b._date ? b._date.getTime() : 0
      return sortDesc ? bv - av : av - bv
    })
    return list
  }, [sessions, generated, onedrive, isQueryTab, isOnedriveTab, query, sortDesc])

  // Bucket the (already date-sorted) rows into day groups so the table can show
  // a "Today / Yesterday / date" header before each day's files.
  const dateGroups = useMemo(() => {
    const out = []
    let cur = null
    for (const r of rows) {
      const key = r._date ? dateKey(r._date) : 'unknown'
      if (!cur || cur.key !== key) {
        cur = { key, label: r._date ? dateGroupLabel(r._date) : 'No date', items: [] }
        out.push(cur)
      }
      cur.items.push(r)
    }
    return out
  }, [rows])

  const counts = useMemo(
    () => ({ uploading: sessions.length, auto: generated.length, onedrive: onedrive.length }),
    [sessions, generated, onedrive],
  )

  // Merge the selected data files into one new "merged" session, then open the
  // review screen so it gets tagged (dedup-by-url happens on the backend).
  const handleMerge = useCallback(async () => {
    const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id)
    if (ids.length < 2) {
      alert('Select at least two files to merge.')
      return
    }
    setMerging(true)
    try {
      const session = await mergeSessions(project.id, ids)
      onOpenReview?.(session, { runTagging: true })
    } catch (err) {
      alert(`Could not merge files: ${err.message}`)
    } finally {
      setMerging(false)
    }
  }, [rows, selected, project.id, onOpenReview])

  // Rename a data file's display name via the popup.
  const saveRename = useCallback(
    async (fullName) => {
      if (!renameFor) return
      const id = renameFor.id
      const name = (fullName || '').trim()
      if (!name || name === renameFor._name) {
        setRenameFor(null)
        return
      }
      setRenameSaving(true)
      try {
        const updated = await renameSession(id, name)
        setSessions((list) => list.map((s) => (s.id === id ? { ...s, name: updated.name } : s)))
        setRenameFor(null)
      } catch (err) {
        alert(`Could not rename file: ${err.message}`)
      } finally {
        setRenameSaving(false)
      }
    },
    [renameFor],
  )

  // Whether every file in a day group is selected (drives the group checkbox).
  function isGroupSelected(group) {
    return group.items.length > 0 && group.items.every((r) => selected.has(r.id))
  }

  // Toggle a whole day group: deselect all if fully selected, else select all.
  function toggleGroupSelect(group) {
    const allOn = isGroupSelected(group)
    setSelected((prev) => {
      const next = new Set(prev)
      group.items.forEach((r) => (allOn ? next.delete(r.id) : next.add(r.id)))
      return next
    })
  }

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Deleting a synced file also drops the articles it brought into the project pool —
  // which overlapping window sessions read — so the confirmation names the count and
  // the row is only removed optimistically once the user has agreed.
  async function confirmDeleteOnedrive() {
    const file = deleteOnedriveFor
    if (!file) return
    setDeletingOnedrive(true)
    const prev = onedrive
    try {
      await deleteOnedriveFile(file.id)
      setOnedrive((list) => list.filter((x) => x.id !== file.id))
      setDeleteOnedriveFor(null)
    } catch (err) {
      setOnedrive(prev)
      alert(`Could not delete file: ${err.message}`)
    } finally {
      setDeletingOnedrive(false)
    }
  }

  async function handleDelete(session) {
    if (!window.confirm(`Delete "${prettyFileName(session.name)}"?`)) return
    const prev = sessions
    setSessions((s) => s.filter((x) => x.id !== session.id))
    setSelected((sel) => {
      const next = new Set(sel)
      next.delete(session.id)
      return next
    })
    try {
      await deleteSession(session.id)
    } catch (err) {
      setSessions(prev)
      alert(`Could not delete file: ${err.message}`)
    }
  }

  // Project-level keywords (set at project creation), shown in the subhead.
  const brandKw = keywords.brand_keywords
  const compKw = keywords.competitor_keywords
  const msgKw = keywords.message_keywords
  const hasKeywords = brandKw.length + compKw.length + msgKw.length > 0
  const lastActivity = sessions
    .map((s) => uploadedDate(s))
    .filter(Boolean)
    .sort((a, b) => b - a)[0]
  const selectedCount = rows.filter((r) => selected.has(r.id)).length
  const activeCount = isOnedriveTab ? onedrive.length : isQueryTab ? generated.length : sessions.length

  return (
    <>
      <button className="backlink" onClick={onBack}>
        <ArrowLeftIcon width={18} height={18} /> All projects
      </button>

      <section className="subhead">
        <p className="subhead__kicker">PROJECT {String(project.id).padStart(2, '0')}</p>
        <h1 className="subhead__title">{project.name}</h1>
        <p className="subhead__meta">
          {sessions.length} {sessions.length === 1 ? 'file' : 'files'} uploaded
          {lastActivity && <> · last activity {formatDate(lastActivity)}</>}
        </p>

        {hasKeywords && (
          <div className="kwgroups">
            {brandKw.length > 0 && (
              <div className="kwgroup">
                <span className="kwgroup__label">Brand</span>
                <div className="kwgroup__pills">
                  {brandKw.map((k) => (
                    <span className="pill pill--brand" key={k}>{k}</span>
                  ))}
                </div>
              </div>
            )}
            {compKw.length > 0 && (
              <div className="kwgroup">
                <span className="kwgroup__label">Competitors</span>
                <div className="kwgroup__pills">
                  {compKw.map((k) => (
                    <span className="pill pill--comp" key={k}>{k}</span>
                  ))}
                </div>
              </div>
            )}
            {msgKw.length > 0 && (
              <div className="kwgroup">
                <span className="kwgroup__label">Messages</span>
                <div className="kwgroup__pills">
                  {msgKw.map((k) => (
                    <span className="pill pill--msg" key={k}>{k}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="projbar">
        <div className="tabbar tabbar--inline">
          {[
            { key: 'uploading', label: 'Data', count: counts.uploading },
            { key: 'auto', label: 'Generated Query', count: counts.auto },
            { key: 'onedrive', label: 'Onedrive Syncs', count: counts.onedrive },
          ].map((t) => (
            <button
              key={t.key}
              className={`tabbtn${tab === t.key ? ' tabbtn--on' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label} <span className="tabbtn__count">{t.count}</span>
            </button>
          ))}
        </div>
        <div className="projbar__actions">
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => setKeywordsOpen(true)}
            title="Edit project keywords"
            aria-label="Edit project keywords"
          >
            <SettingsIcon width={18} height={18} />
          </button>
          <button className="btn btn--ghost" onClick={() => setSectionOpen(true)}>
            <EyeIcon width={18} height={18} />
            {sectionPrompt ? 'Edit Media Monitoring Section' : 'Set Media Monitoring Section'}
          </button>
          <button className="btn btn--ghost" onClick={() => setRelevancyOpen(true)}>
            <FileTextIcon width={18} height={18} />
            {relevancyPrompt ? 'Edit Relevancy Prompt' : 'Set Relevancy Prompt'}
          </button>
          <button
            className="btn btn--ghost"
            onClick={onOpenComparisons}
            title="Report coverage: how much of each delivered report the tool collected"
          >
            <SpreadsheetIcon width={18} height={18} /> Report Comparisons
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="toolbar">
          <div className="search">
            <SearchIcon width={18} height={18} />
            <input
              className="search__input"
              placeholder="Search files or keywords…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {tab === 'uploading' && (
            <button className="btn btn--ghost" onClick={() => setUploadOpen(true)}>
              <UploadIcon width={18} height={18} /> Upload file
            </button>
          )}
          {!isQueryTab && !isOnedriveTab && (
            <button
              className="btn btn--primary"
              disabled={selectedCount < 2 || merging}
              onClick={handleMerge}
            >
              <MergeIcon width={18} height={18} />
              {merging ? 'Merging…' : `Merge and Create Dashboard (${selectedCount})`}
            </button>
          )}
        </div>

        {loading && <TableSkeleton />}

        {!loading && error && (
          <div className="state state--error">
            <p>{error}</p>
            <button className="btn btn--ghost" onClick={load}>Retry</button>
          </div>
        )}

        {!loading && !error && activeCount === 0 && (
          <div className="state">
            {isOnedriveTab ? (
              <p>No OneDrive files synced for this project yet.</p>
            ) : isQueryTab ? (
              <p>No generated queries yet. Use “Create with natural language” below to build one.</p>
            ) : (
              <>
                <p>No files uploaded to this project yet.</p>
                <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>
                  <UploadIcon width={18} height={18} /> Upload file
                </button>
              </>
            )}
          </div>
        )}

        {!loading && !error && activeCount > 0 && (
          <div className="tbl">
            <div className="tbl__head trow">
              <span />
              <span className="th">{isQueryTab ? 'NAME' : 'FILE NAME'}</span>
              <button className="th th--sort" onClick={() => setSortDesc((d) => !d)}>
                {isQueryTab ? 'CREATED' : isOnedriveTab ? 'SYNCED DATE' : 'UPLOADED DATE'}
                <ChevronDownIcon
                  width={14}
                  height={14}
                  style={{ transform: sortDesc ? 'none' : 'rotate(180deg)' }}
                />
              </button>
              <span className="th" />
              <span className="th" />
            </div>

            {dateGroups.length === 0 && (
              <div className="tbl__empty">
                No {isQueryTab ? 'queries' : 'files'} match “{query}”.
              </div>
            )}

            {dateGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.key)
              return (
              <div className="tblgroup" key={group.key}>
                <div className="tblgroup__head">
                  <Checkbox
                    checked={isGroupSelected(group)}
                    onChange={() => toggleGroupSelect(group)}
                    ariaLabel={`Select all in ${group.label}`}
                  />
                  <button
                    type="button"
                    className="tblgroup__toggle"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!collapsed}
                  >
                    <ChevronDownIcon
                      width={15}
                      height={15}
                      style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
                    />
                    <span className="tblgroup__date">{group.label}</span>
                    <span className="tblgroup__count">
                      {group.items.length}{' '}
                      {isQueryTab
                        ? group.items.length === 1 ? 'query' : 'queries'
                        : group.items.length === 1 ? 'file' : 'files'}
                    </span>
                  </button>
                </div>
                {!collapsed && group.items.map((s) => {
              const { Icon, bg, fg } = typeFor(s._ext)
              const status = (s.status || '').toLowerCase()
              const isCompleted = status === 'completed'
              const isTagged = status === 'tagged' || isCompleted
              const isQuery = isQueryTab
              const groups = Array.isArray(s.queries) ? s.queries : []
              const queryCount = groups.reduce((n, g) => n + ((g.queries || []).length), 0)
              const open = expanded.has(s.id)
              return (
                <div className="trowwrap" key={s.id}>
                <div className="trow trow--body">
                  {isOnedriveTab ? (
                    <span />
                  ) : (
                    <Checkbox
                      checked={selected.has(s.id)}
                      onChange={() => toggleOne(s.id)}
                      ariaLabel={`Select ${s._name}`}
                    />
                  )}

                  <div className="cellfile">
                    <span className="ftile" style={{ backgroundColor: bg, color: fg }}>
                      <Icon width={18} height={18} />
                    </span>
                    <div className="cellfile__text">
                      <span className="cellfile__name">{s._name}</span>
                      {isQuery && queryCount > 0 ? (
                        <button
                          className="cellfile__toggle"
                          onClick={() => toggleExpand(s.id)}
                          aria-expanded={open}
                        >
                          {queryCount} {queryCount === 1 ? 'query' : 'queries'}
                          {groups.length > 1 && ` · ${groups.length} groups`}
                          <ChevronDownIcon
                            width={13}
                            height={13}
                            style={{ transform: open ? 'rotate(180deg)' : 'none' }}
                          />
                        </button>
                      ) : isOnedriveTab ? (
                        <span className="cellfile__type" title={s.folder_name || ''}>
                          {s._ext} · {s.folder_name || 'OneDrive'}
                          {` · ${s.article_count || 0} ${s.article_count === 1 ? 'article' : 'articles'}`}
                        </span>
                      ) : s._mergedNames && s._mergedNames.length > 0 ? (
                        <span className="cellfile__merged" title={`Merged from: ${s._mergedNames.join(', ')}`}>
                          Merged from {s._mergedNames.join(', ')}
                        </span>
                      ) : (
                        <span className="cellfile__type">{s._ext || 'FILE'}</span>
                      )}
                      {s._window && (
                        <span
                          className="cellfile__window"
                          title={`From ${formatDate(s._window.start)} to ${formatDate(s._window.end)}`}
                        >
                          <ClockIcon width={11} height={11} />
                          {formatWindow(s._window)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="celldate">{formatDate(s._date)}</div>

                  {isOnedriveTab ? (
                    <>
                      {/* A synced file is a log entry, not a session — nothing to run,
                          rename or open, so the row carries its outcome and a delete
                          that takes the articles it brought in with it. */}
                      <div className="rowactions">
                        <button
                          className="iconaction iconaction--danger"
                          aria-label="Delete synced file"
                          title={`Delete this file and its ${s.article_count || 0} article(s)`}
                          onClick={() => setDeleteOnedriveFor(s)}
                        >
                          <TrashIcon width={17} height={17} />
                        </button>
                      </div>
                      <span
                        className={`statpill${status === 'processed' ? ' statpill--on' : ''}`}
                        title={s.error || undefined}
                      >
                        {s.status || 'logged'}
                      </span>
                    </>
                  ) : isQuery ? (
                    <>
                      <div className="rowactions">
                        <button
                          className="iconaction"
                          aria-label="Run"
                          title="Run — pick a date range to review"
                          disabled={runningId === s.id}
                          onClick={() => setRunFor(s)}
                        >
                          <PlayIcon width={17} height={17} />
                        </button>
                        <button
                          className="iconaction"
                          aria-label="Edit query"
                          title="Edit query"
                          onClick={() => setEditQuery(s)}
                        >
                          <EditIcon width={17} height={17} />
                        </button>
                        <button
                          className="iconaction"
                          aria-label="Schedule hourly runs"
                          title={s.schedule_time
                            ? `Scheduled hourly at :${(s.schedule_time.split(':')[1] || '00')} past the hour, ${s.schedule_timezone} (from ${s.schedule_time}, UTC ${s.schedule_time_utc})`
                            : 'Schedule hourly runs'}
                          onClick={() => setScheduleFor(s)}
                        >
                          <ClockIcon width={17} height={17} />
                        </button>
                      </div>
                      <span className={`statpill${s.status === 'Scheduled' ? ' statpill--on' : ''}`}>
                        {s.status === 'Scheduled' && s.schedule_time
                          ? `hourly :${s.schedule_time.split(':')[1] || '00'} · ${(s.schedule_timezone || '').split('/').pop()?.replace(/_/g, ' ') || 'UTC'}`
                          : (s.status || 'Unscheduled')}
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="rowactions">
                        <button
                          className="iconaction"
                          aria-label="Rename"
                          title="Rename file"
                          onClick={() => setRenameFor(s)}
                        >
                          <EditIcon width={17} height={17} />
                        </button>
                        <button
                          className="iconaction"
                          aria-label="Download"
                          title="Download source file (coming soon)"
                          onClick={() => alert('Download is not wired to an endpoint yet.')}
                        >
                          <DownloadIcon width={17} height={17} />
                        </button>
                        <button
                          className="iconaction iconaction--danger"
                          aria-label="Delete"
                          title="Delete file"
                          onClick={() => handleDelete(s)}
                        >
                          <TrashIcon width={17} height={17} />
                        </button>
                      </div>

                      <div className="rowbtns">
                        {/* Open Workflow — hidden for now (re-enable later). */}
                        {/* <button
                          className="btn btn--ghost btn--mini"
                          onClick={() => onOpenWorkflow?.(s)}
                          title="Open this file in the workflow builder"
                        >
                          <WorkflowIcon width={15} height={15} /> Open Workflow
                        </button> */}
                        <button
                          className="btn btn--open"
                          onClick={() => {
                            if (isTagged) {
                              // Tagged or completed → review page loads tags directly, no
                              // WS run. (Completed: "Create Dashboard" there hits the cache.)
                              onOpenReview?.(s)
                            } else {
                              // Not tagged yet → review page runs the tagging WebSocket.
                              onOpenReview?.(s, { runTagging: true })
                            }
                          }}
                        >
                          <DashboardIcon width={15} height={15} />
                          {isCompleted ? 'Open dashboards' : 'Generate dashboards'}
                          <ArrowRightIcon width={15} height={15} />
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {isQuery && open && (
                  <div className="qexpand">
                    {groups.length === 0 && (
                      <span className="muted">No queries recorded for this entry.</span>
                    )}
                    {groups.map((g, gi) => (
                      <div className="qgroup" key={g.label || gi}>
                        {g.label && <div className="qgroup__label">{g.label}</div>}
                        <div className="qgroup__items">
                          {(g.queries || []).map((q, qi) => (
                            <span className="qchip" key={qi}>{q}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                </div>
              )
            })}
              </div>
              )
            })}
          </div>
        )}
      </section>

      <UploadModal
        open={uploadOpen}
        projectId={project.id}
        onClose={() => setUploadOpen(false)}
        onUploaded={async (result) => {
          setUploadOpen(false)
          // Jump straight into the review screen for the new session (workflow
          // redirect disabled for now). A fresh upload isn't tagged yet, so open
          // review with runTagging so the tagging agent runs.
          if (result?.session_id) {
            try {
              const session = await getSession(result.session_id)
              onOpenReview?.(session, { runTagging: true })
              return
            } catch {
              /* fall back to refreshing the list */
            }
          }
          load()
        }}
      />

      <ProjectKeywordsModal
        open={keywordsOpen}
        project={{ ...project, ...keywords }}
        saving={keywordsSaving}
        showCancel
        onClose={() => setKeywordsOpen(false)}
        onSave={saveKeywords}
      />

      <SectionPromptModal
        open={sectionOpen}
        initialValue={sectionPrompt}
        saving={sectionSaving}
        onClose={() => setSectionOpen(false)}
        onSave={saveSectionPrompt}
      />

      <RelevancyPromptModal
        open={relevancyOpen}
        initialValue={relevancyPrompt}
        saving={relevancySaving}
        onClose={() => setRelevancyOpen(false)}
        onSave={saveRelevancyPrompt}
      />

      <RunWindowModal
        open={!!runFor}
        query={runFor}
        running={runningId === runFor?.id}
        onClose={() => setRunFor(null)}
        onRun={handleRunQuery}
      />

      <ConfirmModal
        open={!!deleteOnedriveFor}
        danger
        busy={deletingOnedrive}
        title={`Delete “${deleteOnedriveFor?.file_name || ''}”?`}
        body={
          `This also removes the ${deleteOnedriveFor?.article_count === 1 ? '1 article' : `${deleteOnedriveFor?.article_count || 0} articles`} ` +
          'it brought into the project pool, including any review edits and approvals ' +
          'made against them.\n\nThis cannot be undone.'
        }
        confirmLabel="Delete file and articles"
        onClose={() => setDeleteOnedriveFor(null)}
        onConfirm={confirmDeleteOnedrive}
      />

      <ScheduleModal
        open={!!scheduleFor}
        query={scheduleFor}
        saving={scheduleSaving}
        onClose={() => setScheduleFor(null)}
        onSave={saveSchedule}
        onUnschedule={unschedule}
      />

      <GeneratedQueryEditModal
        open={!!editQuery}
        query={editQuery}
        saving={editSaving}
        onClose={() => setEditQuery(null)}
        onSave={saveQueryEdits}
      />

      <RenameFileModal
        open={!!renameFor}
        initialName={renameFor?._name || ''}
        saving={renameSaving}
        onClose={() => setRenameFor(null)}
        onSave={saveRename}
      />

      {tab === 'auto' && <QueryBuilderDock projectId={project.id} onSaved={() => load()} />}
    </>
  )
}

function Checkbox({ checked, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`checkbox${checked ? ' checkbox--on' : ''}`}
      onClick={onChange}
    >
      {checked && <CheckIcon width={13} height={13} />}
    </button>
  )
}

function TableSkeleton() {
  return (
    <div className="tbl">
      {Array.from({ length: 6 }).map((_, i) => (
        <div className="trow trow--body" key={i}>
          <div className="sk" style={{ width: 20, height: 20, borderRadius: 6 }} />
          <div className="cellfile">
            <div className="sk sk--tile" style={{ width: 38, height: 38, margin: 0 }} />
            <div className="sk sk--line sk--w60" style={{ margin: 0 }} />
          </div>
          <div className="sk sk--line sk--w40" style={{ margin: 0 }} />
          <div className="sk sk--line sk--w40" style={{ margin: 0 }} />
          <div className="sk sk--line sk--w30" style={{ margin: 0 }} />
          <div />
          <div />
        </div>
      ))}
    </div>
  )
}

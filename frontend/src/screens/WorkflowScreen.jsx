import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  ReactFlowProvider,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { nodeTypes } from '../workflow/nodes.jsx'
import ConfigPanel from '../workflow/panels.jsx'
import ReviewScreen, { MONITORING_COLUMNS, DASHBOARD_COLUMNS } from './ReviewScreen.jsx'
import { MODULES, defaultNodeData, isSerialConnection, NODE_ORDER } from '../workflow/constants.js'
import { MODULE_ICON, BriefIcon, PlayIcon, SparklesIcon, CopyIcon } from '../workflow/wfIcons.jsx'
import { ArrowLeftIcon, MoonIcon, SunIcon, CloseIcon, SendIcon, RefreshIcon } from '../components/Icons.jsx'
import { saveWorkflow, getSession } from '../api/sessions.js'
import { taggingWsUrl } from '../api/tagging.js'
import { chartsWsUrl } from '../api/charts.js'
import { prettyFileName } from '../utils/files.js'

const DND_MIME = 'application/x-iv-module'
let idSeq = 1
const nextId = (type) => `${type}_${idSeq++}`

// Idle state for the WebSocket "job" — tagging or charts (mirrors the Review page).
const IDLE_JOB = {
  kind: null, // 'tagging' | 'charts'
  active: false,
  phase: 'idle', // idle | connecting | running | complete | error
  messages: [],
  progress: { done: 0, total: 0 },
  totalArticles: 0,
  errorMsg: '',
  relevancyUsage: null, // { input_tokens, output_tokens, cost_usd } once the relevancy gate finishes
  taggingUsage: null,   // running cumulative total across tagging batches so far
}

// "1,234 tok · $0.0041"
const fmtUsage = (u) => `${(u.input_tokens + u.output_tokens).toLocaleString()} tok · $${u.cost_usd.toFixed(4)}`

// The default seed: a single Data node pre-filled from the uploaded file.
function seedNodes(session, project) {
  return [
    {
      id: 'data_0',
      type: 'data',
      position: { x: 80, y: 220 },
      deletable: false, // the fixed Data node can't be removed (incl. via keyboard)
      data: defaultNodeData('data', {
        file: session?.name || '',
        brandKeywords: project?.brand_keywords || [],
        sourceType: 'file',
      }),
    },
  ]
}

// Rehydrate a saved graph (plain JSON) into reactflow nodes/edges. Callbacks
// (onDelete / onTagged / …) are re-attached separately once the handlers exist.
function restoreNodes(workflow) {
  return (workflow.nodes || []).map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position || { x: 0, y: 0 },
    deletable: n.type !== 'data',
    data: { ...(n.data || {}) },
  }))
}
function restoreEdges(workflow) {
  return (workflow.edges || []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    ...(e.invalid ? INVALID_EDGE : VALID_EDGE),
  }))
}
// Keep the id counter ahead of any restored node ids so new drops don't collide.
function bumpIdSeq(nodes) {
  let max = 0
  nodes.forEach((n) => {
    const m = /_(\d+)$/.exec(n.id || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  })
  idSeq = Math.max(idSeq, max + 1)
}
function hasSavedGraph(workflow) {
  return !!(workflow && Array.isArray(workflow.nodes) && workflow.nodes.length)
}

// Strip the runtime-only callbacks/flags from node data so the graph is plain
// JSON, and keep only the structural fields of each edge.
function serializeWorkflow(nodes, edges) {
  return {
    nodes: nodes.map(({ id, type, position, data }) => {
      // Drop runtime-only callbacks and derived flags (recomputed from live state on load).
      const { onDelete, onTagged, taggedReady, onViewDashboard, dashboardReady, ...rest } = data || {}
      return { id, type, position, data: rest }
    }),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle, className }) => ({
      id, source, target, sourceHandle, targetHandle,
      invalid: className === 'wfedge--invalid',
    })),
  }
}

const MM_LENS = 'media_monitoring'
// Columns shown in the Review popup. A Review fed by a Media Monitoring analysis
// gets a trimmed set plus the editable relation columns; every other lens gets
// the full set minus Section / Section Confidence.
const MM_REVIEW_COLUMNS = MONITORING_COLUMNS
const OTHER_REVIEW_COLUMNS = DASHBOARD_COLUMNS
const INVALID_EDGE = { animated: false, className: 'wfedge--invalid', style: { stroke: '#e5484d', strokeWidth: 2 } }
const VALID_EDGE = { animated: true, className: undefined, style: undefined }

// Validate one Analysis→Review connection against the Media Monitoring rule:
// a Review fed by a Media Monitoring analysis is dedicated to it — no other
// analysis (any lens) may share that Review. `siblingAnalyses` are the other
// analysis nodes already feeding the same Review.
function reviewExclusivityOk(sourceNode, siblingAnalyses) {
  const involvesMM =
    sourceNode.data?.lens === MM_LENS || siblingAnalyses.some((n) => n.data?.lens === MM_LENS)
  return !(involvesMM && siblingAnalyses.length > 0)
}

// Decide whether an edge is valid given the current nodes/edges.
function isEdgeValid(edge, byId, allEdges) {
  const src = byId.get(edge.source)
  const tgt = byId.get(edge.target)
  if (!src || !tgt || !isSerialConnection(src.type, tgt.type)) return false
  if (src.type === 'analysis' && tgt.type === 'review') {
    const siblings = allEdges
      .filter((e) => e.id !== edge.id && e.target === tgt.id)
      .map((e) => byId.get(e.source))
      .filter((n) => n && n.type === 'analysis')
    if (!reviewExclusivityOk(src, siblings)) return false
  }
  return true
}

// Restyle every edge to reflect its current validity (red when invalid).
function markEdges(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return edges.map((e) => ({ ...e, ...(isEdgeValid(e, byId, edges) ? VALID_EDGE : INVALID_EDGE) }))
}

function WorkflowCanvas({ project, session, theme, onToggleTheme, onBack, onOpenReview }) {
  const wrapperRef = useRef(null)
  const { screenToFlowPosition, fitView } = useReactFlow()

  // Seed from the saved workflow if the session already has one, else the default
  // single Data node. (A fresh fetch on mount refreshes a possibly-stale prop.)
  const [nodes, setNodes, onNodesChange] = useNodesState(() => {
    if (hasSavedGraph(session?.workflow)) {
      const restored = restoreNodes(session.workflow)
      bumpIdSeq(restored)
      return restored
    }
    return seedNodes(session, project)
  })
  const [edges, setEdges, onEdgesChange] = useEdgesState(() =>
    hasSavedGraph(session?.workflow) ? restoreEdges(session.workflow) : [],
  )
  const [selectedId, setSelectedId] = useState(null)
  const [reviewNodeId, setReviewNodeId] = useState(null) // Review node whose popup is open
  const [toast, setToast] = useState('')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [job, setJob] = useState(IDLE_JOB) // tagging WebSocket progress
  const [saving, setSaving] = useState(false)
  // Live session status (the prop can be stale); refreshed on mount and updated
  // when tagging/charts complete. Drives the Review node's "Tagged Data" button.
  const [liveStatus, setLiveStatus] = useState(session?.status || '')
  const wsRef = useRef(null)

  const flash = useCallback((msg) => {
    setToast(msg)
    window.clearTimeout(flash._t)
    flash._t = window.setTimeout(() => setToast(''), 2600)
  }, [])

  // Open a WebSocket (tagging or charts) and stream progress into `job` — same
  // protocol the Review page uses: start / batch / progress / complete / error.
  const runJob = useCallback(
    (kind, url, onDone) => {
      try {
        wsRef.current?.close()
      } catch {
        /* already closed */
      }
      setJob({ ...IDLE_JOB, kind, active: true, phase: 'connecting' })
      const push = (text) => setJob((j) => ({ ...j, messages: [...j.messages, text] }))
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setJob((j) => ({ ...j, phase: 'running' }))
        push(kind === 'charts' ? 'Connected — Building Dashboards' : 'Connected — Starting Tagging Agent')
        ws.send(JSON.stringify({ session_id: session.id }))
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
          case 'batch':
            setJob((j) => ({
              ...j,
              progress: { done: msg.completed_batches || 0, total: msg.total_batches || 0 },
              taggingUsage: msg.usage || j.taggingUsage,
            }))
            push(
              `Batch ${(msg.batch_index ?? 0) + 1} done — ${msg.completed_batches}/${msg.total_batches} batches (${msg.tagged_count} tagged)`
              + (msg.usage ? ` · ${fmtUsage(msg.usage)}` : ''),
            )
            break
          case 'progress':
            push(msg.message || 'Working…')
            break
          case 'usage':
            // One-shot usage report for a non-batched LLM step (currently just
            // the relevancy gate) — tagging's own usage streams via 'batch' above.
            setJob((j) => (msg.step === 'relevancy' ? { ...j, relevancyUsage: msg } : j))
            push(`${msg.step === 'relevancy' ? 'Relevancy check' : msg.step}: ${fmtUsage(msg)}`)
            break
          case 'complete':
            setJob((j) => ({
              ...j,
              phase: 'complete',
              progress: { done: j.progress.total || j.progress.done, total: j.progress.total || j.progress.done },
            }))
            push(
              (kind === 'charts'
                ? `Dashboards ready${msg.elapsed_seconds ? ` in ${msg.elapsed_seconds}s` : ''}.`
                : `Completed ${msg.total_tagged} articles in ${msg.elapsed_seconds}s.`)
              + (msg.usage ? ` · ${fmtUsage(msg.usage)}` : ''),
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
    [session.id],
  )

  const startTagging = useCallback(
    () => runJob('tagging', taggingWsUrl(), () => setLiveStatus('Tagged')),
    [runJob],
  )
  const startCharts = useCallback(
    () =>
      runJob('charts', chartsWsUrl(), () => {
        setLiveStatus('Completed')
        flash('Dashboards generated.')
      }),
    [runJob, flash],
  )

  // Open the dashboards page in a new tab via its real URL — the new tab loads
  // the project/session/charts by the ids in the path.
  const openDashboards = useCallback(() => {
    window.open(
      `${window.location.origin}/${project?.id}/sessions/${session?.id}/dashboards`,
      '_blank',
      'noopener',
    )
  }, [project, session])

  // Dashboards are ready once the charts job completes (this run) or the session
  // is already Completed. Reflect that as a "View Dashboard" button on Output nodes.
  const dashboardsReady =
    (job.kind === 'charts' && job.phase === 'complete') ||
    (liveStatus || '').toLowerCase() === 'completed'

  useEffect(() => {
    setNodes((nds) => {
      let changed = false
      const next = nds.map((n) => {
        if (n.type !== 'output') return n
        const hasCb = !!n.data.onViewDashboard
        if (!!n.data.dashboardReady === dashboardsReady && (!dashboardsReady || hasCb)) return n
        changed = true
        return {
          ...n,
          data: { ...n.data, dashboardReady: dashboardsReady, onViewDashboard: dashboardsReady ? openDashboards : undefined },
        }
      })
      return changed ? next : nds
    })
    // `nodes` is included so the button is re-attached after the canvas is
    // replaced on restore (when dashboardsReady didn't change on its own).
  }, [dashboardsReady, openDashboards, nodes, setNodes])

  // Save Workflow: persist the graph only — no tagging/charts WebSocket.
  const handleSaveWorkflow = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      await saveWorkflow(session.id, serializeWorkflow(nodes, edges))
      flash('Workflow saved.')
    } catch (err) {
      flash(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }, [saving, session.id, nodes, edges, flash])

  // Save & Tag: persist the workflow graph, then kick off tagging.
  const handleSaveAndTag = useCallback(async () => {
    if (saving || job.active) return
    setSaving(true)
    try {
      await saveWorkflow(session.id, serializeWorkflow(nodes, edges))
      flash('Workflow saved — tagging…')
      startTagging()
    } catch (err) {
      flash(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }, [saving, job.active, session.id, nodes, edges, startTagging, flash])

  // Close the socket if the screen unmounts mid-run.
  useEffect(() => () => {
    try {
      wsRef.current?.close()
    } catch {
      /* already closed */
    }
  }, [])

  // Edges are allowed regardless of order, but a link that breaks the pipeline
  // is flagged red so the problem is visible:
  //  - out-of-sequence (e.g. Data → Review), or
  //  - sharing a Media Monitoring analysis's Review with another analysis.
  const onConnect = useCallback(
    (params) => {
      const src = nodes.find((n) => n.id === params.source)
      const tgt = nodes.find((n) => n.id === params.target)
      let reason = null
      if (!(src && tgt && isSerialConnection(src.type, tgt.type))) {
        reason = 'Nodes must connect in order: Data → Analysis → Review → Assembly → Output.'
      } else if (src.type === 'analysis' && tgt.type === 'review') {
        const siblings = edges
          .filter((e) => e.target === tgt.id)
          .map((e) => nodes.find((n) => n.id === e.source))
          .filter((n) => n && n.type === 'analysis')
        if (!reviewExclusivityOk(src, siblings)) {
          reason = 'A Media Monitoring analysis needs its own Review node — no other analysis can share it.'
        }
      }
      setEdges((eds) => markEdges(nodes, addEdge({ ...params }, eds)))
      if (reason) flash(reason)
    },
    [nodes, edges, setEdges, flash],
  )

  // Re-validate edges whenever nodes change (e.g. a lens is switched to/from
  // Media Monitoring), recoloring any that become valid/invalid.
  useEffect(() => {
    setEdges((eds) => {
      const marked = markEdges(nodes, eds)
      const changed = marked.some((m, i) => m.className !== eds[i].className)
      return changed ? marked : eds
    })
  }, [nodes, setEdges])

  // Auto-format: arrange nodes into pipeline columns (Data → Analysis → Review →
  // Assembly → Output), stacking same-type nodes vertically and centering columns.
  const autoLayout = useCallback(() => {
    const COL_W = 320
    const ROW_H = 210
    const X0 = 60
    const Y0 = 40
    setNodes((nds) => {
      const byType = new Map(NODE_ORDER.map((t) => [t, []]))
      nds.forEach((n) => {
        if (byType.has(n.type)) byType.get(n.type).push(n)
      })
      const maxCount = Math.max(1, ...[...byType.values()].map((a) => a.length))
      return nds.map((n) => {
        const col = NODE_ORDER.indexOf(n.type)
        if (col < 0) return n
        const arr = byType.get(n.type)
        const idx = arr.indexOf(n)
        const startY = Y0 + ((maxCount - arr.length) * ROW_H) / 2
        return { ...n, position: { x: X0 + col * COL_W, y: startY + idx * ROW_H } }
      })
    })
    // Refit once the new positions have applied.
    window.setTimeout(() => {
      try {
        fitView({ padding: 0.2, duration: 400 })
      } catch {
        /* view not ready */
      }
    }, 60)
  }, [setNodes, fitView])

  const deleteNode = useCallback(
    (id) => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      setSelectedId((cur) => (cur === id ? null : cur))
    },
    [setNodes, setEdges],
  )

  // Re-attach the runtime callbacks/flags that aren't persisted (so restored
  // nodes are interactive) and keep the Review node's taggedReady in sync with
  // the live session status. Idempotent — only patches what changed.
  useEffect(() => {
    const taggedReady = ['tagged', 'completed'].includes((liveStatus || '').toLowerCase())
    setNodes((nds) => {
      let changed = false
      const next = nds.map((n) => {
        const patch = {}
        if (n.type !== 'data' && !n.data.onDelete) patch.onDelete = () => deleteNode(n.id)
        if (n.type === 'review') {
          if (!n.data.onTagged) patch.onTagged = () => setReviewNodeId(n.id)
          if (n.data.taggedReady !== taggedReady) patch.taggedReady = taggedReady
        }
        if (Object.keys(patch).length === 0) return n
        changed = true
        return { ...n, data: { ...n.data, ...patch } }
      })
      return changed ? next : nds
    })
  }, [nodes, deleteNode, liveStatus, setNodes])

  // On mount, refresh the live status + latest saved workflow (the session prop
  // in sessionStorage can predate the last save/tagging run).
  useEffect(() => {
    let cancelled = false
    getSession(session.id)
      .then((fresh) => {
        if (cancelled || !fresh) return
        if (fresh.status) setLiveStatus(fresh.status)
        if (hasSavedGraph(fresh.workflow)) {
          const restored = restoreNodes(fresh.workflow)
          bumpIdSeq(restored)
          setNodes(restored)
          setEdges(restoreEdges(fresh.workflow))
        }
      })
      .catch(() => {
        /* keep whatever was seeded */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Attach the static per-node flags that depend on the session.
  const withCallbacks = useCallback(
    (type, data) => {
      if (type === 'review') {
        const status = (liveStatus || '').toLowerCase()
        const taggedReady = status === 'tagged' || status === 'completed'
        return { ...data, taggedReady }
      }
      return data
    },
    [liveStatus],
  )

  const onDrop = useCallback(
    (event) => {
      event.preventDefault()
      const type = event.dataTransfer.getData(DND_MIME)
      if (!type) return
      // Exactly one Data node per workflow — the one seeded from the file.
      if (type === 'data') {
        flash('A workflow can only have one Data node.')
        return
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const id = nextId(type)
      let extra = {}
      if (type === 'output') extra = { label: project?.name || 'Output' }
      else if (type === 'analysis') extra = { competitorKeywords: project?.competitor_keywords || [] }
      const data = withCallbacks(type, defaultNodeData(type, extra))
      data.onDelete = () => deleteNode(id) // every dropped node is removable
      if (type === 'review') data.onTagged = () => setReviewNodeId(id) // open the Review popup
      setNodes((nds) => nds.concat({ id, type, position, data }))
      setSelectedId(id)
    },
    [screenToFlowPosition, setNodes, withCallbacks, project, session, flash, deleteNode],
  )

  const onDragOver = useCallback((event) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const updateNodeData = useCallback(
    (patch) => {
      if (!selectedId) return
      setNodes((nds) => nds.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)))
    },
    [selectedId, setNodes],
  )

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId])

  // Columns for the open Review popup: a Review fed by a Media Monitoring
  // analysis shows the trimmed column set; otherwise the full table.
  const reviewFedByMM = useMemo(() => {
    if (!reviewNodeId) return false
    const feeders = new Set(edges.filter((e) => e.target === reviewNodeId).map((e) => e.source))
    return nodes.some((n) => feeders.has(n.id) && n.type === 'analysis' && n.data?.lens === MM_LENS)
  }, [reviewNodeId, edges, nodes])
  const reviewColumns = reviewFedByMM ? MM_REVIEW_COLUMNS : OTHER_REVIEW_COLUMNS

  // Tagging progress bar: percent from batch counts, indeterminate until known.
  const jobPct = job.phase === 'complete'
    ? 100
    : job.progress.total
    ? Math.round((job.progress.done / job.progress.total) * 100)
    : 0
  const jobIndeterminate = job.phase === 'running' && job.progress.total === 0

  // Show "Generate Dashboards" once tagging finishes (this run) or when the
  // session is already tagged/completed; otherwise show "Save and Run Tagging Agent".
  const sessionTagged = ['tagged', 'completed'].includes((liveStatus || '').toLowerCase())
  const tagJustCompleted = job.kind === 'tagging' && job.phase === 'complete'
  const showDashboards = sessionTagged || tagJustCompleted
  const chartsRunning = job.kind === 'charts' && job.active && job.phase !== 'complete' && job.phase !== 'error'

  function onSidebarDragStart(event, type) {
    event.dataTransfer.setData(DND_MIME, type)
    event.dataTransfer.effectAllowed = 'move'
  }

  const minimapColor = (n) => MINIMAP_COLORS[n.type] || '#94a3b8'

  return (
    <div className="wfroot">
      {/* ---- top bar ---- */}
      <header className="wftop">
        <div className="wftop__left">
          <button className="wfic" onClick={onBack} aria-label="Back"><ArrowLeftIcon width={18} height={18} /></button>
          <SparklesIcon width={18} height={18} />
          <span className="wftop__name">{project?.name || 'Workflow'}</span>
        </div>
        <div className="wftop__right">
          <button className="wfbtn" onClick={handleSaveWorkflow} disabled={saving || job.active}>
            <BriefIcon width={16} height={16} /> Save Workflow
          </button>
          {showDashboards ? (
            <button className="wfbtn wfbtn--run" onClick={startCharts} disabled={chartsRunning}>
              <PlayIcon width={16} height={16} /> {chartsRunning ? 'Generating…' : 'Generate Dashboards'}
            </button>
          ) : (
            <button className="wfbtn wfbtn--run" onClick={handleSaveAndTag} disabled={saving || job.active}>
              <PlayIcon width={16} height={16} /> {saving ? 'Saving…' : 'Save and Run Tagging Agent'}
            </button>
          )}
          <button className="wfic" onClick={onToggleTheme} aria-label="Toggle theme">
            {theme === 'light' ? <MoonIcon width={18} height={18} /> : <SunIcon width={18} height={18} />}
          </button>
        </div>
      </header>

      <div className="wfmain">
        {/* ---- modules sidebar ---- */}
        <aside className="wfside">
          <p className="wfside__kicker">MODULES</p>
          <div className="wfside__list">
            {MODULES.map((m) => {
              const Icon = MODULE_ICON[m.type]
              // The Data node is fixed (one per workflow) — added by default, not draggable.
              const locked = m.type === 'data'
              return (
                <div
                  key={m.type}
                  className={`wfmod wfmod--${m.type}${locked ? ' wfmod--locked' : ''}`}
                  draggable={!locked}
                  onDragStart={locked ? undefined : (e) => onSidebarDragStart(e, m.type)}
                  title={locked ? 'Added by default — one Data node per workflow' : m.hint}
                >
                  <span className="wfmod__icon"><Icon width={16} height={16} /></span>
                  {m.label}
                  {locked && <span className="wfmod__tag">Added</span>}
                </div>
              )
            })}
          </div>
          <p className="wfside__hint">Drag modules onto the canvas, then connect them with edges.</p>
          <div className="wfside__card">
            <span className="wfside__cardtitle">{project?.name || 'Workflow'}</span>
            <button
              className="wfic wfic--sm"
              aria-label="Copy workflow name"
              onClick={() => { navigator.clipboard?.writeText(project?.name || ''); flash('Name copied.') }}
            >
              <CopyIcon width={14} height={14} />
            </button>
          </div>
          <div className="wfside__file" title={session?.name}>
            {session?.name ? prettyFileName(session.name) : 'No file attached'}
          </div>
        </aside>

        {/* ---- canvas ---- */}
        <div className="wfcanvas" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={['Delete', 'Backspace']}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            defaultEdgeOptions={{ animated: true }}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={18} size={1.4} color="var(--wf-dot)" />
            <Controls showInteractive>
              <ControlButton onClick={autoLayout} title="Auto format layout" aria-label="Auto format layout">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="6" height="16" rx="1" />
                  <rect x="10.5" y="8" width="6" height="8" rx="1" />
                  <rect x="18" y="6" width="3" height="12" rx="1" />
                </svg>
              </ControlButton>
            </Controls>
            <MiniMap pannable zoomable nodeColor={minimapColor} nodeStrokeWidth={2} />
          </ReactFlow>

          <button className="wfassist" onClick={() => setAssistantOpen((o) => !o)}>
            <SparklesIcon width={16} height={16} /> Workflow Assistant
          </button>

          {job.active && (
            <div className="wflog">
              <section className={`tagpanel${job.phase === 'error' ? ' tagpanel--error' : ''}`}>
                <div className="tagpanel__head">
                  <h2 className="tagpanel__title">
                    {job.kind === 'charts'
                      ? job.phase === 'error'
                        ? 'Dashboards Generation Agent Failed'
                        : job.phase === 'complete'
                        ? 'Dashboards Generation Agent Complete'
                        : 'Dashboards Generation Agent Start'
                      : job.phase === 'error'
                      ? 'Tagging Agent Failed'
                      : job.phase === 'complete'
                      ? `Tagging Agent Complete${job.totalArticles ? ` · ${job.totalArticles} articles` : ''}`
                      : `Tagging Agent Start${job.totalArticles ? ` · ${job.totalArticles} articles` : ''}`}
                  </h2>
                  <div className="wflog__head-right">
                    {job.progress.total > 0 && job.phase !== 'error' && (
                      <span className="tagpanel__count">{job.progress.done}/{job.progress.total} · {jobPct}%</span>
                    )}
                    {(job.relevancyUsage || job.taggingUsage) && job.phase !== 'error' && (
                      <span className="tagpanel__usage">
                        {fmtUsage({
                          input_tokens: (job.relevancyUsage?.input_tokens || 0) + (job.taggingUsage?.input_tokens || 0),
                          output_tokens: (job.relevancyUsage?.output_tokens || 0) + (job.taggingUsage?.output_tokens || 0),
                          cost_usd: (job.relevancyUsage?.cost_usd || 0) + (job.taggingUsage?.cost_usd || 0),
                        })}
                      </span>
                    )}
                    <button
                      className="wfic wfic--sm"
                      onClick={() => {
                        try {
                          wsRef.current?.close()
                        } catch {
                          /* already closed */
                        }
                        setJob(IDLE_JOB)
                      }}
                      aria-label="Dismiss logs"
                    >
                      <CloseIcon width={16} height={16} />
                    </button>
                  </div>
                </div>
                {job.phase !== 'error' && (
                  <div className={`progress${jobIndeterminate ? ' progress--indeterminate' : ''}`}>
                    <div className="progress__bar" style={{ width: jobIndeterminate ? '40%' : `${jobPct}%` }} />
                  </div>
                )}
                <div className="log">
                  {job.messages.map((m, i) => (
                    <div className="log__line" key={i}>{m}</div>
                  ))}
                </div>
                {job.phase === 'error' && (
                  <div className="tagpanel__actions">
                    <button className="btn btn--primary" onClick={job.kind === 'charts' ? startCharts : startTagging}>
                      <RefreshIcon width={16} height={16} /> Retry
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}

          {toast && <div className="wftoast">{toast}</div>}
        </div>

        {/* ---- inspector ---- */}
        <ConfigPanel node={selectedNode} onChange={updateNodeData} />
      </div>

      {assistantOpen && (
        <div className="wfchat">
          <div className="wfchat__head">
            <span><SparklesIcon width={16} height={16} /> Workflow Assistant</span>
            <button className="wfic wfic--sm" onClick={() => setAssistantOpen(false)} aria-label="Close">
              <CloseIcon width={16} height={16} />
            </button>
          </div>
          <div className="wfchat__body">
            <p className="wfchat__msg">
              Hi! Describe what you want this workflow to do and I can suggest modules to add.
              (Assistant responses are a preview in this build.)
            </p>
          </div>
          <div className="wfchat__input">
            <input className="wfinput" placeholder="Ask the assistant…" disabled />
            <button className="wfic wfic--sm" disabled aria-label="Send"><SendIcon width={16} height={16} /></button>
          </div>
        </div>
      )}

      {reviewNodeId && (
        <ReviewScreen
          asModal
          project={project}
          session={session}
          runTagging={false}
          columns={reviewColumns}
          relationEditable={reviewFedByMM}
          approvalField={reviewFedByMM ? 'is_approved_for_monitoring' : 'is_approved'}
          onClose={() => setReviewNodeId(null)}
          onBack={() => setReviewNodeId(null)}
          onCreated={() => setReviewNodeId(null)}
        />
      )}
    </div>
  )
}

const MINIMAP_COLORS = {
  data: '#7c3aed',
  analysis: '#2563eb',
  review: '#db2777',
  assembly: '#d97706',
  output: '#059669',
}

export default function WorkflowScreen(props) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas {...props} />
    </ReactFlowProvider>
  )
}

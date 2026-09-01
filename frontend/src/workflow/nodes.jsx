import { Handle, Position } from 'reactflow'
import { lensLabel, llmModel, CHART_OPTIONS } from './constants.js'
import { MODULE_ICON, TableIcon } from './wfIcons.jsx'
import { TrashIcon } from '../components/Icons.jsx'
import { prettyFileName } from '../utils/files.js'

// Card chrome shared by every node. `kind` drives the accent + header icon.
// `onDelete` (absent on the fixed Data node) renders a delete button.
function NodeShell({ kind, title, selected, children, onDelete, inHandle = true, outHandle = true }) {
  const Icon = MODULE_ICON[kind]
  return (
    <div className={`wfnode wfnode--${kind}${selected ? ' wfnode--selected' : ''}`}>
      {inHandle && <Handle type="target" position={Position.Left} className="wfhandle" />}
      <div className="wfnode__head">
        <span className="wfnode__icon"><Icon width={14} height={14} /></span>
        <span className="wfnode__kind">{title}</span>
        {onDelete ? (
          <button
            type="button"
            className="wfnode__del nodrag"
            aria-label={`Delete ${title} node`}
            title="Delete node"
            onClick={(e) => { e.stopPropagation(); onDelete() }}
          >
            <TrashIcon width={14} height={14} />
          </button>
        ) : (
          <span className="wfnode__dot" />
        )}
      </div>
      <div className="wfnode__body">{children}</div>
      {outHandle && <Handle type="source" position={Position.Right} className="wfhandle" />}
    </div>
  )
}

export function DataNode({ data, selected }) {
  const name = data.sourceType === 'api' ? (data.apiUrl || 'REST API') : (prettyFileName(data.file) || 'No file')
  return (
    <NodeShell kind="data" title="DATA" selected={selected} inHandle={false}>
      <div className="wfnode__title" title={data.file || data.apiUrl}>{name}</div>
      {data.brandKeywords?.length > 0 && (
        <>
          <div className="wfnode__sub">BRAND KEYWORDS</div>
          <div className="wfnode__pills">
            {data.brandKeywords.map((k) => (
              <span className="pill pill--brand" key={k}>{k}</span>
            ))}
          </div>
        </>
      )}
    </NodeShell>
  )
}

export function AnalysisNode({ data, selected }) {
  const lens = lensLabel(data.lens)
  const model = llmModel(data.llm)
  return (
    <NodeShell kind="analysis" title="ANALYSIS" selected={selected} onDelete={data.onDelete}>
      <div className="wfnode__sub">LENS</div>
      <div className="wfnode__title">{lens || 'Select a lens'}</div>
      <div className="wfnode__muted">{data.skill || 'No skill selected'}</div>
      {data.competitorKeywords?.length > 0 && (
        <>
          <div className="wfnode__sub">COMPETITORS</div>
          <div className="wfnode__pills">
            {data.competitorKeywords.map((k) => (
              <span className="pill pill--comp" key={k}>{k}</span>
            ))}
          </div>
        </>
      )}
      <div className="wfnode__foot">
        <span className="wfnode__gear" />
        {model ? model.label : 'No LLM selected'}
      </div>
    </NodeShell>
  )
}

export function ReviewNode({ data, selected }) {
  return (
    <NodeShell kind="review" title="REVIEW" selected={selected} onDelete={data.onDelete}>
      <div className="wfnode__title wfnode__title--row">
        {data.label || 'Review'}
      </div>
      <Meter label="FLAG" value={data.flag} tone="flag" />
      <Meter label="AUTO" value={data.auto} tone="auto" />
      {data.requiresSignOff && <span className="wfbadge">Requires sign-off</span>}
      <div className="wfnode__muted wfnode__muted--gap">Analyst checkpoint</div>
      <button
        type="button"
        className={`wfnode__tagged nodrag${data.taggedReady ? ' wfnode__tagged--on' : ' wfnode__tagged--off'}`}
        disabled={!data.taggedReady}
        title={data.taggedReady ? 'Open tagged data' : 'Available once the data is tagged'}
        onClick={(e) => {
          e.stopPropagation()
          if (data.taggedReady) data.onTagged?.()
        }}
      >
        <TableIcon width={14} height={14} /> Tagged Data
      </button>
    </NodeShell>
  )
}

function Meter({ label, value, tone }) {
  return (
    <div className="wfmeter">
      <span className="wfmeter__label">{label}</span>
      <span className={`wfmeter__bar wfmeter__bar--${tone}`}>
        <span style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }} />
      </span>
      <span className="wfmeter__val">{value || 0}%</span>
    </div>
  )
}

export function AssemblyNode({ data, selected }) {
  const enabled = (data.charts || []).length
  return (
    <NodeShell kind="assembly" title="ASSEMBLY" selected={selected} onDelete={data.onDelete}>
      <div className="wfnode__title">{data.label || 'Dashboard Builder'}</div>
      <Field k="CLIENT NAME" v={data.clientName || '—'} />
      <Field k="CHARTS" v={`${enabled} of ${CHART_OPTIONS.length} enabled`} />
      <Field k="LAYOUT" v={data.layout || 'Standard'} />
      <div className="wfnode__muted wfnode__muted--gap">Aggregates enriched rows</div>
    </NodeShell>
  )
}

function Field({ k, v }) {
  return (
    <div className="wffield">
      <span className="wffield__k">{k}</span>
      <span className="wffield__v">{v}</span>
    </div>
  )
}

export function OutputNode({ data, selected }) {
  return (
    <NodeShell kind="output" title="OUTPUT" selected={selected} onDelete={data.onDelete} outHandle={false}>
      <div className="wfnode__title">{data.label || 'Output'}</div>
      <div className="wfnode__muted">{data.format || 'Dashboard'}</div>
      {data.dashboardReady && (
        <button
          type="button"
          className="wfnode__tagged wfnode__tagged--on nodrag"
          title="Open dashboards in a new tab"
          onClick={(e) => {
            e.stopPropagation()
            data.onViewDashboard?.()
          }}
        >
          <TableIcon width={14} height={14} /> View Dashboard
        </button>
      )}
    </NodeShell>
  )
}

export const nodeTypes = {
  data: DataNode,
  analysis: AnalysisNode,
  review: ReviewNode,
  assembly: AssemblyNode,
  output: OutputNode,
}

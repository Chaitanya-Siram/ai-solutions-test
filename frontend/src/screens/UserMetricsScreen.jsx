import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, BarChart, Bar, Cell,
} from 'recharts'
import { ArrowLeftIcon } from '../components/Icons.jsx'
import { paths } from '../router/nav.js'
import {
  getMetricsSummary, getMetricsDaily, getMetricsAgents,
  getMetricsModels, getMetricsSessions, getSessionDetail,
} from '../api/metrics.js'

const AGENT_COUNT = 7

const PRESET_RANGES = [
  { label: '7d',  days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

const AGENT_LABELS = {
  relevancy_agent: 'Relevancy Agent',
  tagging_agent: 'Tagging Agent',
  query_builder: 'Query Builder',
  chart_agent: 'Chart Agent',
  otsuka_report_agent: 'Otsuka Report Agent',
  section_fetcher: 'Section Fetcher',
  relevancy_domain_extractor: 'Relevancy Domain Extractor',
}

const CHART_COLORS = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#e0e7ff', '#eef2ff']

function fmt(n) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function fmtCost(n) {
  if (n == null || n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(4)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtShortDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function SummaryCard({ label, value, sub }) {
  return (
    <div className="dash-summary-card">
      <div className="dash-summary-card__label">{label}</div>
      <div className="dash-summary-card__value">{value}</div>
      {sub && <div className="dash-summary-card__sub">{sub}</div>}
    </div>
  )
}

function SectionHead({ title, sub }) {
  return (
    <div className="dash-section-head">
      <h2 className="dash-section-head__title">{title}</h2>
      {sub && <p className="dash-section-head__sub">{sub}</p>}
    </div>
  )
}

function DateFilter({ preset, onPreset, startDate, endDate, onStartDate, onEndDate }) {
  return (
    <div className="dash-filter">
      <div className="dash-filter__presets">
        {PRESET_RANGES.map((r) => (
          <button
            key={r.label}
            className={`dash-filter__preset${preset === r.label ? ' dash-filter__preset--on' : ''}`}
            onClick={() => onPreset(r)}
          >
            {r.label}
          </button>
        ))}
        <button
          className={`dash-filter__preset${preset === 'custom' ? ' dash-filter__preset--on' : ''}`}
          onClick={() => onPreset({ label: 'custom', days: null })}
        >
          Custom
        </button>
      </div>
      {preset === 'custom' && (
        <div className="dash-filter__custom">
          <label>From <input type="date" value={startDate} onChange={e => onStartDate(e.target.value)} /></label>
          <label>To <input type="date" value={endDate} onChange={e => onEndDate(e.target.value)} /></label>
        </div>
      )}
    </div>
  )
}

function AgentRow({ agent }) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    if (!expanded && !detail) {
      setLoading(true)
      try {
        const data = await getSessionDetail(agent.session_id)
        setDetail(data)
      } catch (_) {
        setDetail([])
      } finally {
        setLoading(false)
      }
    }
    setExpanded((v) => !v)
  }

  const total = (agent.total_input_tokens || 0) + (agent.total_output_tokens || 0)

  return (
    <>
      <tr className="session-row" onClick={toggle} style={{ cursor: 'pointer' }}>
        <td><span className="usercell__name">{agent.session_name || `Session #${agent.session_id}`}</span></td>
        <td>{agent.project_name || '—'}</td>
        <td>{fmtDate(agent.created_at)}</td>
        <td><span className={`tag ${agent.status === 'Tagged' ? 'tag--active' : 'tag--muted'}`}>{agent.status || 'Unknown'}</span></td>
        <td>{fmt(total)}</td>
        <td>{fmtCost(agent.total_cost_usd)}</td>
        <td>{expanded ? '▲' : '▼'}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ padding: '0 0 8px 24px', background: 'var(--surface-2)' }}>
            {loading && <p style={{ padding: '8px', color: 'var(--text-soft)' }}>Loading…</p>}
            {!loading && detail && detail.length === 0 && (
              <p style={{ padding: '8px', color: 'var(--text-soft)' }}>No agent breakdown recorded.</p>
            )}
            {!loading && detail && detail.length > 0 && (
              <table className="table" style={{ marginTop: 8, marginBottom: 0 }}>
                <thead>
                  <tr><th>Agent</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost</th></tr>
                </thead>
                <tbody>
                  {detail.map((a, i) => (
                    <tr key={i}>
                      <td><span className="tag tag--muted">{AGENT_LABELS[a.agent_name] || a.agent_name}</span></td>
                      <td>{fmt(a.input_tokens)}</td>
                      <td>{fmt(a.output_tokens)}</td>
                      <td>{fmtCost(a.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

const CustomLineTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="dash-tooltip">
      <div className="dash-tooltip__label">{fmtShortDate(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="dash-tooltip__row" style={{ color: p.color }}>
          <span>{p.name}</span><span>{p.dataKey === 'cost_usd' ? fmtCost(p.value) : fmt(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

const CustomBarTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <div className="dash-tooltip">
      <div className="dash-tooltip__label">{AGENT_LABELS[label] || label}</div>
      <div className="dash-tooltip__row"><span>Tokens</span><span>{fmt(p.value)}</span></div>
    </div>
  )
}

export default function UserMetricsScreen() {
  const navigate = useNavigate()
  const { userId } = useParams()

  const [preset, setPreset] = useState('14d')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const [summary, setSummary] = useState(null)
  const [daily, setDaily] = useState([])
  const [agentTotals, setAgentTotals] = useState([])
  const [modelTotals, setModelTotals] = useState([])
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showFiles, setShowFiles] = useState(false)

  const getDateParams = useCallback(() => {
    if (preset === 'custom') {
      return { start_date: startDate || undefined, end_date: endDate || undefined }
    }
    const days = PRESET_RANGES.find(r => r.label === preset)?.days || 14
    const end = new Date()
    const start = new Date(end - days * 86400_000)
    return {
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
    }
  }, [preset, startDate, endDate])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = getDateParams()
      const days = preset === 'custom'
        ? undefined
        : PRESET_RANGES.find(r => r.label === preset)?.days || 14

      const [s, d, a, m, sess] = await Promise.all([
        getMetricsSummary(params),
        getMetricsDaily({ days, ...params }),
        getMetricsAgents(params),
        getMetricsModels(params),
        getMetricsSessions(),
      ])
      setSummary(s)
      setDaily(d)
      setAgentTotals(a)
      setModelTotals(m)
      setSessions(sess)
    } catch (err) {
      setError(err.message || 'Failed to load metrics.')
    } finally {
      setLoading(false)
    }
  }, [getDateParams, preset])

  useEffect(() => { load() }, [load])

  const handlePreset = (r) => {
    setPreset(r.label)
    if (r.label !== 'custom') {
      setStartDate('')
      setEndDate('')
    }
  }

  const totalTokens = summary ? (summary.total_input_tokens || 0) + (summary.total_output_tokens || 0) : 0
  const maxModelCost = modelTotals.length ? Math.max(...modelTotals.map(m => m.cost_usd)) : 1

  return (
    <>
      <button className="backlink" onClick={() => navigate(paths.users())}>
        <ArrowLeftIcon width={18} height={18} /> All users
      </button>

      <div className="dash-header">
        <div>
          <h1 className="hero__title" style={{ marginBottom: 4 }}>Metrics</h1>
          <p className="hero__sub" style={{ margin: 0 }}>Token usage and cost — {userId}</p>
        </div>
        <DateFilter
          preset={preset}
          onPreset={handlePreset}
          startDate={startDate}
          endDate={endDate}
          onStartDate={setStartDate}
          onEndDate={setEndDate}
        />
      </div>

      {loading && <div className="state"><div className="loader" /><p>Loading metrics…</p></div>}
      {!loading && error && (
        <div className="state state--error">
          <p>{error}</p>
          <button className="btn btn--ghost" onClick={load}>Retry</button>
        </div>
      )}

      {!loading && !error && summary && (
        <>
          {/* Summary cards */}
          <div className="dash-summary-row">
            <SummaryCard label="Total Cost" value={fmtCost(summary.total_cost_usd)} />
            <SummaryCard
              label="Tokens generated"
              value={fmt(totalTokens)}
              sub={`${fmt(summary.total_input_tokens)} in · ${fmt(summary.total_output_tokens)} out`}
            />
            <SummaryCard label="Projects" value={summary.projects} />
            <SummaryCard
              label="Agents"
              value={AGENT_COUNT}
              sub={<button className="dash-link" onClick={() => navigate(paths.userMetricsAgents(userId))}>View all agents →</button>}
            />
            <SummaryCard label="Files" value={summary.sessions} />
          </div>

          {/* Token & cost line chart */}
          <div className="dash-panel">
            <SectionHead
              title={`Token & cost — last ${preset === 'custom' ? 'period' : preset}`}
              sub="Daily consumption across all agents"
            />
            {daily.length === 0 ? (
              <div className="state" style={{ minHeight: 180 }}><p>No data for this period.</p></div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={daily} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={fmtShortDate} tick={{ fontSize: 11, fill: 'var(--text-soft)' }} />
                  <YAxis yAxisId="tokens" tickFormatter={fmt} tick={{ fontSize: 11, fill: 'var(--text-soft)' }} width={48} />
                  <YAxis yAxisId="cost" orientation="right" tickFormatter={v => '$' + v.toFixed(2)} tick={{ fontSize: 11, fill: 'var(--text-soft)' }} width={56} />
                  <Tooltip content={<CustomLineTooltip />} />
                  <Line yAxisId="tokens" type="monotone" dataKey="total_tokens" name="Tokens / day" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line yAxisId="cost" type="monotone" dataKey="cost_usd" name="Cost / day (USD)" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="dash-two-col">
            {/* Spend by model */}
            <div className="dash-panel">
              <SectionHead title="Spend by model" />
              {modelTotals.length === 0 ? (
                <p className="dash-empty">No model data yet.</p>
              ) : (
                <div className="dash-model-list">
                  {modelTotals.map((m) => (
                    <div key={m.model} className="dash-model-row">
                      <div className="dash-model-row__name">{m.model}</div>
                      <div className="dash-model-row__bar-wrap">
                        <div
                          className="dash-model-row__bar"
                          style={{ width: Math.max(4, (m.cost_usd / maxModelCost) * 100) + '%' }}
                        />
                      </div>
                      <div className="dash-model-row__cost">{fmtCost(m.cost_usd)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Agents live status */}
            <div className="dash-panel">
              <SectionHead title="Agents" sub="Live status · 24h tokens" />
              <div className="dash-agent-list">
                {agentTotals.length === 0 ? (
                  <p className="dash-empty">No agent activity recorded yet.</p>
                ) : (
                  agentTotals.map((a) => (
                    <div key={a.agent_name} className="dash-agent-row">
                      <div className="dash-agent-row__left">
                        <span className="dash-agent-dot dash-agent-dot--on" />
                        <div>
                          <div className="dash-agent-row__name">{AGENT_LABELS[a.agent_name] || a.agent_name}</div>
                          <div className="dash-agent-row__key">{a.agent_name}</div>
                        </div>
                      </div>
                      <div className="dash-agent-row__right">
                        <span className="dash-agent-row__tokens">{fmt(a.total_tokens)} tok / period</span>
                        <span className="dash-agent-row__cost">{fmtCost(a.cost_usd)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Token usage table by agent */}
          <div className="dash-panel">
            <SectionHead title="Token Usage & Cost by Agent" sub="Exact token totals and cost per agent/trace name." />
            {agentTotals.length === 0 ? (
              <p className="dash-empty">No data.</p>
            ) : (
              <div className="table-wrap" style={{ marginTop: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Trace Name</th>
                      <th>Sum Total Tokens</th>
                      <th>Input Tokens</th>
                      <th>Output Tokens</th>
                      <th>Sum Total Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ fontWeight: 600 }}>
                      <td>Total</td>
                      <td>{fmt(agentTotals.reduce((s, a) => s + a.total_tokens, 0))}</td>
                      <td>{fmt(agentTotals.reduce((s, a) => s + a.input_tokens, 0))}</td>
                      <td>{fmt(agentTotals.reduce((s, a) => s + a.output_tokens, 0))}</td>
                      <td>{fmtCost(agentTotals.reduce((s, a) => s + a.cost_usd, 0))}</td>
                    </tr>
                    {agentTotals.map((a) => (
                      <tr key={a.agent_name}>
                        <td><span className="tag tag--muted">{a.agent_name}</span></td>
                        <td>{fmt(a.total_tokens)}</td>
                        <td>{fmt(a.input_tokens)}</td>
                        <td>{fmt(a.output_tokens)}</td>
                        <td>{fmtCost(a.cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Total tokens by agent bar chart */}
          <div className="dash-panel">
            <SectionHead title="Total Tokens by Agent" sub="Sum of tokens consumed, grouped by the agent/trace name." />
            {agentTotals.length === 0 ? (
              <p className="dash-empty">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={agentTotals} margin={{ top: 8, right: 16, bottom: 40, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="agent_name"
                    tick={{ fontSize: 11, fill: 'var(--text-soft)' }}
                    interval={0}
                    angle={-20}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis tickFormatter={fmt} tick={{ fontSize: 11, fill: 'var(--text-soft)' }} width={48} />
                  <Tooltip content={<CustomBarTooltip />} />
                  <Bar dataKey="total_tokens" radius={[4, 4, 0, 0]}>
                    {agentTotals.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Files breakdown */}
          <div className="dash-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <SectionHead title="Files" sub="Per-file token breakdown with expandable agent view." />
              <button className="btn btn--ghost" style={{ fontSize: 13 }} onClick={() => setShowFiles(v => !v)}>
                {showFiles ? 'Hide' : 'Show'} files
              </button>
            </div>
            {showFiles && (
              sessions.length === 0 ? (
                <p className="dash-empty">No telemetry recorded — run a tagging job to see data here.</p>
              ) : (
                <div className="table-wrap" style={{ marginTop: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>File Name</th><th>Project</th><th>Date</th><th>Status</th>
                        <th>Total Tokens</th><th>Cost</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => <AgentRow key={s.session_id} agent={s} />)}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        </>
      )}
    </>
  )
}

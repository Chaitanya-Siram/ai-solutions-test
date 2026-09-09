import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftIcon } from '../components/Icons.jsx'
import { paths } from '../router/nav.js'
import { getMetricsSummary, getMetricsSessions, getSessionDetail } from '../api/metrics.js'

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

function StatCard({ label, value, active, onClick }) {
  return (
    <button
      className={`metric-card${active ? ' metric-card--active' : ''}`}
      onClick={onClick}
    >
      <span className="metric-card__value">{value ?? '—'}</span>
      <span className="metric-card__label">{label}</span>
    </button>
  )
}

function AgentRow({ agent }) {
  const agentLabels = {
    relevancy_agent: 'Relevancy Agent',
    tagging_agent: 'Tagging Agent',
    query_builder: 'Query Builder',
  }
  return (
    <tr>
      <td><span className="tag tag--muted">{agentLabels[agent.agent_name] || agent.agent_name}</span></td>
      <td>{fmt(agent.input_tokens)}</td>
      <td>{fmt(agent.output_tokens)}</td>
      <td>{fmtCost(agent.cost_usd)}</td>
    </tr>
  )
}

function SessionRow({ session }) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    if (!expanded && !detail) {
      setLoading(true)
      try {
        const data = await getSessionDetail(session.session_id)
        setDetail(data)
      } catch (_) {
        setDetail([])
      } finally {
        setLoading(false)
      }
    }
    setExpanded((v) => !v)
  }

  const total = (session.total_input_tokens || 0) + (session.total_output_tokens || 0)

  return (
    <>
      <tr className="session-row" onClick={toggle} style={{ cursor: 'pointer' }}>
        <td>
          <span className="usercell__name">{session.session_name || `Session #${session.session_id}`}</span>
        </td>
        <td>{session.project_name || '—'}</td>
        <td>{fmtDate(session.created_at)}</td>
        <td>
          <span className={`tag ${session.status === 'Tagged' ? 'tag--active' : 'tag--muted'}`}>
            {session.status || 'Unknown'}
          </span>
        </td>
        <td>{fmt(total)}</td>
        <td>{fmtCost(session.total_cost_usd)}</td>
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
                  <tr>
                    <th>Agent</th>
                    <th>Input Tokens</th>
                    <th>Output Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.map((a, i) => <AgentRow key={i} agent={a} />)}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

export default function UserMetricsScreen() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState(null)
  const [sessions, setSessions] = useState(null)
  const [activeView, setActiveView] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [s, sess] = await Promise.all([getMetricsSummary(), getMetricsSessions()])
      setSummary(s)
      setSessions(sess)
    } catch (err) {
      setError(err.message || 'Failed to load metrics.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <>
      <button className="backlink" onClick={() => navigate(paths.users())}>
        <ArrowLeftIcon width={18} height={18} /> All users
      </button>

      <section className="hero hero--compact">
        <div className="hero__text">
          <h1 className="hero__title">Metrics</h1>
          <p className="hero__sub">Token usage and cost across projects, files, and agents.</p>
        </div>
      </section>

      {loading && <div className="state"><div className="loader" /><p>Loading metrics…</p></div>}
      {!loading && error && (
        <div className="state state--error">
          <p>{error}</p>
          <button className="btn btn--ghost" onClick={load}>Retry</button>
        </div>
      )}

      {!loading && !error && summary && (
        <>
          <div className="metric-cards">
            <StatCard label="Projects" value={summary.projects} active={activeView === 'projects'} onClick={() => setActiveView(v => v === 'projects' ? null : 'projects')} />
            <StatCard label="Files" value={summary.sessions} active={activeView === 'files'} onClick={() => setActiveView(v => v === 'files' ? null : 'files')} />
            <StatCard label="Generated Queries" value={summary.generated_queries} active={activeView === 'queries'} onClick={() => setActiveView(v => v === 'queries' ? null : 'queries')} />
            <StatCard label="Total Cost" value={fmtCost(summary.total_cost_usd)} />
            <StatCard label="Total Tokens" value={fmt((summary.total_input_tokens || 0) + (summary.total_output_tokens || 0))} />
          </div>

          {activeView === 'files' && (
            <div className="table-wrap" style={{ marginTop: 24 }}>
              {!sessions || sessions.length === 0 ? (
                <div className="state">
                  <p>No telemetry recorded yet — run a tagging job to see usage data here.</p>
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>File Name</th>
                      <th>Project</th>
                      <th>Date</th>
                      <th>Status</th>
                      <th>Total Tokens</th>
                      <th>Cost</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => <SessionRow key={s.session_id} session={s} />)}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}

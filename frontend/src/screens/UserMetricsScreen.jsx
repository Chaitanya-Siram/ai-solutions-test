import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeftIcon } from '../components/Icons.jsx'
import { paths } from '../router/nav.js'
import { getMetricsSummary } from '../api/metrics.js'

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

export default function UserMetricsScreen() {
  const navigate = useNavigate()
  const { userId } = useParams()
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    getMetricsSummary()
      .then(setSummary)
      .catch(err => setError(err.message || 'Failed to load metrics.'))
      .finally(() => setLoading(false))
  }, [])

  const totalTokens = summary ? (summary.total_input_tokens || 0) + (summary.total_output_tokens || 0) : 0

  return (
    <>
      <button className="backlink" onClick={() => navigate(paths.users())}>
        <ArrowLeftIcon width={18} height={18} /> All users
      </button>

      <section className="hero hero--compact">
        <div className="hero__text">
          <h1 className="hero__title">Metrics</h1>
          <p className="hero__sub">{userId}</p>
        </div>
      </section>

      {loading && <div className="state"><div className="loader" /><p>Loading…</p></div>}
      {!loading && error && (
        <div className="state state--error">
          <p>{error}</p>
          <button className="btn btn--ghost" onClick={() => window.location.reload()}>Retry</button>
        </div>
      )}

      {!loading && !error && summary && (
        <div className="metrics-overview">
          <button
            className="metrics-overview__card metrics-overview__card--clickable"
            onClick={() => navigate(paths.userMetricsProjects(userId))}
          >
            <span className="metrics-overview__value">{summary.projects}</span>
            <span className="metrics-overview__label">Projects</span>
            <span className="metrics-overview__hint">View projects →</span>
          </button>

          <div className="metrics-overview__card">
            <span className="metrics-overview__value">{fmt(totalTokens)}</span>
            <span className="metrics-overview__label">Tokens</span>
            <span className="metrics-overview__hint">{fmt(summary.total_input_tokens)} in · {fmt(summary.total_output_tokens)} out</span>
          </div>

          <div className="metrics-overview__card">
            <span className="metrics-overview__value">{fmtCost(summary.total_cost_usd)}</span>
            <span className="metrics-overview__label">Total Cost</span>
            <span className="metrics-overview__hint">All projects · all time</span>
          </div>
        </div>
      )}
    </>
  )
}

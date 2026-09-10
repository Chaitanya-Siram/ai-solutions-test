import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeftIcon } from '../components/Icons.jsx'
import { paths } from '../router/nav.js'
import { getMetricsProjects } from '../api/metrics.js'

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

const PROJECT_COLORS = [
  { bg: '#fce7f3', icon: '#db2777' },
  { bg: '#ede9fe', icon: '#7c3aed' },
  { bg: '#dbeafe', icon: '#1d4ed8' },
  { bg: '#dcfce7', icon: '#15803d' },
  { bg: '#fef9c3', icon: '#a16207' },
  { bg: '#ffedd5', icon: '#c2410c' },
]

function ProjectCard({ project, index, onClick }) {
  const color = PROJECT_COLORS[index % PROJECT_COLORS.length]
  const initial = (project.name || '?').charAt(0).toUpperCase()

  return (
    <button className="proj-metric-card" onClick={onClick}>
      <div className="proj-metric-card__top">
        <div className="proj-metric-card__icon" style={{ background: color.bg, color: color.icon }}>
          {initial}
        </div>
        <span className="proj-metric-card__num">{String(index + 1).padStart(2, '0')}</span>
      </div>
      <div className="proj-metric-card__name">{project.name}</div>
      <div className="proj-metric-card__stats">
        <span>{fmt(project.total_tokens)} tokens</span>
        <span>{fmtCost(project.cost_usd)}</span>
      </div>
    </button>
  )
}

export default function UserMetricsProjectsScreen() {
  const navigate = useNavigate()
  const { userId } = useParams()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    getMetricsProjects()
      .then(setProjects)
      .catch(err => setError(err.message || 'Failed to load projects.'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <>
      <button className="backlink" onClick={() => navigate(paths.userMetrics(userId))}>
        <ArrowLeftIcon width={18} height={18} /> Metrics
      </button>

      <section className="hero hero--compact">
        <div className="hero__text">
          <h1 className="hero__title">Projects</h1>
          <p className="hero__sub">Select a project to view its token usage and cost breakdown.</p>
        </div>
      </section>

      {loading && <div className="state"><div className="loader" /><p>Loading projects…</p></div>}
      {!loading && error && <div className="state state--error"><p>{error}</p></div>}
      {!loading && !error && projects.length === 0 && (
        <div className="state"><p>No projects found.</p></div>
      )}
      {!loading && !error && projects.length > 0 && (
        <div className="proj-metric-grid">
          {projects.map((p, i) => (
            <ProjectCard
              key={p.id}
              project={p}
              index={i}
              onClick={() => navigate(paths.userMetricsProject(userId, p.id), { state: { project: p } })}
            />
          ))}
        </div>
      )}
    </>
  )
}

import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeftIcon } from '../components/Icons.jsx'
import { paths } from '../router/nav.js'

const AGENTS = [
  {
    name: 'relevancy_agent',
    label: 'Relevancy Agent',
    trigger: 'Run Tagging → before tagging starts',
    description: 'Reads each article and decides if it is relevant to the project. Irrelevant articles are filtered out before the tagger runs.',
  },
  {
    name: 'tagging_agent',
    label: 'Tagging Agent',
    trigger: 'Run Tagging → after relevancy gate',
    description: 'Classifies each relevant article: assigns sentiment, theme, section, confidence score, and a summary blurb.',
  },
  {
    name: 'query_builder',
    label: 'Query Builder',
    trigger: 'Workflow → Build Query (per conversation turn)',
    description: 'Multi-turn conversational agent that guides the user through configuring brand keywords, competitor keywords, and query groups for a new project.',
  },
  {
    name: 'chart_agent',
    label: 'Chart Agent',
    trigger: 'Dashboard chat sidebar (every question or chart request)',
    description: 'Routes questions to either a chart-code generator (writes Python/Pandas, runs in E2B sandbox) or a QA agent that answers from the tagged articles.',
  },
  {
    name: 'otsuka_report_agent',
    label: 'Otsuka Report Agent',
    trigger: 'Download report → Otsuka summary variant',
    description: 'Writes per-article point-wise summaries and a 4-paragraph executive overview for the Otsuka .docx report.',
  },
  {
    name: 'section_fetcher',
    label: 'Section Fetcher',
    trigger: 'Save project sections prompt',
    description: 'Parses a free-text sections prompt and extracts the ordered list of section names so they can be stored and used during tagging.',
  },
  {
    name: 'relevancy_domain_extractor',
    label: 'Relevancy Domain Extractor',
    trigger: 'Save project relevancy prompt',
    description: 'Reads the relevancy prompt and pulls out explicit include/exclude publication domains so the relevancy gate can enforce them without re-parsing on every run.',
  },
]

export default function UserMetricsAgentsScreen() {
  const navigate = useNavigate()
  const { userId } = useParams()

  return (
    <>
      <button className="backlink" onClick={() => navigate(paths.userMetrics(userId))}>
        <ArrowLeftIcon width={18} height={18} /> Metrics
      </button>

      <section className="hero hero--compact">
        <div className="hero__text">
          <h1 className="hero__title">Agents</h1>
          <p className="hero__sub">{AGENTS.length} agents active in this project — each one consumes tokens tracked in Metrics.</p>
        </div>
      </section>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Triggered by</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {AGENTS.map((a) => (
              <tr key={a.name}>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="usercell__name">{a.label}</span>
                    <span className="tag tag--muted" style={{ alignSelf: 'flex-start', fontSize: 11 }}>{a.name}</span>
                  </div>
                </td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{a.trigger}</td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{a.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

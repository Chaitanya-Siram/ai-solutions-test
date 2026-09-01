import { useMemo } from 'react'
import HeroCanvas from '../components/HeroCanvas.jsx'
import { TILES } from '../components/Icons.jsx'
import ChatDock from '../components/ChatDock.jsx'

// Five dashboards, styled as "Choose your view" entry cards (per the reference).
// Daily Monitoring is always first.
const DASHBOARDS = [
  {
    key: 'media_monitoring', title: 'Daily Monitoring', tile: 0, badge: 'Live · Day by day', live: true, viz: 'line',
    desc: 'Pick any day or range on the calendar and generate an on-demand report — every article, sectioned and sentiment-scored.',
    cta: 'monitoring',
  },
  {
    key: 'media_measurement', title: 'Media Measurement', tile: 1, badge: '5-chapter story', viz: 'bars',
    desc: 'An executive walk-through of the period — its overall shape, themes, voices, risks and the board narrative.',
    cta: 'measurement',
  },
  {
    key: 'narrative_intelligence', title: 'Narrative Intelligence', tile: 2, badge: 'Signals', viz: 'bars',
    desc: 'Track the active narratives shaping perception and how they gain or lose momentum across the window.',
    cta: 'narratives',
  },
  {
    key: 'pr_impact', title: 'PR Impact', tile: 3, badge: 'Impact', viz: 'line',
    desc: 'Quantify the impact of your PR efforts — reach, resonance and share of the conversation.',
    cta: 'PR impact',
  },
  {
    key: 'reputation_index', title: 'Reputation Index', tile: 4, badge: 'Score', viz: 'line',
    desc: 'A single composite score for reputation, tracked over time and broken down by its drivers.',
    cta: 'reputation',
  },
]

// Decorative background chart art for a tile (ported from the reference .ec-art).
function EcardArt({ type, accent }) {
  if (type === 'bars') {
    return (
      <svg className="ecard__art" viewBox="0 0 400 280" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true">
        <g opacity=".5">
          <rect x="58" y="150" width="36" height="92" rx="5" fill={accent} />
          <rect x="110" y="112" width="36" height="130" rx="5" fill={accent} opacity=".7" />
          <rect x="162" y="70" width="36" height="172" rx="5" fill="#ffffff" opacity=".85" />
          <rect x="214" y="128" width="36" height="114" rx="5" fill={accent} />
          <rect x="266" y="96" width="36" height="146" rx="5" fill={accent} opacity=".7" />
        </g>
        <polyline points="76,150 128,112 180,70 232,128 284,96" stroke="#fff" strokeWidth="1.6" fill="none" opacity=".7" />
        {[[76, 150], [128, 112], [180, 70], [232, 128], [284, 96]].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="3.5" fill="#fff" />
        ))}
      </svg>
    )
  }
  return (
    <svg className="ecard__art" viewBox="0 0 400 280" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true">
      <g stroke="#ffffff" strokeWidth="1.4" opacity=".22">
        <line x1="40" y1="58" x2="360" y2="58" /><line x1="40" y1="96" x2="300" y2="96" />
        <line x1="40" y1="134" x2="344" y2="134" /><line x1="40" y1="172" x2="276" y2="172" />
      </g>
      <polyline points="14,232 70,232 96,198 122,252 152,176 182,238 212,230 400,230" stroke={accent} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="152" cy="176" r="4.5" fill="#ffffff" />
    </svg>
  )
}

function pickNumber(data) {
  if (typeof data === 'number') return data
  if (data && typeof data === 'object') {
    for (const k of ['value', 'score', 'count', 'total', 'total_count', 'index', 'current']) {
      if (typeof data[k] === 'number') return data[k]
    }
  }
  return null
}

function findChart(arr, ...idParts) {
  if (!Array.isArray(arr)) return null
  return arr.find((c) => c?.chart_id && idParts.some((p) => c.chart_id.includes(p))) || null
}

function nf(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export default function DashboardsScreen({ project, session, chartsData, onOpenDashboard, onBackToReview }) {
  // Best-effort headline figures for the landing hero stat tiles.
  const stats = useMemo(() => {
    const mm = chartsData?.media_measurement
    const total = pickNumber(findChart(mm, 'total_count', 'total_article')?.data)
    const monArr = chartsData?.media_monitoring
    const sectionChart = Array.isArray(monArr) ? monArr.find((c) => c?.chart_id === 'section_articles') : null
    const sectionData = sectionChart?.data
    const sectionCount = sectionData && typeof sectionData === 'object' ? Object.keys(sectionData).length : 0
    let monTotal = 0
    if (sectionData && typeof sectionData === 'object') {
      Object.values(sectionData).forEach((a) => { monTotal += Array.isArray(a) ? a.length : 0 })
    }
    return [
      { n: nf(total ?? monTotal), l: 'Articles analysed' },
      { n: nf(sectionCount), l: 'Sections tracked' },
      { n: '5', l: 'Dashboards' },
    ]
  }, [chartsData])

  return (
    <>
      <div className="mmhero mmhero--landing mmhero--bleed">
        <HeroCanvas palette="landing" className="mmhero__canvas" />
        <div className="mmhero__grain" />
        <div className="mmhero__vignette" />
        <div className="mmhero__inner mmhero__inner--lg">
          {onBackToReview && (
            <div className="mmhero__backrow">
              <button className="mmhero__back" onClick={onBackToReview}>← Back to review</button>
            </div>
          )}
          <div className="mmhero__kicker"><span className="mmhero__dot" /> Earned Media Command Center</div>
          <h1 className="mmhero__h1 mmhero__h1--lg">
            Every signal that moves the <em>narrative</em>.
          </h1>
          <p className="mmhero__sub mmhero__sub--lg">
            {project?.name ? `${project.name} — ` : ''}a board-ready intelligence story across live daily
            monitoring and structured weekly measurement, in one premium workspace.
          </p>
          <div className="mmhero__stats">
            {stats.map((s, i) => (
              <div className="mmhero__stat" key={i}>
                <div className="mmhero__statn">{s.n}</div>
                <div className="mmhero__statl">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <section className="choose">
        <p className="choose__tag">Five ways in</p>
        <h2 className="choose__title">Choose your view</h2>
        <p className="choose__sub">
          Track the story as it breaks, step back and measure the period, or dive into narratives,
          PR impact and reputation — every signal stays in sync across all five.
        </p>

        <div className="choose__grid">
          {DASHBOARDS.map((d) => {
            const { fg } = TILES[d.tile]
            const bg = `radial-gradient(120% 100% at 100% 0%, ${fg}55, transparent 55%),
                        radial-gradient(110% 110% at 0% 100%, ${fg}30, transparent 55%),
                        linear-gradient(150deg, #15101c, #0e0b14)`
            return (
              <button
                key={d.key}
                className="ecard"
                style={{ '--ec-accent': fg }}
                onClick={() => onOpenDashboard?.(d.key, d.title)}
              >
                <span className="ecard__bg" style={{ background: bg }} />
                <EcardArt type={d.viz} accent={fg} />
                <div className="ecard__body">
                  <span className="ecard__badge">
                    {d.live && <i className="ecard__live" />} {d.badge}
                  </span>
                  <h3 className="ecard__title">{d.title}</h3>
                  <p className="ecard__desc">{d.desc}</p>
                  <span className="ecard__go">
                    Open {d.cta} <span className="ecard__arr">→</span>
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <ChatDock sessionId={session?.id} mode="inline" />
    </>
  )
}

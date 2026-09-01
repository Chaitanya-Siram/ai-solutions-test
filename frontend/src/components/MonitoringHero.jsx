import HeroCanvas from './HeroCanvas.jsx'
import { DownloadIcon } from './Icons.jsx'

const PenIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={15} height={15}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

// Molten-gold storyboard hero for the Daily Monitoring view.
// stats: [{ n, l }] — number + label tiles shown under the headline.
// downloads: [{ key, label, onClick, busy }] — one button per available report
// layout (Otsuka has two, every other brand has one).
export default function MonitoringHero({
  kicker, headLead, headEm, sub, stats = [], onBack, onBackToReview,
  downloads = [], downloadDisabled = false, downloadError = '',
}) {
  return (
    <div className="mmhero mmhero--bleed">
      <HeroCanvas palette="monitoring" className="mmhero__canvas" />
      <div className="mmhero__grain" />
      <div className="mmhero__vignette" />
      <div className="mmhero__inner">
        {(onBack || onBackToReview || downloads.length > 0) && (
          <div className="mmhero__topbar">
            {onBack || onBackToReview ? (
              <div className="mmhero__backrow">
                {onBack && <button className="mmhero__back" onClick={onBack}>← Back to dashboards</button>}
                {onBackToReview && (
                  <button className="mmhero__back" onClick={onBackToReview}>← Back to review</button>
                )}
              </div>
            ) : <span />}
            {downloads.length > 0 && (
              <div className="mmhero__dlwrap">
                <div className="mmhero__dlrow">
                  {downloads.map((d) => (
                    <button
                      key={d.key}
                      className="mmhero__download"
                      onClick={d.onClick}
                      disabled={d.busy || downloadDisabled}
                      title={downloadDisabled
                        ? 'No articles in the current selection to export'
                        : `Download the current view as a Word report (${d.label})`}
                    >
                      <DownloadIcon width={15} height={15} />
                      {d.busy ? 'Preparing…' : d.label}
                    </button>
                  ))}
                </div>
                {downloadError && <p className="mmhero__dlerror">{downloadError}</p>}
              </div>
            )}
          </div>
        )}
        <div className="mmhero__kicker"><span className="mmhero__dot" /> {kicker}</div>
        <h1 className="mmhero__h1">
          {headLead} {headEm && <em>{headEm}</em>}
        </h1>
        {sub && (
          <div className="mmhero__subwrap">
            <p className="mmhero__sub">{sub}</p>
            <span className="mmhero__pen" aria-hidden="true"><PenIcon /></span>
          </div>
        )}
        {stats.length > 0 && (
          <div className="mmhero__stats">
            {stats.map((s, i) => (
              <div className="mmhero__stat" key={i}>
                <div className="mmhero__statn">{s.n}</div>
                <div className="mmhero__statl">{s.l}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom'
import ProjectsScreen from './screens/ProjectsScreen.jsx'
import ProjectScreen from './screens/ProjectScreen.jsx'
import ComparisonsScreen from './screens/ComparisonsScreen.jsx'
import ReviewScreen from './screens/ReviewScreen.jsx'
import DashboardsScreen from './screens/DashboardsScreen.jsx'
import MediaMeasurementScreen from './screens/MediaMeasurementScreen.jsx'
import MediaMonitoringScreen from './screens/MediaMonitoringScreen.jsx'
import WorkflowScreen from './screens/WorkflowScreen.jsx'
import LoginScreen from './screens/LoginScreen.jsx'
import UsersScreen from './screens/UsersScreen.jsx'
import { AuthProvider, useAuth } from './auth/AuthContext.jsx'
import { BellIcon, MoonIcon, SunIcon } from './components/Icons.jsx'
import { paths, loadProject, loadSession, useResolved, useCharts, seedCharts } from './router/nav.js'

// Dashboard tabs shown in the topbar while inside a project's dashboards.
const DASH_TABS = [
  { key: 'home', label: 'Home', build: paths.dashboards },
  { key: 'media_monitoring', label: 'Daily Monitoring', build: paths.monitoring },
  { key: 'media_measurement', label: 'Media Measurement', build: paths.measurement },
  { key: 'narrative_intelligence', label: 'Narrative Intelligence' },
  { key: 'pr_impact', label: 'PR Impact' },
  { key: 'reputation_index', label: 'Reputation Index' },
]

/* ---------- theme (app-global) ---------- */
const ThemeCtx = createContext({ theme: 'light', toggle: () => {} })
const useTheme = () => useContext(ThemeCtx)

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light')
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])
  const toggle = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))
  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>
}

function Loading() {
  return <div className="state"><p>Loading…</p></div>
}

/* ---------- shared page chrome (topbar + main) ---------- */
function Shell({ project, projectId, sessionId, session, chartsData, activeTab, wide, children }) {
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()
  const inDash = !!activeTab

  return (
    <div className="page">
      <div className="page__glow" aria-hidden="true" />

      <header className={`topbar${inDash ? ' topbar--dash' : ''}`}>
        {inDash ? (
          <button className="brand brand--link" onClick={() => navigate(paths.project(projectId))}>
            <span className="brand__dot" />
            {project?.name || 'Intelligence'}
          </button>
        ) : (
          <div className="brand">
            <span className="brand__dot" />
            INFOVISION INTELLIGENCE
          </div>
        )}

        {inDash && (
          <nav className="topnav">
            {DASH_TABS.map((t) => (
              <button
                key={t.key}
                className={`topnav__link${activeTab === t.key ? ' topnav__link--on' : ''}`}
                onClick={() => {
                  if (!t.build) {
                    alert(`Open "${t.label}" — coming soon.`)
                    return
                  }
                  navigate(t.build(projectId, sessionId), { state: { project, session, chartsData } })
                }}
              >
                {t.label}
              </button>
            ))}
          </nav>
        )}

        <div className="topbar__actions">
          <button className="iconbtn" aria-label="Notifications"><BellIcon width={18} height={18} /></button>
          <button className="iconbtn" aria-label="Toggle theme" onClick={toggle}>
            {theme === 'light' ? <MoonIcon width={18} height={18} /> : <SunIcon width={18} height={18} />}
          </button>
          <UserMenu />
        </div>
      </header>

      <main className={`content${wide ? ' content--wide' : ''}`}>{children}</main>
    </div>
  )
}

/* ---------- topbar user menu (avatar → Users / Sign out) ---------- */
function UserMenu() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const initial = (user?.full_name || user?.email || '?').charAt(0).toUpperCase()

  return (
    <div className="usermenu" ref={ref}>
      <button className="avatar" aria-label="Account menu" onClick={() => setOpen((o) => !o)}>
        {initial}
      </button>
      {open && (
        <div className="usermenu__pop" role="menu">
          <div className="usermenu__head">
            <span className="usermenu__name">{user?.full_name || user?.email}</span>
            <span className="usermenu__email">{user?.email}</span>
          </div>
          <button
            className="usermenu__item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              navigate(paths.users())
            }}
          >
            Users
          </button>
          <button
            className="usermenu__item usermenu__item--danger"
            role="menuitem"
            onClick={async () => {
              setOpen(false)
              await logout()
              navigate(paths.login(), { replace: true })
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- route guard: redirect to /login when unauthenticated ---------- */
function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) {
    return (
      <div className="page">
        <div className="page__glow" aria-hidden="true" />
        <main className="content"><Loading /></main>
      </div>
    )
  }
  if (!user) return <Navigate to={paths.login()} replace state={{ from: location }} />
  return children
}

/* ---------- users route ---------- */
function UsersRoute() {
  return (
    <Shell wide>
      <UsersScreen />
    </Shell>
  )
}

/* ---------- route wrappers (URL → data → screen) ---------- */
function ProjectsRoute() {
  const navigate = useNavigate()
  return (
    <Shell>
      <ProjectsScreen onOpenProject={(project) => navigate(paths.project(project.id), { state: { project } })} />
    </Shell>
  )
}

function ProjectRoute() {
  const { projectId } = useParams()
  const { state } = useLocation()
  const navigate = useNavigate()
  const project = useResolved(loadProject, projectId, state?.project)
  return (
    <Shell project={project} projectId={projectId}>
      {project ? (
        <ProjectScreen
          project={project}
          onBack={() => navigate(paths.projects())}
          onOpenReview={(session, opts = {}) =>
            navigate(paths.review(projectId, session.id), {
              state: { project, session, runTagging: !!opts.runTagging, nameHint: opts.nameHint || null },
            })
          }
          onOpenWorkflow={(session) =>
            navigate(paths.workflow(projectId, session.id), { state: { project, session } })
          }
          onOpenComparisons={() =>
            navigate(paths.comparisons(projectId), { state: { project } })
          }
        />
      ) : (
        <Loading />
      )}
    </Shell>
  )
}

function ComparisonsRoute() {
  const { projectId } = useParams()
  const { state } = useLocation()
  const navigate = useNavigate()
  const project = useResolved(loadProject, projectId, state?.project)
  return (
    <Shell project={project} projectId={projectId}>
      {project ? (
        <ComparisonsScreen
          project={project}
          onBack={() => navigate(paths.project(projectId), { state: { project } })}
        />
      ) : (
        <Loading />
      )}
    </Shell>
  )
}

function WorkflowRoute() {
  const { projectId, sessionId } = useParams()
  const { state } = useLocation()
  const navigate = useNavigate()
  const { theme, toggle } = useTheme()
  const project = useResolved(loadProject, projectId, state?.project)
  const session = useResolved(loadSession, sessionId, state?.session)

  if (!project || !session) {
    return <div className="page"><div className="page__glow" aria-hidden="true" /><main className="content"><Loading /></main></div>
  }
  return (
    <WorkflowScreen
      project={project}
      session={session}
      theme={theme}
      onToggleTheme={toggle}
      onBack={() => navigate(paths.project(projectId), { state: { project } })}
      onOpenReview={(s) => {
        const status = (s?.status || '').toLowerCase()
        const tagged = status === 'tagged' || status === 'completed'
        navigate(paths.review(projectId, s.id), { state: { project, session: s, runTagging: !tagged } })
      }}
    />
  )
}

function ReviewRoute() {
  const { projectId, sessionId } = useParams()
  const { state } = useLocation()
  const navigate = useNavigate()
  const project = useResolved(loadProject, projectId, state?.project)
  const session = useResolved(loadSession, sessionId, state?.session)
  return (
    <Shell project={project} projectId={projectId} wide>
      {project && session ? (
        <ReviewScreen
          project={project}
          session={session}
          tabbed
          runTagging={state?.runTagging || false}
          nameHint={state?.nameHint || null}
          onBack={() => navigate(paths.project(projectId), { state: { project } })}
          onCreated={(chartsData) => {
            seedCharts(sessionId, chartsData)
            navigate(paths.dashboards(projectId, sessionId), { state: { project, session, chartsData } })
          }}
        />
      ) : (
        <Loading />
      )}
    </Shell>
  )
}

// Shared loader for the three dashboard views (home / measurement / monitoring).
function useDashData() {
  const { projectId, sessionId } = useParams()
  const { state } = useLocation()
  const project = useResolved(loadProject, projectId, state?.project)
  const session = useResolved(loadSession, sessionId, state?.session)
  const { data: chartsData, loading: chartsLoading, error: chartsError } = useCharts(sessionId, state?.chartsData)
  return { projectId, sessionId, project, session, chartsData, chartsLoading, chartsError }
}

function DashboardsRoute() {
  const navigate = useNavigate()
  const { projectId, sessionId, project, session, chartsData, chartsLoading, chartsError } = useDashData()
  return (
    <Shell project={project} projectId={projectId} sessionId={sessionId} session={session} chartsData={chartsData} activeTab="home" wide>
      {project && session ? (
        <DashboardsScreen
          project={project}
          session={session}
          chartsData={chartsData}
          chartsLoading={chartsLoading}
          chartsError={chartsError}
          onBackToReview={() => navigate(paths.review(projectId, sessionId), { state: { project, session } })}
          onOpenDashboard={(key, title) => {
            if (key === 'media_measurement') {
              navigate(paths.measurement(projectId, sessionId), { state: { project, session, chartsData } })
            } else if (key === 'media_monitoring') {
              navigate(paths.monitoring(projectId, sessionId), { state: { project, session, chartsData } })
            } else {
              alert(`Open "${title}" dashboard — coming soon.`)
            }
          }}
        />
      ) : (
        <Loading />
      )}
    </Shell>
  )
}

function MeasurementRoute() {
  const navigate = useNavigate()
  const { projectId, sessionId, project, session, chartsData, chartsLoading, chartsError } = useDashData()
  return (
    <Shell project={project} projectId={projectId} sessionId={sessionId} session={session} chartsData={chartsData} activeTab="media_measurement" wide>
      {project && session ? (
        <MediaMeasurementScreen
          project={project}
          session={session}
          chartsData={chartsData}
          chartsLoading={chartsLoading}
          chartsError={chartsError}
          onBack={() => navigate(paths.dashboards(projectId, sessionId), { state: { project, session, chartsData } })}
          onBackToReview={() => navigate(paths.review(projectId, sessionId), { state: { project, session } })}
        />
      ) : (
        <Loading />
      )}
    </Shell>
  )
}

function MonitoringRoute() {
  const navigate = useNavigate()
  const { projectId, sessionId, project, session, chartsData, chartsLoading, chartsError } = useDashData()
  return (
    <Shell project={project} projectId={projectId} sessionId={sessionId} session={session} chartsData={chartsData} activeTab="media_monitoring" wide>
      {project && session ? (
        <MediaMonitoringScreen
          project={project}
          session={session}
          chartsData={chartsData}
          chartsLoading={chartsLoading}
          chartsError={chartsError}
          onBack={() => navigate(paths.dashboards(projectId, sessionId), { state: { project, session, chartsData } })}
          onBackToReview={() => navigate(paths.review(projectId, sessionId), { state: { project, session } })}
        />
      ) : (
        <Loading />
      )}
    </Shell>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
            <Route path="/" element={<RequireAuth><ProjectsRoute /></RequireAuth>} />
            <Route path="/users" element={<RequireAuth><UsersRoute /></RequireAuth>} />
            <Route path="/:projectId/sessions" element={<RequireAuth><ProjectRoute /></RequireAuth>} />
            <Route path="/:projectId/comparisons" element={<RequireAuth><ComparisonsRoute /></RequireAuth>} />
            <Route path="/:projectId/sessions/:sessionId/workflow" element={<RequireAuth><WorkflowRoute /></RequireAuth>} />
            <Route path="/:projectId/sessions/:sessionId/review" element={<RequireAuth><ReviewRoute /></RequireAuth>} />
            <Route path="/:projectId/sessions/:sessionId/dashboards" element={<RequireAuth><DashboardsRoute /></RequireAuth>} />
            <Route path="/:projectId/sessions/:sessionId/measurement" element={<RequireAuth><MeasurementRoute /></RequireAuth>} />
            <Route path="/:projectId/sessions/:sessionId/monitoring" element={<RequireAuth><MonitoringRoute /></RequireAuth>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  )
}

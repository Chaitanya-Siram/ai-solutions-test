import { useCallback, useEffect, useState } from 'react'
import { addSectionsPrompt, createProject, deleteProject, listProjects, updateProject } from '../api/projects.js'
import ProjectCard from '../components/ProjectCard.jsx'
import AddProjectModal from '../components/AddProjectModal.jsx'
import ProjectKeywordsModal from '../components/ProjectKeywordsModal.jsx'
import SectionPromptModal from '../components/SectionPromptModal.jsx'
import { PlusIcon } from '../components/Icons.jsx'

export default function ProjectsScreen({ onOpenProject }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  // Post-create setup chain: keywords popup → section prompt popup.
  const [keywordsFor, setKeywordsFor] = useState(null)
  const [keywordsSaving, setKeywordsSaving] = useState(false)
  const [sectionFor, setSectionFor] = useState(null)
  const [sectionSaving, setSectionSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listProjects()
      setProjects(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'Failed to load projects.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleCreate(payload) {
    const created = await createProject(payload)
    setProjects((prev) => [created, ...prev])
    setModalOpen(false)
    // Kick off the post-create chain: ask for keywords first.
    setKeywordsFor(created)
  }

  // Save the project-level keywords, then advance to the section prompt popup.
  const saveKeywords = useCallback(
    async (keywords) => {
      if (!keywordsFor) return
      setKeywordsSaving(true)
      try {
        const updated = await updateProject(keywordsFor.id, keywords)
        setProjects((list) => list.map((p) => (p.id === updated.id ? updated : p)))
        setKeywordsFor(null)
        setSectionFor(updated)
      } catch (err) {
        alert(`Could not save keywords: ${err.message}`)
      } finally {
        setKeywordsSaving(false)
      }
    },
    [keywordsFor],
  )

  // Skipping keywords still advances to the section prompt (both are part of setup).
  function skipKeywords() {
    const proj = keywordsFor
    setKeywordsFor(null)
    if (proj) setSectionFor(proj)
  }

  const saveSectionPrompt = useCallback(
    async (value) => {
      if (!sectionFor) return
      setSectionSaving(true)
      try {
        const updated = await addSectionsPrompt(sectionFor.id, value)
        setProjects((list) => list.map((p) => (p.id === sectionFor.id ? { ...p, ...updated } : p)))
        setSectionFor(null)
      } catch (err) {
        alert(`Could not save section prompt: ${err.message}`)
      } finally {
        setSectionSaving(false)
      }
    },
    [sectionFor],
  )

  async function handleDelete(project) {
    if (!window.confirm(`Delete "${project.name}"? This also removes its sessions.`)) return
    const prev = projects
    setProjects((p) => p.filter((x) => x.id !== project.id))
    try {
      await deleteProject(project.id)
    } catch (err) {
      setProjects(prev)
      alert(`Could not delete project: ${err.message}`)
    }
  }

  return (
    <>
      <section className="hero">
        <div className="hero__text">
          <h1 className="hero__title">
            Every project,
            <br />
            <span className="hero__title--accent">in one place.</span>
          </h1>
          <p className="hero__sub">
            A unified workspace for your media, narrative and reputation intelligence.
            Pick a project to dive in — every signal stays in sync across all of them.
          </p>
        </div>
        <button className="btn btn--primary btn--lg" onClick={() => setModalOpen(true)}>
          <PlusIcon width={18} height={18} />
          Add New Project
        </button>
      </section>

      {loading && <GridSkeleton />}

      {!loading && error && (
        <div className="state state--error">
          <p>{error}</p>
          <button className="btn btn--ghost" onClick={load}>Retry</button>
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="state">
          <p>No projects yet. Create your first one to get started.</p>
          <button className="btn btn--primary" onClick={() => setModalOpen(true)}>
            <PlusIcon width={18} height={18} /> Add New Project
          </button>
        </div>
      )}

      {!loading && !error && projects.length > 0 && (
        <div className="grid">
          {projects.map((project, i) => (
            <ProjectCard
              key={project.id}
              project={project}
              index={i}
              onOpen={onOpenProject}
              onDelete={handleDelete}
            />
          ))}

          <button className="addcard" onClick={() => setModalOpen(true)}>
            <span className="addcard__icon"><PlusIcon /></span>
            <span className="addcard__label">Add New Project</span>
          </button>
        </div>
      )}

      {!loading && !error && (
        <footer className="footline">
          <span className="footline__tag">WORKSPACE</span>
          <span>
            {projects.length} {projects.length === 1 ? 'project' : 'projects'} · synced with the
            InfoVision API
          </span>
        </footer>
      )}

      <AddProjectModal open={modalOpen} onClose={() => setModalOpen(false)} onCreate={handleCreate} />

      <ProjectKeywordsModal
        open={!!keywordsFor}
        project={keywordsFor}
        saving={keywordsSaving}
        onClose={skipKeywords}
        onSave={saveKeywords}
      />

      <SectionPromptModal
        open={!!sectionFor}
        initialValue={sectionFor?.monitoring_sections_prompt || ''}
        saving={sectionSaving}
        onClose={() => setSectionFor(null)}
        onSave={saveSectionPrompt}
      />
    </>
  )
}

function GridSkeleton() {
  return (
    <div className="grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card card--skeleton">
          <div className="sk sk--tile" />
          <div className="sk sk--line sk--w60" />
          <div className="sk sk--line sk--w40" />
          <div className="sk sk--line sk--w30" />
        </div>
      ))}
    </div>
  )
}

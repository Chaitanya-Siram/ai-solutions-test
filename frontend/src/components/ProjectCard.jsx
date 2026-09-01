import { ArrowRightIcon, TrashIcon, tileFor } from './Icons.jsx'

export default function ProjectCard({ project, index, onOpen, onDelete }) {
  const { bg, fg, Icon } = tileFor(index)
  const number = String(index + 1).padStart(2, '0')

  return (
    <article className="card">
      <header className="card__head">
        <span className="card__tile" style={{ backgroundColor: bg, color: fg }}>
          <Icon />
        </span>
        <span className="card__num">{number}</span>
      </header>

      <div className="card__body">
        <h3 className="card__title">{project.name}</h3>
        <p className="card__desc">{project.description || 'No description'}</p>
      </div>

      <footer className="card__foot">
        <button type="button" className="card__open" onClick={() => onOpen?.(project)}>
          Open project
        </button>
        <button
          type="button"
          className="card__arrow"
          aria-label={`Open ${project.name}`}
          onClick={() => onOpen?.(project)}
        >
          <ArrowRightIcon width={16} height={16} />
        </button>
      </footer>

      <button
        type="button"
        className="card__delete"
        aria-label={`Delete ${project.name}`}
        title="Delete project"
        onClick={() => onDelete?.(project)}
      >
        <TrashIcon width={15} height={15} />
      </button>
    </article>
  )
}

import TagInput from './TagInput.jsx'
import { LENSES, LLM_MODELS, CHART_OPTIONS, LAYOUTS, OUTPUT_FORMATS } from './constants.js'
import { UploadIcon } from '../components/Icons.jsx'
import { prettyFileName } from '../utils/files.js'

// Right-hand inspector. Renders the editor for whichever node is selected;
// `onChange(patch)` shallow-merges into that node's `data`.
export default function ConfigPanel({ node, onChange }) {
  if (!node) {
    return (
      <aside className="wfpanel wfpanel--empty">
        <p className="wfpanel__hint">Select a node to configure it.</p>
      </aside>
    )
  }
  const set = (patch) => onChange(patch)
  const d = node.data
  return (
    <aside className="wfpanel">
      {node.type === 'data' && <DataPanel d={d} set={set} />}
      {node.type === 'analysis' && <AnalysisPanel d={d} set={set} />}
      {node.type === 'review' && <ReviewPanel d={d} set={set} />}
      {node.type === 'assembly' && <AssemblyPanel d={d} set={set} />}
      {node.type === 'output' && <OutputPanel d={d} set={set} />}
    </aside>
  )
}

function Section({ title, children }) {
  return (
    <>
      <h3 className="wfpanel__title">{title}</h3>
      <div className="wfpanel__body">{children}</div>
    </>
  )
}

function Field({ label, hint, error, children }) {
  return (
    <label className="wffld">
      <span className="wffld__label">{label}</span>
      {children}
      {error ? (
        <span className="wffld__err">{error}</span>
      ) : (
        hint && <span className="wffld__hint">{hint}</span>
      )}
    </label>
  )
}

function DataPanel({ d, set }) {
  return (
    <Section title="Data Source">
      <Field label="Source Type">
        <div className="wfseg">
          <button
            type="button"
            className={`wfseg__btn${d.sourceType !== 'api' ? ' wfseg__btn--on' : ''}`}
            onClick={() => set({ sourceType: 'file' })}
          >
            File Upload
          </button>
          <button
            type="button"
            className={`wfseg__btn${d.sourceType === 'api' ? ' wfseg__btn--on' : ''}`}
            onClick={() => set({ sourceType: 'api' })}
          >
            REST API
          </button>
        </div>
      </Field>

      {d.sourceType === 'api' ? (
        <Field label="Endpoint URL">
          <input
            className="wfinput"
            value={d.apiUrl || ''}
            placeholder="https://api.example.com/articles"
            onChange={(e) => set({ apiUrl: e.target.value })}
          />
        </Field>
      ) : (
        <Field label="File">
          <div className="wffile">
            <UploadIcon width={18} height={18} />
            <span className="wffile__name" title={d.file}>{d.file || 'No file attached'}</span>
          </div>
        </Field>
      )}

      <Field
        label="Brand Keywords"
        hint="Press Enter or comma to add. Backspace removes the last keyword."
        error={(d.brandKeywords || []).length === 0 ? 'At least one brand keyword is required.' : undefined}
      >
        <TagInput
          value={d.brandKeywords}
          onChange={(brandKeywords) => set({ brandKeywords })}
          tone="brand"
          placeholder="Add brand keyword…"
          required
        />
      </Field>
    </Section>
  )
}

function AnalysisPanel({ d, set }) {
  return (
    <Section title="Analysis">
      <Field label="Label" hint="Used for the node + dashboard nav">
        <input className="wfinput" value={d.label || ''} onChange={(e) => set({ label: e.target.value })} />
      </Field>

      <Field label="Intelligence Lens">
        <select className="wfinput" value={d.lens || ''} onChange={(e) => set({ lens: e.target.value })}>
          <option value="">Select a lens…</option>
          {LENSES.map((l) => (
            <option key={l.key} value={l.key}>{l.label}</option>
          ))}
        </select>
      </Field>

      <Field label="LLM Model">
        <select className="wfinput" value={d.llm || ''} onChange={(e) => set({ llm: e.target.value })}>
          <option value="">No LLM selected</option>
          {LLM_MODELS.map((m) => (
            <option key={m.key} value={m.key}>{m.label} — {m.detail}</option>
          ))}
        </select>
      </Field>

      <Field
        label="Competitor Keywords"
        hint="Press Enter or comma to add. Backspace removes the last keyword."
        error={(d.competitorKeywords || []).length === 0 ? 'At least one competitor keyword is required.' : undefined}
      >
        <TagInput
          value={d.competitorKeywords}
          onChange={(competitorKeywords) => set({ competitorKeywords })}
          tone="comp"
          placeholder="Add competitor…"
          required
        />
      </Field>
    </Section>
  )
}

function ReviewPanel({ d, set }) {
  return (
    <Section title="Review">
      <Field label="Label">
        <input className="wfinput" value={d.label || ''} onChange={(e) => set({ label: e.target.value })} />
      </Field>

      <Field label={`Flag threshold — ${d.flag || 0}%`} hint="Flag articles below this confidence for review">
        <input
          type="range"
          className="wfrange"
          min="0"
          max="100"
          value={d.flag || 0}
          onChange={(e) => set({ flag: Number(e.target.value) })}
        />
      </Field>

      <Field label={`Auto-approve — ${d.auto || 0}%`} hint="Auto-approve articles above this confidence">
        <input
          type="range"
          className="wfrange"
          min="0"
          max="100"
          value={d.auto || 0}
          onChange={(e) => set({ auto: Number(e.target.value) })}
        />
      </Field>

      <label className="wftoggle">
        <input
          type="checkbox"
          checked={!!d.requiresSignOff}
          onChange={(e) => set({ requiresSignOff: e.target.checked })}
        />
        <span>Requires analyst sign-off</span>
      </label>
    </Section>
  )
}

function AssemblyPanel({ d, set }) {
  function toggleChart(key) {
    const has = (d.charts || []).includes(key)
    set({ charts: has ? d.charts.filter((c) => c !== key) : [...(d.charts || []), key] })
  }
  return (
    <Section title="Assembly">
      <Field label="Label">
        <input className="wfinput" value={d.label || ''} onChange={(e) => set({ label: e.target.value })} />
      </Field>

      <Field label="Client Name">
        <input className="wfinput" value={d.clientName || ''} onChange={(e) => set({ clientName: e.target.value })} />
      </Field>

      <Field label="Charts">
        <div className="wfchecks">
          {CHART_OPTIONS.map((c) => (
            <label className="wfcheck" key={c.key}>
              <input
                type="checkbox"
                checked={(d.charts || []).includes(c.key)}
                onChange={() => toggleChart(c.key)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="Layout">
        <select className="wfinput" value={d.layout || 'Standard'} onChange={(e) => set({ layout: e.target.value })}>
          {LAYOUTS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </Field>
    </Section>
  )
}

function OutputPanel({ d, set }) {
  return (
    <Section title="Output">
      <Field label="Label">
        <input className="wfinput" value={d.label || ''} onChange={(e) => set({ label: e.target.value })} />
      </Field>

      <Field label="Format">
        <select className="wfinput" value={d.format || 'Dashboard'} onChange={(e) => set({ format: e.target.value })}>
          {OUTPUT_FORMATS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </Field>
    </Section>
  )
}

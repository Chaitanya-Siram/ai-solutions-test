// Shared option lists and node defaults for the workflow builder.

// The five module types shown in the left sidebar. `type` matches the
// React Flow node type registered in WorkflowScreen.
export const MODULES = [
  { type: 'data', label: 'Data', icon: 'data', hint: 'Source file or REST API' },
  { type: 'analysis', label: 'Analysis', icon: 'analysis', hint: 'Run an intelligence lens' },
  { type: 'review', label: 'Review', icon: 'review', hint: 'Analyst checkpoint' },
  { type: 'assembly', label: 'Assembly', icon: 'assembly', hint: 'Build the dashboard' },
  { type: 'output', label: 'Output', icon: 'output', hint: 'Publish the result' },
]

// Intelligence lenses available on an Analysis node — mirrors the dashboard tabs.
export const LENSES = [
  { key: 'media_measurement', label: 'Media Measurement' },
  { key: 'media_monitoring', label: 'Media Monitoring' },
  { key: 'narrative_intelligence', label: 'Narrative Intelligence' },
  { key: 'pr_impact', label: 'PR Impact' },
  { key: 'reputation_index', label: 'Reputation Index' },
]

export function lensLabel(key) {
  return LENSES.find((l) => l.key === key)?.label || ''
}

// The required pipeline order. A connection is "serial" (valid) only when it
// links a node to the immediately next stage: Data → Analysis → Review →
// Assembly → Output. Anything else (skips, back-edges, same stage) is invalid.
export const NODE_ORDER = ['data', 'analysis', 'review', 'assembly', 'output']

export function isSerialConnection(sourceType, targetType) {
  const s = NODE_ORDER.indexOf(sourceType)
  const t = NODE_ORDER.indexOf(targetType)
  return s !== -1 && t === s + 1
}

// LLM model choices for an Analysis node.
export const LLM_MODELS = [
  { key: 'openai', label: 'OpenAI', detail: 'Azure OpenAI GPT-4.1' },
  { key: 'claude', label: 'Claude', detail: 'Opus 4.8' },
  { key: 'gemini', label: 'Gemini', detail: 'Gemini 2.5 Pro' },
]

export function llmModel(key) {
  return LLM_MODELS.find((m) => m.key === key) || null
}

// Chart toggles for the Assembly (Dashboard Builder) node.
export const CHART_OPTIONS = [
  { key: 'volume', label: 'Volume Over Time' },
  { key: 'sentiment', label: 'Sentiment Split' },
  { key: 'share_of_voice', label: 'Share of Voice' },
  { key: 'themes', label: 'Top Themes' },
  { key: 'sources', label: 'Top Sources' },
  { key: 'geography', label: 'Geography' },
]

export const LAYOUTS = ['Standard', 'Compact', 'Executive', 'Detailed']

// Output formats for the Output node.
export const OUTPUT_FORMATS = ['Dashboard', 'Intelligence Brief', 'PDF Report', 'API Webhook']

// Factory for a node's default `data` payload by type.
export function defaultNodeData(type, extra = {}) {
  switch (type) {
    case 'data':
      return { label: 'Data', sourceType: 'file', file: '', apiUrl: '', brandKeywords: [], ...extra }
    case 'analysis':
      return { label: 'Analysis', lens: '', llm: '', skill: '', competitorKeywords: [], ...extra }
    case 'review':
      return { label: 'Review', flag: 50, auto: 75, requiresSignOff: false, ...extra }
    case 'assembly':
      return {
        label: 'Dashboard Builder',
        clientName: '',
        charts: ['volume', 'sentiment', 'share_of_voice', 'themes'],
        layout: 'Standard',
        ...extra,
      }
    case 'output':
      return { label: 'Output', format: 'Dashboard', ...extra }
    default:
      return { label: type, ...extra }
  }
}

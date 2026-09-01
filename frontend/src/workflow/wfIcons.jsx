// Inline icons specific to the workflow builder. Same 1.7px-stroke style as
// the shared Icons.jsx set.
const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export const DataModuleIcon = (p) => (
  <svg {...base} {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>
)
export const AnalysisModuleIcon = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>
)
export const ReviewModuleIcon = (p) => (
  <svg {...base} {...p}><path d="M12 2 4 5v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>
)
export const AssemblyModuleIcon = (p) => (
  <svg {...base} {...p}><path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></svg>
)
export const OutputModuleIcon = (p) => (
  <svg {...base} {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
)

export const GlobeIcon = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" /></svg>
)
export const BriefIcon = (p) => (
  <svg {...base} {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
)
export const PlayIcon = (p) => (
  <svg {...base} {...p}><path d="m6 4 14 8-14 8V4Z" /></svg>
)
export const SparklesIcon = (p) => (
  <svg {...base} {...p}><path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8L12 3Z" /><path d="M19 14l.8 2 2 .8-2 .8L19 20l-.8-2-2-.8 2-.8.8-2Z" /></svg>
)
export const CopyIcon = (p) => (
  <svg {...base} {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
)
export const FitIcon = (p) => (
  <svg {...base} {...p}><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /></svg>
)
export const LockIcon = (p) => (
  <svg {...base} {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
)
export const TableIcon = (p) => (
  <svg {...base} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 4v16M15 4v16" /></svg>
)

export const MODULE_ICON = {
  data: DataModuleIcon,
  analysis: AnalysisModuleIcon,
  review: ReviewModuleIcon,
  assembly: AssemblyModuleIcon,
  output: OutputModuleIcon,
}

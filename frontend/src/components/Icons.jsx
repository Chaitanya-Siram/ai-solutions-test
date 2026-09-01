// Minimal inline SVG icons (no icon dependency). Each is a 1.6px-stroke,
// 24x24 line icon that inherits `currentColor`.
const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export const PulseIcon = (p) => (
  <svg {...base} {...p}><path d="M3 12h4l2-7 4 14 2-7h6" /></svg>
)
export const EyeIcon = (p) => (
  <svg {...base} {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
)
export const LayersIcon = (p) => (
  <svg {...base} {...p}><path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></svg>
)
export const BoltIcon = (p) => (
  <svg {...base} {...p}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></svg>
)
export const StarIcon = (p) => (
  <svg {...base} {...p}><path d="m12 3 2.7 5.5 6 .9-4.3 4.2 1 6L12 17l-5.4 2.6 1-6L3.3 9.4l6-.9L12 3Z" /></svg>
)
export const BarsIcon = (p) => (
  <svg {...base} {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
)
export const ArrowRightIcon = (p) => (
  <svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
)
export const RefreshIcon = (p) => (
  <svg {...base} {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" /></svg>
)
export const ChatIcon = (p) => (
  <svg {...base} {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" /></svg>
)
export const SendIcon = (p) => (
  <svg {...base} {...p}><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></svg>
)
export const CloseIcon = (p) => (
  <svg {...base} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>
)
export const EditIcon = (p) => (
  <svg {...base} {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" /></svg>
)
export const PlusIcon = (p) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
)
export const PlayIcon = (p) => (
  <svg {...base} {...p}><path d="M6 4l14 8-14 8V4z" /></svg>
)
export const SettingsIcon = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
)
export const BellIcon = (p) => (
  <svg {...base} {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
)
export const MoonIcon = (p) => (
  <svg {...base} {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
)
export const SunIcon = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
)
export const TrashIcon = (p) => (
  <svg {...base} {...p}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
)
export const ClockIcon = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
)
export const ArrowLeftIcon = (p) => (
  <svg {...base} {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
)
export const SearchIcon = (p) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
)
export const UploadIcon = (p) => (
  <svg {...base} {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 9l5-5 5 5M12 4v12" /></svg>
)
export const DownloadIcon = (p) => (
  <svg {...base} {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
)
export const MergeIcon = (p) => (
  <svg {...base} {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7M8.5 6.5H13a3 3 0 0 1 3 3v.5" /></svg>
)
export const DashboardIcon = (p) => (
  <svg {...base} {...p}><path d="M5 20V10M12 20V4M19 20v-7" /></svg>
)
export const CheckIcon = (p) => (
  <svg {...base} {...p}><path d="M20 6 9 17l-5-5" /></svg>
)
export const ChevronDownIcon = (p) => (
  <svg {...base} {...p}><path d="m6 9 6 6 6-6" /></svg>
)
export const SpreadsheetIcon = (p) => (
  <svg {...base} {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
)
export const FileTextIcon = (p) => (
  <svg {...base} {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2" /></svg>
)
export const BracesIcon = (p) => (
  <svg {...base} {...p}><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" /></svg>
)
export const FileIcon = (p) => (
  <svg {...base} {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>
)
export const WorkflowIcon = (p) => (
  <svg {...base} {...p}><rect x="3" y="9" width="6" height="6" rx="1.5" /><rect x="15" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M9 12h3.5a1.5 1.5 0 0 0 1.5-1.5V7M9 12h3.5a1.5 1.5 0 0 1 1.5 1.5V17" /></svg>
)

// Rotating palette of pastel icon tiles, matching the reference design.
export const TILES = [
  { bg: '#fce7f3', fg: '#db2777', Icon: PulseIcon },
  { bg: '#ede9fe', fg: '#7c3aed', Icon: EyeIcon },
  { bg: '#d1fae5', fg: '#059669', Icon: LayersIcon },
  { bg: '#fef3c7', fg: '#d97706', Icon: BoltIcon },
  { bg: '#e0e7ff', fg: '#4f46e5', Icon: StarIcon },
  { bg: '#dbeafe', fg: '#2563eb', Icon: BarsIcon },
]

export function tileFor(index) {
  return TILES[index % TILES.length]
}

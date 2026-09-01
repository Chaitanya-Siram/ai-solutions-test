import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

const PALETTE = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#14b8a6', '#f43f5e', '#a855f7', '#0ea5e9']
const SENT_COLORS = {
  POS: '#10b981', NEG: '#ef4444', NEU: '#94a3b8',
  Positive: '#10b981', Negative: '#ef4444', Neutral: '#94a3b8',
}

function colorFor(key, i) {
  return SENT_COLORS[key] || PALETTE[i % PALETTE.length]
}

// Coerce whatever the sandbox returned into an array of row objects.
function toRows(data) {
  if (Array.isArray(data)) return data.filter((r) => r && typeof r === 'object')
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([name, v]) => ({
      name,
      value: v && typeof v === 'object' ? (v.value ?? v.count ?? 0) : v,
    }))
  }
  return []
}

function nameKeyOf(rows) {
  if (!rows.length) return 'name'
  const row = rows[0]
  for (const k of ['name', 'label', 'category', 'theme', 'brand', 'domain', 'source', 'date', 'x', 'key', 'group']) {
    if (k in row) return k
  }
  for (const k of Object.keys(row)) if (typeof row[k] !== 'number') return k
  return Object.keys(row)[0] || 'name'
}

function valueKeysOf(rows, series, nameKey) {
  if (Array.isArray(series) && series.length) return series
  if (!rows.length) return ['value']
  const keys = Object.keys(rows[0]).filter((k) => k !== nameKey && typeof rows[0][k] === 'number')
  return keys.length ? keys : ['value']
}

const nf = (n) =>
  typeof n === 'number' ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : n

export default function AgentChart({ chart, height = 280 }) {
  if (!chart) return null
  if (chart.error) {
    return <div className="agentchart__err">Couldn’t build this chart: {chart.error}</div>
  }

  const type = String(chart.chart_type || 'bar').toLowerCase().trim()
  const rows = toRows(chart.data)
  if (!rows.length && type !== 'kpi') {
    return <div className="agentchart__err">No data returned for this chart.</div>
  }
  const nameKey = nameKeyOf(rows)
  const valueKeys = valueKeysOf(rows, chart.series, nameKey)

  // KPI / gauge → single big number.
  if (type === 'kpi' || type === 'gauge') {
    const v = rows.length ? rows[0][valueKeys[0]] ?? rows[0].value : chart?.data?.value
    return (
      <div className="agentchart__kpi">
        <span className="agentchart__kpival">{typeof v === 'number' ? nf(v) : v ?? '—'}</span>
        {chart.y_label && <span className="agentchart__kpilbl">{chart.y_label}</span>}
      </div>
    )
  }

  // Table → dynamic columns from the row keys.
  if (type === 'table' || type === 'heatmap') {
    const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s }, new Set()))
    return (
      <div className="agentchart__tablewrap">
        <table className="agentchart__table">
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.slice(0, 60).map((r, i) => (
              <tr key={i}>{cols.map((c) => <td key={c}>{typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c] ?? '—')}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // Pie / donut.
  if (type === 'pie' || type === 'donut') {
    const vk = valueKeys[0]
    const pieRows = rows.filter((r) => Number(r[vk]) > 0)
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={pieRows} dataKey={vk} nameKey={nameKey} innerRadius={type === 'donut' ? 58 : 0} outerRadius={92} paddingAngle={2}>
            {pieRows.map((r, i) => <Cell key={i} fill={colorFor(r[nameKey], i)} />)}
          </Pie>
          <Tooltip formatter={(v, n) => [nf(v), n]} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  // Scatter / bubble — needs two numeric axes; else fall through to bar.
  if ((type === 'scatter' || type === 'bubble') && valueKeys.length >= 2) {
    const [xk, yk, zk] = valueKeys
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 12, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis type="number" dataKey={xk} name={xk} tickFormatter={nf} fontSize={11} />
          <YAxis type="number" dataKey={yk} name={yk} fontSize={11} />
          {zk && <ZAxis type="number" dataKey={zk} range={[60, 500]} name={zk} />}
          <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v) => nf(v)} />
          <Scatter data={rows} fill="#6366f1" fillOpacity={0.7} />
        </ScatterChart>
      </ResponsiveContainer>
    )
  }

  // Line.
  if (type === 'line') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={nameKey} fontSize={11} />
          <YAxis fontSize={11} />
          <Tooltip formatter={(v) => nf(v)} />
          {valueKeys.length > 1 && <Legend />}
          {valueKeys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={colorFor(k, i)} strokeWidth={2.2} dot={{ r: 2 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    )
  }

  // Area.
  if (type === 'area') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={nameKey} fontSize={11} />
          <YAxis fontSize={11} />
          <Tooltip formatter={(v) => nf(v)} />
          {valueKeys.length > 1 && <Legend />}
          {valueKeys.map((k, i) => (
            <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={colorFor(k, i)} fill={colorFor(k, i)} fillOpacity={0.5} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    )
  }

  // Radar.
  if (type === 'radar') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <RadarChart data={rows} outerRadius="75%">
          <PolarGrid />
          <PolarAngleAxis dataKey={nameKey} fontSize={11} />
          <PolarRadiusAxis fontSize={10} />
          <Tooltip formatter={(v) => nf(v)} />
          {valueKeys.length > 1 && <Legend />}
          {valueKeys.map((k, i) => (
            <Radar key={k} dataKey={k} stroke={colorFor(k, i)} fill={colorFor(k, i)} fillOpacity={0.4} />
          ))}
        </RadarChart>
      </ResponsiveContainer>
    )
  }

  // Treemap.
  if (type === 'treemap') {
    const vk = valueKeys[0]
    const tmData = rows.map((r, i) => ({ name: r[nameKey], size: Number(r[vk]) || 0, fill: PALETTE[i % PALETTE.length] }))
    return (
      <ResponsiveContainer width="100%" height={height}>
        <Treemap data={tmData} dataKey="size" nameKey="name" stroke="#fff">
          <Tooltip formatter={(v) => nf(v)} />
        </Treemap>
      </ResponsiveContainer>
    )
  }

  // Default: bar family (bar / stacked bar / grouped bar / histogram / funnel / waterfall / column).
  const stacked = type.includes('stacked')
  const horizontal = rows.length > 8 // long category lists read better horizontally
  return (
    <ResponsiveContainer width="100%" height={Math.max(height, horizontal ? rows.length * 30 : height)}>
      <BarChart
        data={rows}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 8, right: 16, left: horizontal ? 8 : -8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        {horizontal ? (
          <>
            <XAxis type="number" fontSize={11} />
            <YAxis type="category" dataKey={nameKey} width={140} fontSize={11} />
          </>
        ) : (
          <>
            <XAxis dataKey={nameKey} fontSize={11} />
            <YAxis fontSize={11} />
          </>
        )}
        <Tooltip formatter={(v) => nf(v)} />
        {valueKeys.length > 1 && <Legend />}
        {valueKeys.map((k, i) => (
          <Bar key={k} dataKey={k} stackId={stacked ? 's' : undefined} fill={colorFor(k, i)} radius={horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0]}>
            {valueKeys.length === 1 && rows.map((r, ri) => <Cell key={ri} fill={colorFor(r[nameKey], ri)} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

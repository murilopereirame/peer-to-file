import { useId } from 'react'
import { formatBytes } from '@p2f/shared'

interface Props {
  label: string
  /** Samples oldest → newest; a short series scrolls in from the right. */
  values: number[]
  /** How many samples the series holds when full — fixes the x scale so the
   *  line scrolls across the chart instead of restretching on every tick. */
  capacity: number
  current: number
  /** Picks the accent the chart is drawn in (`currentColor` throughout). */
  tone: 'download' | 'upload'
  icon?: React.ReactNode
  /** Shorter chart, for the per-download panel. */
  compact?: boolean
}

// The viewBox is stretched to the element's box, so strokes are drawn with
// non-scaling-stroke to keep them an even width.
const VIEW_WIDTH = 300
const VIEW_HEIGHT = 100
// The plot is inset from the top and bottom edges. An idle series sits at
// zero, and a line drawn exactly on y = VIEW_HEIGHT has half its stroke
// clipped away by the viewBox — leaving the chart looking blank rather than
// looking idle. The top inset keeps a peak from being clipped the same way.
const PLOT_TOP = 6
const PLOT_BOTTOM = VIEW_HEIGHT - 4
// Fractions of the plot band, bottom (0) to top (1); the 0 line doubles as
// the chart's baseline axis so there is always something to read the line
// against.
const GRID_LINES = [0, 0.25, 0.5, 0.75, 1]

function rate (bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** Transfer speed over time, drawn as a filled line chart. */
export function SpeedChart ({ label, values, capacity, current, tone, icon, compact }: Props): React.JSX.Element {
  const gradientId = useId()
  const peak = values.reduce((max, value) => Math.max(max, value), 0)
  const average = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const scale = Math.max(peak, 1)

  // Held at full width by padding the *left* with the idle baseline, so the
  // series scrolls in from the right the way a bandwidth monitor does. Left
  // unpadded, a fresh series drew only as many pixels as it had samples —
  // for the first half-minute of a transfer that was a stub in the corner,
  // indistinguishable from no chart at all.
  const width = Math.max(capacity, 2)
  const series = values.length >= width
    ? values.slice(values.length - width)
    : [...new Array<number>(width - values.length).fill(0), ...values]

  const step = VIEW_WIDTH / (series.length - 1)
  const points = series.map((value, index) => {
    const x = index * step
    const y = PLOT_BOTTOM - (value / scale) * (PLOT_BOTTOM - PLOT_TOP)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  const line = `M ${points.join(' L ')}`
  const area = `${line} L ${VIEW_WIDTH},${VIEW_HEIGHT} L 0,${VIEW_HEIGHT} Z`

  return (
    <div className={`speed-chart ${tone}${compact ? ' compact' : ''}`}>
      <div className="chart-head">
        <span className="chart-label">{icon}{label}</span>
        <span className="chart-current">{rate(current)}</span>
      </div>

      <svg
        className="chart-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: currently ${rate(current)}, peak ${rate(peak)}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {GRID_LINES.map(fraction => {
          const y = PLOT_BOTTOM - fraction * (PLOT_BOTTOM - PLOT_TOP)
          return (
            <line
              key={fraction}
              className={fraction === 0 ? 'grid-line baseline' : 'grid-line'}
              x1="0"
              x2={VIEW_WIDTH}
              y1={y}
              y2={y}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )
        })}

        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="chart-foot">
        <span>avg {rate(average)}</span>
        <span>peak {rate(peak)}</span>
      </div>
    </div>
  )
}

import { useId } from 'react'
import { formatBytes } from '../lib/format'

interface Props {
  label: string
  /** Samples oldest → newest; a shorter series fills in from the right. */
  values: number[]
  /** How many samples the series holds when full — fixes the x scale so the
   *  line grows into the chart instead of restretching on every tick. */
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
const GRID_LINES = [0.25, 0.5, 0.75]

function rate (bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** Transfer speed over time, drawn as a filled line chart. */
export function SpeedChart ({ label, values, capacity, current, tone, icon, compact }: Props): React.JSX.Element {
  const gradientId = useId()
  const peak = values.reduce((max, value) => Math.max(max, value), 0)
  const average = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const scale = Math.max(peak, 1)

  // Newest sample sits at the right edge; a short series starts partway across.
  const step = VIEW_WIDTH / Math.max(capacity - 1, 1)
  const points = values.map((value, index) => {
    const x = VIEW_WIDTH - (values.length - 1 - index) * step
    const y = VIEW_HEIGHT - (value / scale) * VIEW_HEIGHT
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  const line = points.length > 1 ? `M ${points.join(' L ')}` : ''
  const area = points.length > 1
    ? `${line} L ${VIEW_WIDTH},${VIEW_HEIGHT} L ${(VIEW_WIDTH - (values.length - 1) * step).toFixed(2)},${VIEW_HEIGHT} Z`
    : ''

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

        {GRID_LINES.map(fraction => (
          <line
            key={fraction}
            className="grid-line"
            x1="0"
            x2={VIEW_WIDTH}
            y1={VIEW_HEIGHT * fraction}
            y2={VIEW_HEIGHT * fraction}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {area !== '' && <path d={area} fill={`url(#${gradientId})`} />}
        {line !== '' && (
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <div className="chart-foot">
        <span>avg {rate(average)}</span>
        <span>peak {rate(peak)}</span>
      </div>
    </div>
  )
}

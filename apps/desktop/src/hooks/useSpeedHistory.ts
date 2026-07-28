import { useEffect, useRef, useState } from 'react'

export interface SpeedSample {
  down: number
  up: number
}

/** How often a sample is taken, and how many are kept (1s × 90 = 1.5 minutes). */
export const SPEED_SAMPLE_MS = 1000
export const SPEED_HISTORY_SIZE = 90

interface HistoryState {
  /** What the samples belong to; a change starts a fresh series. */
  key: string
  samples: SpeedSample[]
}

/**
 * Keeps a rolling history of transfer speeds for the speed graphs.
 *
 * Sampling on a timer rather than on every render keeps the spacing even, so
 * the graph stays readable however often the underlying numbers update (the
 * download manager pushes a snapshot on every WebTorrent tick, uploads only
 * on XHR progress events). Passing a different `key` — a torrent path, say —
 * starts the series over rather than splicing two unrelated transfers
 * together.
 */
export function useSpeedHistory (
  key: string,
  down: number,
  up: number,
  sampleMs: number = SPEED_SAMPLE_MS,
  capacity: number = SPEED_HISTORY_SIZE
): SpeedSample[] {
  const latest = useRef({ key, down, up })
  const [state, setState] = useState<HistoryState>({ key, samples: [] })

  useEffect(() => {
    latest.current = { key, down, up }
  }, [key, down, up])

  useEffect(() => {
    const id = setInterval(() => {
      const current = latest.current
      setState(previous => (
        previous.key === current.key
          ? {
              key: current.key,
              samples: [...previous.samples, { down: current.down, up: current.up }].slice(-capacity)
            }
          : { key: current.key, samples: [{ down: current.down, up: current.up }] }
      ))
    }, sampleMs)
    return () => { clearInterval(id) }
  }, [sampleMs, capacity])

  return state.key === key ? state.samples : []
}

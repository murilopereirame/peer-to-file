import { useCallback, useEffect, useState } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage } from '../lib/format'

export interface HistoryEntry {
  id: number
  path: string
  name: string
  length: number
  completed_at: number
  info_hash: string | null
  duration_ms: number | null
}

/**
 * Server-persisted record of finished downloads (see /api/downloads/history).
 * `refreshSignal` is any value that changes once a new download completes —
 * bump it (e.g. a count of 'done' entries) rather than polling, since the
 * download manager already knows exactly when that happens.
 */
export function useDownloadHistory (refreshSignal: unknown): {
  entries: HistoryEntry[]
  loading: boolean
  error: string | null
  refresh: () => void
  clear: () => Promise<void>
} {
  const { apiFetch } = useApi()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    setLoading(true)
    void (async () => {
      try {
        // Refetched right as a download finishes, while its WebSeed
        // connections (up to maxWebConns) and the tracker WebSocket are
        // still winding down — some browsers throw a transient network
        // error (e.g. Firefox's "NetworkError when attempting to fetch
        // resource") if this races a saturated per-origin connection pool.
        // History is a convenience list, not load-bearing for the download
        // itself (recordHistory() already treats a failure here as
        // best-effort) — one retry after a short delay clears the race
        // without bothering the user over a blip that resolves itself.
        let res: Response
        try {
          res = await apiFetch('/api/downloads/history')
        } catch {
          await new Promise(resolve => setTimeout(resolve, 800))
          res = await apiFetch('/api/downloads/history')
        }
        const body = await res.json() as { entries: HistoryEntry[] }
        setEntries(body.entries)
        setError(null)
      } catch (err) {
        setError(errMessage(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [apiFetch])

  useEffect(load, [load, refreshSignal])

  const clear = useCallback(async (): Promise<void> => {
    await apiFetch('/api/downloads/history/clear', { method: 'POST' })
    setEntries([])
  }, [apiFetch])

  return { entries, loading, error, refresh: load, clear }
}

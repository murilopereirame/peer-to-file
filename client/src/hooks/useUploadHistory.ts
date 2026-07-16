import { useCallback, useEffect, useState } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage } from '../lib/format'
import type { HistoryEntry } from './useDownloadHistory'

/**
 * Server-persisted record of finished uploads (see /api/uploads/history).
 * `refreshSignal` is any value that changes once a new upload completes.
 */
export function useUploadHistory (refreshSignal: unknown): {
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
        const res = await apiFetch('/api/uploads/history')
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
    await apiFetch('/api/uploads/history/clear', { method: 'POST' })
    setEntries([])
  }, [apiFetch])

  return { entries, loading, error, refresh: load, clear }
}

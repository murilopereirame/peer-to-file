import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { File } from 'expo-file-system'
import { errMessage } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from './AppContext'
import { beginDownload, relocateToDownloadFolder, type TransferStatus } from '../lib/transfers'
import { decryptFileInPlace } from '../lib/transferCrypto'

export interface DownloadEntry {
  id: string
  path: string
  name: string
  status: TransferStatus
  bytesWritten: number
  totalBytes: number
  error?: string
}

interface Ctx {
  downloads: DownloadEntry[]
  historyVersion: number
  start: (entry: { path: string, name: string, size: number | null }) => void
  pause: (id: string) => void
  resume: (id: string) => void
  cancel: (id: string) => void
  remove: (id: string) => void
}

const DownloadsContext = createContext<Ctx | null>(null)

export function useDownloads (): Ctx {
  const ctx = useContext(DownloadsContext)
  if (!ctx) throw new Error('useDownloads must be used inside DownloadsProvider')
  return ctx
}

export function DownloadsProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const app = useApp()
  const [downloads, setDownloads] = useState<DownloadEntry[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  const tasksRef = useRef(new Map<string, {
    task: { pauseAsync: () => Promise<void>, resumeAsync: () => Promise<File | null>, cancel: () => void }
    key: Uint8Array
    iv: Uint8Array
  }>())

  const patch = useCallback((id: string, fields: Partial<DownloadEntry>) => {
    setDownloads(prev => prev.map(d => d.id === id ? { ...d, ...fields } : d))
  }, [])

  const finish = useCallback((
    id: string, path: string, name: string, size: number, file: File | null, key: Uint8Array, iv: Uint8Array
  ) => {
    void (async () => {
      if (!file) { patch(id, { status: 'canceled' }); return }
      try {
        // The wire carries AES-256-CTR ciphertext (see cipherCache.ts /
        // torrents.ts server-side) — decrypt the completed download in
        // place before it's exposed to the user (Files app / SAF folder).
        await decryptFileInPlace(file, key, iv)
        await relocateToDownloadFolder(file, app.downloadDirUri)
        patch(id, { status: 'done', bytesWritten: size, totalBytes: size })
        if (app.client) {
          await withUnauthorizedRetry(app, () => app.client!.historyRecord(path, name, size)).catch(() => {})
        }
        setHistoryVersion(v => v + 1)
      } catch (err) {
        patch(id, { status: 'error', error: errMessage(err) })
      }
    })()
  }, [app, patch])

  const start = useCallback((entry: { path: string, name: string, size: number | null }) => {
    const id = entry.path
    const client = app.client
    if (!client) return
    setDownloads(prev => [
      { id, path: entry.path, name: entry.name, status: 'running', bytesWritten: 0, totalBytes: entry.size ?? 0 },
      ...prev.filter(d => d.id !== id)
    ])
    void (async () => {
      try {
        const { task, run, key, iv } = await withUnauthorizedRetry(app, () => beginDownload(client, entry, (bw, tb) => {
          patch(id, { bytesWritten: bw, totalBytes: tb > 0 ? tb : entry.size ?? 0 })
        }))
        tasksRef.current.set(id, { task, key, iv })
        const file = await run()
        finish(id, entry.path, entry.name, entry.size ?? 0, file, key, iv)
      } catch (err) {
        patch(id, { status: 'error', error: errMessage(err) })
      }
    })()
  }, [app, patch, finish])

  const pause = useCallback((id: string) => {
    patch(id, { status: 'paused' })
    void tasksRef.current.get(id)?.task.pauseAsync()
  }, [patch])

  const resume = useCallback((id: string) => {
    const tracked = tasksRef.current.get(id)
    const entry = downloads.find(d => d.id === id)
    if (!tracked || !entry) return
    patch(id, { status: 'running' })
    void (async () => {
      try {
        const file = await tracked.task.resumeAsync()
        finish(id, entry.path, entry.name, entry.totalBytes, file, tracked.key, tracked.iv)
      } catch (err) {
        patch(id, { status: 'error', error: errMessage(err) })
      }
    })()
  }, [downloads, patch, finish])

  const cancel = useCallback((id: string) => {
    tasksRef.current.get(id)?.task.cancel()
    tasksRef.current.delete(id)
    patch(id, { status: 'canceled' })
  }, [patch])

  const remove = useCallback((id: string) => {
    tasksRef.current.delete(id)
    setDownloads(prev => prev.filter(d => d.id !== id))
  }, [])

  return (
    <DownloadsContext.Provider value={{ downloads, historyVersion, start, pause, resume, cancel, remove }}>
      {children}
    </DownloadsContext.Provider>
  )
}

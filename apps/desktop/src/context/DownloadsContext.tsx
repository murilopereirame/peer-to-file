import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useApp } from './AppContext'
import { TorrentDownloadManager, type DownloadSnapshot } from '../lib/torrentDownloads'

interface Ctx {
  downloads: DownloadSnapshot[]
  start: (path: string, name: string) => void
  pause: (path: string) => void
  resume: (path: string) => void
  cancel: (path: string) => void
  remove: (path: string) => void
}

const DownloadsContext = createContext<Ctx | null>(null)

export function useDownloads (): Ctx {
  const ctx = useContext(DownloadsContext)
  if (!ctx) throw new Error('useDownloads must be used inside DownloadsProvider')
  return ctx
}

export function DownloadsProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const app = useApp()
  const managerRef = useRef<TorrentDownloadManager>(new TorrentDownloadManager())

  useEffect(() => {
    void managerRef.current.init((msg) => { console.error('WebTorrent error:', msg) })
  }, [])

  const downloads = useSyncExternalStore(
    (cb) => managerRef.current.subscribe(cb),
    () => managerRef.current.list()
  )

  const value = useMemo<Ctx>(() => ({
    downloads,
    start: (path, name) => { if (app.client) void managerRef.current.start(app.client, path, name) },
    pause: (path) => { managerRef.current.pause(path) },
    resume: (path) => { managerRef.current.resume(path) },
    cancel: (path) => { managerRef.current.cancel(path) },
    remove: (path) => { managerRef.current.remove(path) }
  }), [downloads, app.client])

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>
}

import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useApp } from './AppContext'
import { TorrentDownloadManager, type DownloadSnapshot } from '../lib/torrentDownloads'

interface Ctx {
  downloads: DownloadSnapshot[]
  /** Resolves false if the user cancelled the Save dialog ("Save as…", or
   * the "ask where to save each time" setting) — nothing was queued. */
  start: (path: string, name: string, mountId?: number, saveAs?: boolean) => Promise<boolean>
  pause: (path: string) => void
  resume: (path: string) => void
  cancel: (path: string) => void
  remove: (path: string) => void
  /** Re-downloads only the damaged/missing pieces of a finished download
   * whose checksum didn't match. */
  repair: (path: string) => void
  stopRepair: (path: string) => void
}

const DownloadsContext = createContext<Ctx | null>(null)

export function useDownloads (): Ctx {
  const ctx = useContext(DownloadsContext)
  if (!ctx) throw new Error('useDownloads must be used inside DownloadsProvider')
  return ctx
}

// One manager for the life of the app, not per mount of this provider. The
// provider lives inside the main shell, which unmounts whenever the app
// passes through the login screen; a per-mount manager meant a brand new
// WebTorrent client + stream server alongside the old one, which was never
// torn down. Both then answered the service worker's request for a file
// being saved, and the new one — which doesn't know that torrent — replied
// 404 and could win the race, failing the save.
let sharedManager: TorrentDownloadManager | null = null
function getManager (): TorrentDownloadManager {
  sharedManager ??= new TorrentDownloadManager()
  return sharedManager
}

export function DownloadsProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const app = useApp()
  const managerRef = useRef<TorrentDownloadManager>(getManager())

  // Lets a download that hits an expired session (the "preparing" request
  // can take minutes for a huge file) refresh it and carry on.
  const handleUnauthorizedRef = useRef(app.handleUnauthorized)
  handleUnauthorizedRef.current = app.handleUnauthorized
  useEffect(() => {
    managerRef.current.setReauth(async () => await handleUnauthorizedRef.current())
  }, [])

  useEffect(() => {
    // DownloadsProvider only mounts once phase === 'main' (see MainShell),
    // which requires app.client to already be set — this dependency is
    // just a safety net, not the expected first-render path.
    if (!app.client) return
    void managerRef.current.init((msg) => { console.error('WebTorrent error:', msg) }, app.client)
  }, [app.client])

  const downloads = useSyncExternalStore(
    (cb) => managerRef.current.subscribe(cb),
    () => managerRef.current.list()
  )

  const value = useMemo<Ctx>(() => ({
    downloads,
    start: async (path, name, mountId, saveAs = false) => {
      if (!app.client) return false
      return await managerRef.current.request(app.client, path, name, mountId, saveAs)
    },
    pause: (path) => { managerRef.current.pause(path) },
    resume: (path) => { managerRef.current.resume(path) },
    cancel: (path) => { managerRef.current.cancel(path) },
    remove: (path) => { managerRef.current.remove(path) },
    repair: (path) => { if (app.client) void managerRef.current.repair(app.client, path) },
    stopRepair: (path) => { managerRef.current.stopRepair(path) }
  }), [downloads, app.client])

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>
}

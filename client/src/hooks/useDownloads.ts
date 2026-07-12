import { useMemo, useSyncExternalStore } from 'react'
import { DownloadManager, type DownloadEntry } from '../lib/downloadManager'

let singleton: DownloadManager | null = null

/** The manager is a module-level singleton (like the old client.ts globals) — one WebTorrent client for the app's lifetime. */
export function useDownloadManager (onClientError: (msg: string) => void): DownloadManager {
  return useMemo(() => {
    singleton ??= new DownloadManager(onClientError)
    return singleton
  }, [])
}

export function useDownloads (manager: DownloadManager): DownloadEntry[] {
  return useSyncExternalStore(
    cb => manager.subscribe(cb),
    () => manager.getSnapshot()
  )
}

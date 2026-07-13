import { errMessage, type P2FClient } from '@p2f/shared'
import { loadWebTorrent } from './loadWebTorrent'
import { proxiedHttp, proxiedWs } from './localProxy'

export type DownloadStatus = 'preparing' | 'downloading' | 'paused' | 'saving' | 'done' | 'error'

export interface DownloadSnapshot {
  path: string
  name: string
  status: DownloadStatus
  progress: number
  downloaded: number
  length: number
  speedBytesPerSec: number
  numPeers: number
  message?: string
}

interface Tracked {
  torrent: WTTorrent
  webseed: string
  tick: ReturnType<typeof setInterval>
  lastWebseedRetry: number
}

function blank (path: string, name: string): DownloadSnapshot {
  return { path, name, status: 'preparing', progress: 0, downloaded: 0, length: 0, speedBytesPerSec: 0, numPeers: 0 }
}

function clickDownloadLink (href: string, filename?: string): void {
  const a = document.createElement('a')
  a.href = href
  if (filename) a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
}

/**
 * Real P2P transfers, same engine and transport as the browser web client
 * (WebTorrent over WebRTC, HTTP webseed fallback) — this is what
 * distinguishes the desktop app from the mobile one, whose native runtime
 * has no WebRTC/service-worker/OPFS to build this on. Deliberately trimmed
 * relative to the browser client: no OPFS chunk store, so pause/resume/
 * cancel work for the lifetime of the app but a download doesn't survive
 * quitting the app entirely — see apps/desktop/README.md.
 */
export class TorrentDownloadManager {
  private client: InstanceType<typeof window.WebTorrent> | null = null
  private streamServer: WTServer | null = null
  private readonly snapshots = new Map<string, DownloadSnapshot>()
  private readonly tracked = new Map<string, Tracked>()
  private readonly listeners = new Set<() => void>()
  // `list()` is used as `useSyncExternalStore`'s getSnapshot, which must
  // return a referentially-stable result when nothing changed — otherwise
  // React treats every render as "the store changed", which either spins
  // in an infinite update loop or throws "Maximum update depth exceeded"
  // and (with no Error Boundary anywhere) unmounts the whole app to a
  // blank screen. Cache the array and only rebuild it in notify().
  private cachedList: DownloadSnapshot[] = []

  async init (onError: (msg: string) => void): Promise<void> {
    await loadWebTorrent()
    this.client = new window.WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
    this.client.on('error', (err) => { onError(errMessage(err)) })
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) {
          await new Promise<void>(resolve => {
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
          })
        }
        this.streamServer = this.client.createServer({ controller: reg }, 'browser')
        this.streamServer.listen(0, () => {})
      } catch (err) {
        console.warn('streamed downloads unavailable, falling back to Blob saves:', err)
      }
    }
  }

  subscribe (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify (): void {
    this.cachedList = [...this.snapshots.values()]
    for (const l of this.listeners) l()
  }

  private set (path: string, patch: Partial<DownloadSnapshot>): void {
    const cur = this.snapshots.get(path) ?? blank(path, patch.name ?? path)
    this.snapshots.set(path, { ...cur, ...patch })
    this.notify()
  }

  list (): DownloadSnapshot[] {
    return this.cachedList
  }

  async start (client: P2FClient, path: string, name: string): Promise<void> {
    if (!this.client) return
    const existing = this.snapshots.get(path)
    if (existing && existing.status !== 'done' && existing.status !== 'error') return
    this.set(path, blank(path, name))
    try {
      const meta = await client.torrentMeta(path)
      const torrentFile = Uint8Array.from(atob(meta.torrentBase64), c => c.charCodeAt(0))
      this.set(path, { length: meta.length })

      // The webview enforces real CORS, which the server's fixed
      // `Access-Control-Allow-Origin: *` doesn't satisfy for these —
      // route both through the local proxy (src-tauri/src/proxy.rs)
      // instead of hitting the real server directly. The torrent file's
      // own baked-in tracker/webseed (the unproxied originals) are still
      // present too and will just fail silently alongside these.
      const [proxyWebseed, proxyAnnounce] = await Promise.all([
        proxiedHttp(meta.webseed),
        Promise.all(meta.announce.map(proxiedWs))
      ])

      this.client.add(torrentFile, { maxWebConns: 8, announce: proxyAnnounce }, torrent => {
        torrent.addWebSeed(proxyWebseed)
        this.track(client, torrent, proxyWebseed, path)
      })
    } catch (err) {
      this.set(path, { status: 'error', message: errMessage(err) })
    }
  }

  private track (client: P2FClient, torrent: WTTorrent, webseed: string, path: string): void {
    const tick = setInterval(() => {
      if (torrent.destroyed) { clearInterval(tick); return }
      if (torrent.numPeers === 0 && Date.now() - t.lastWebseedRetry > 5000) {
        t.lastWebseedRetry = Date.now()
        try { torrent.addWebSeed(webseed) } catch { /* already attached */ }
      }
      if (!torrent.paused) {
        this.set(path, {
          status: 'downloading', progress: torrent.progress, downloaded: torrent.downloaded,
          length: torrent.length, speedBytesPerSec: torrent.downloadSpeed, numPeers: torrent.numPeers
        })
      }
    }, 500)
    const t: Tracked = { torrent, webseed, tick, lastWebseedRetry: 0 }
    this.tracked.set(path, t)

    torrent.on('done', () => {
      void this.save(client, torrent, path)
    })
    torrent.on('error', (err) => {
      this.set(path, { status: 'error', message: errMessage(err) })
    })
  }

  pause (path: string): void {
    const t = this.tracked.get(path)
    if (!t) return
    t.torrent.pause()
    for (const wire of [...t.torrent.wires]) { try { (wire as unknown as { destroy: () => void }).destroy() } catch { /* gone */ } }
    this.set(path, { status: 'paused' })
  }

  resume (path: string): void {
    const t = this.tracked.get(path)
    if (!t) return
    t.torrent.resume()
    this.set(path, { status: 'downloading' })
  }

  cancel (path: string): void {
    const t = this.tracked.get(path)
    if (t) t.torrent.destroy({ destroyStore: true })
    this.tracked.delete(path)
    this.snapshots.delete(path)
    this.notify()
  }

  remove (path: string): void {
    this.snapshots.delete(path)
    this.notify()
  }

  /** Same three-tier save strategy as the browser client — see its
   * downloadManager.ts for the full rationale; reproduced independently
   * here since this is a separate app bundle. */
  private async save (client: P2FClient, torrent: WTTorrent, path: string): Promise<void> {
    this.set(path, { status: 'saving' })
    try {
      const file = torrent.files[0]
      if (!file) throw new Error('torrent has no files')

      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({ suggestedName: file.name })
        const writable = await handle.createWritable()
        await file.stream().pipeTo(writable)
      } else if (this.streamServer) {
        // No `download` attribute: the service worker's response already
        // sets Content-Disposition: attachment, and Tauri's on_download
        // hook (src-tauri/src/main.rs) redirects this into the user's
        // configured default download folder.
        clickDownloadLink(file.streamURL)
      } else {
        const chunks: Uint8Array[] = []
        const reader = file.stream().getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) chunks.push(value)
        }
        const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: file.type }))
        clickDownloadLink(url, file.name)
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      this.set(path, { status: 'done', progress: 1 })
      await client.historyRecord(path, file.name, file.length).catch(() => {})
    } catch (err) {
      this.set(path, { status: 'error', message: `save failed: ${errMessage(err)}` })
    }
  }
}

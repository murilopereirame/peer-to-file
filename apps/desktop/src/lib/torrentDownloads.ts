import {
  establishKeyWrap, ensureFileDecryptionPatched, errMessage, getServerEcdhPublicKey, importCtrKey, transferKeys,
  unwrapKeyMaterial, type P2FClient
} from '@p2f/shared'
import { loadWebTorrent } from './loadWebTorrent'
import { currentDownloadDir } from './electronApi'

export type DownloadStatus = 'preparing' | 'downloading' | 'paused' | 'saving' | 'done' | 'error'

export interface PeerInfo {
  type: string
  addr: string
  speedBytesPerSec: number
}

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
  infoHash?: string
  elapsedMs: number
  peers: PeerInfo[]
  /** Where the finished file landed — only known when saved via the
   * configured download folder (the `will-download` redirect); a manual
   * Save As pick leaves this unset since the OS doesn't hand the resulting
   * path back to the page. */
  savedTo?: string
}

interface Tracked {
  torrent: WTTorrent
  webseed: string
  tick: ReturnType<typeof setInterval>
  startedAt: number
  lastWebseedRetry: number
}

function blank (path: string, name: string): DownloadSnapshot {
  return { path, name, status: 'preparing', progress: 0, downloaded: 0, length: 0, speedBytesPerSec: 0, numPeers: 0, elapsedMs: 0, peers: [] }
}

function clickDownloadLink (href: string, filename?: string): void {
  const a = document.createElement('a')
  a.href = href
  if (filename) a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
}

function joinNativePath (dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

/**
 * Real P2P transfers, same engine and transport as the browser web client
 * (WebTorrent over WebRTC, HTTP webseed fallback) — this is what
 * distinguishes the desktop app from a plain HTTP client. Deliberately
 * trimmed relative to the browser client: no OPFS chunk store, so pause/
 * resume/cancel work for the lifetime of the app but a download doesn't
 * survive quitting the app entirely — see apps/README.md.
 */
export class TorrentDownloadManager {
  private client: InstanceType<typeof window.WebTorrent> | null = null
  private streamServer: WTServer | null = null
  private readonly snapshots = new Map<string, DownloadSnapshot>()
  private readonly tracked = new Map<string, Tracked>()
  private readonly listeners = new Set<() => void>()

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

  private notify (): void { for (const l of this.listeners) l() }

  private set (path: string, patch: Partial<DownloadSnapshot>): void {
    const cur = this.snapshots.get(path) ?? blank(path, patch.name ?? path)
    this.snapshots.set(path, { ...cur, ...patch })
    this.notify()
  }

  list (): DownloadSnapshot[] {
    return [...this.snapshots.values()]
  }

  async start (client: P2FClient, path: string, name: string): Promise<void> {
    if (!this.client) return
    const existing = this.snapshots.get(path)
    if (existing && existing.status !== 'done' && existing.status !== 'error') return
    this.set(path, blank(path, name))
    try {
      // ECDH key wrap (fresh ephemeral keypair per download) so the
      // transfer key below never crosses the wire in the clear — see
      // src/server/keyExchange.ts and packages/shared/src/browserCrypto.ts.
      const serverPublicKey = await getServerEcdhPublicKey(async () => client.info())
      const keyWrap = await establishKeyWrap(serverPublicKey)

      const meta = await client.torrentMeta(path, keyWrap.clientPublicKeyBase64)
      const torrentFile = Uint8Array.from(atob(meta.torrentBase64), c => c.charCodeAt(0))
      this.set(path, { length: meta.length, infoHash: meta.infoHash })

      // The wire carries AES-256-CTR ciphertext (see cipherCache.ts /
      // torrents.ts server-side) — register the key so the patched File
      // iterator (below) decrypts transparently, same as the web client.
      const keyMaterial = await unwrapKeyMaterial(keyWrap.wrapKey, meta.encKeyWrapped)
      transferKeys.set(meta.infoHash, {
        key: await importCtrKey(keyMaterial.subarray(0, 32)),
        iv: keyMaterial.subarray(32, 48)
      })

      this.client.add(torrentFile, { maxWebConns: 8 }, torrent => {
        if (torrent.files[0]) ensureFileDecryptionPatched(torrent.files[0])
        this.track(client, torrent, meta.webseed, path)
      })
    } catch (err) {
      this.set(path, { status: 'error', message: errMessage(err) })
    }
  }

  private track (client: P2FClient, torrent: WTTorrent, webseed: string, path: string): void {
    const t: Tracked = { torrent, webseed, startedAt: Date.now(), lastWebseedRetry: 0, tick: undefined as unknown as ReturnType<typeof setInterval> }
    t.tick = setInterval(() => {
      if (torrent.destroyed) { clearInterval(t.tick); return }
      if (torrent.numPeers === 0 && Date.now() - t.lastWebseedRetry > 5000) {
        t.lastWebseedRetry = Date.now()
        try { torrent.addWebSeed(webseed) } catch { /* already attached */ }
      }
      const elapsedMs = Date.now() - t.startedAt
      if (!torrent.paused) {
        const peers: PeerInfo[] = torrent.wires.map(wire => ({
          type: wire.type === 'webSeed' ? 'webseed' : (wire.type ?? 'unknown'),
          addr: wire.remoteAddress
            ? `${wire.remoteAddress}${wire.remotePort ? ':' + wire.remotePort : ''}`
            : wire.type === 'webSeed' ? 'server' : 'address unavailable',
          speedBytesPerSec: wire.downloadSpeed()
        }))
        this.set(path, {
          status: 'downloading', progress: torrent.progress, downloaded: torrent.downloaded,
          length: torrent.length, speedBytesPerSec: torrent.downloadSpeed, numPeers: torrent.numPeers,
          elapsedMs, peers
        })
      } else {
        this.set(path, { elapsedMs })
      }
    }, 500)
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
    if (t) {
      transferKeys.delete(t.torrent.infoHash)
      t.torrent.destroy({ destroyStore: true })
    }
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
        this.set(path, { status: 'done', progress: 1 })
      } else if (this.streamServer) {
        // No `download` attribute: the service worker's response already
        // sets Content-Disposition: attachment, and the main process's
        // `will-download` hook (electron/main.cts) redirects this into the
        // user's configured default download folder.
        clickDownloadLink(file.streamURL)
        const dir = await currentDownloadDir()
        this.set(path, { status: 'done', progress: 1, savedTo: dir ? joinNativePath(dir, file.name) : undefined })
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
        const dir = await currentDownloadDir()
        this.set(path, { status: 'done', progress: 1, savedTo: dir ? joinNativePath(dir, file.name) : undefined })
      }
      await client.historyRecord(path, file.name, file.length).catch(() => {})
    } catch (err) {
      this.set(path, { status: 'error', message: `save failed: ${errMessage(err)}` })
    }
  }
}

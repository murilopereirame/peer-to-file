// Framework-agnostic WebTorrent download engine, ported from the previous
// vanilla-DOM client. Kept outside React on purpose: it owns long-lived,
// highly stateful objects (the WebTorrent client, per-download tick timers,
// service worker registration) that don't map cleanly onto component
// lifecycles. React consumes it as an external store (see
// hooks/useDownloads.ts) via subscribe()/getSnapshot().
import type { WTTorrent, WTServer } from './webtorrent-types'
import { OpfsChunkStore } from './opfsChunkStore'
import { errMessage } from './format'
import {
  establishKeyWrap, ensureFileDecryptionPatched, getServerEcdhPublicKey, importCtrKey, transferKeys,
  unwrapKeyMaterial
} from '@p2f/shared'

export type DownloadStatus =
  | 'preparing' | 'downloading' | 'waiting' | 'paused' | 'saving' | 'done' | 'error'

export interface PeerInfo {
  type: string
  addr: string
  speedBytesPerSec: number
}

export interface DownloadEntry {
  path: string
  name: string
  status: DownloadStatus
  message?: string
  progress: number
  downloaded: number
  length: number
  speedBytesPerSec: number
  etaMs: number
  numPeers: number
  infoHash?: string
  elapsedMs: number
  peers: PeerInfo[]
  canPause: boolean
  paused: boolean
  /** Whether track() has run at least once — distinguishes an early add-failure from a mid-transfer one. */
  started: boolean
}

type ApiFetch = (pathname: string, init?: RequestInit) => Promise<Response>

interface SavedDownload {
  path: string
  name: string
  paused?: boolean
  infoHash?: string
  lastActiveAt: number
  pendingCleanup?: boolean
}

const STALE_DOWNLOAD_MS = 14 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 30_000
// Grace period after the OPFS store reports every piece has been read back
// out at least once (see OpfsChunkStore.onAllRead) — the real completion
// signal for a save with no other one, giving the OS/browser a moment to
// finish flushing the last bytes to disk before pieces are reclaimed.
const POST_READ_CLEANUP_DELAY_MS = 15_000
// Safety-net fallback only, for when the read-completion signal never
// fires at all (OPFS unavailable, so no store to track, or something else
// went wrong): long enough that it should never legitimately still be
// mid-stream, since real completion is normally caught by the delay above
// regardless of file size or transfer speed.
const MAX_PENDING_CLEANUP_DELAY_MS = 30 * 60_000

function savedDownloads (): SavedDownload[] {
  try {
    return JSON.parse(localStorage.getItem('p2f-downloads') ?? '[]') as SavedDownload[]
  } catch {
    return []
  }
}

function persistDownload (entry: SavedDownload): void {
  const list = savedDownloads().filter(d => d.path !== entry.path)
  list.push(entry)
  localStorage.setItem('p2f-downloads', JSON.stringify(list))
}

function touchDownload (path: string, patch: Partial<SavedDownload> = {}): void {
  const existing = savedDownloads().find(d => d.path === path)
  if (!existing) return
  persistDownload({ ...existing, ...patch, lastActiveAt: Date.now() })
}

function forgetDownload (path: string): void {
  localStorage.setItem('p2f-downloads', JSON.stringify(savedDownloads().filter(d => d.path !== path)))
}

function clickDownloadLink (href: string, filename?: string): void {
  const a = document.createElement('a')
  a.href = href
  if (filename) a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
}

interface Tracked {
  torrent: WTTorrent
  webseed: string
  finished: boolean
  tick: ReturnType<typeof setInterval>
  startedAt: number
  lastWebseedRetry: number
  lastTouch: number
  smoothedSpeed: number
}

function blankEntry (path: string, name: string): DownloadEntry {
  return {
    path,
    name,
    status: 'preparing',
    progress: 0,
    downloaded: 0,
    length: 0,
    speedBytesPerSec: 0,
    etaMs: Infinity,
    numPeers: 0,
    elapsedMs: 0,
    peers: [],
    canPause: false,
    paused: false,
    started: false
  }
}

export class DownloadManager {
  private readonly client: InstanceType<typeof window.WebTorrent>
  private streamServer: WTServer | null = null
  private readonly entries = new Map<string, DownloadEntry>()
  private readonly tracked = new Map<string, Tracked>()
  private readonly listeners = new Set<() => void>()
  private snapshot: DownloadEntry[] = []
  private restored = false
  // Stashed from the most recent start() call so completeSave() can record
  // download history without every intermediate method having to thread an
  // apiFetch parameter through just for this — there's only ever one, reused
  // across the app (see App.tsx).
  private apiFetch: ApiFetch | null = null

  constructor (onClientError: (msg: string) => void) {
    // No STUN/TURN: both peers sit on the same VPN, host candidates are enough.
    this.client = new window.WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
    this.client.on('error', (err: unknown) => onClientError(errMessage(err)))
    this.registerServiceWorker()
  }

  // Streamed saving: WebTorrent's own service worker pipes a file's data
  // straight from its chunk store to the browser's native download mechanism
  // (Content-Disposition: attachment), so a completed download never has to
  // be materialized as one in-memory Blob first — the fix for OOM on huge
  // files and for Safari's much smaller Blob size limit. This needs a secure
  // context; on plain HTTP we fall back to a chunked Blob (see saveFile).
  private registerServiceWorker (): void {
    if (!(window.isSecureContext && 'serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(async registration => {
        // .ready only means *a* worker is active for this scope — on this
        // page's first-ever visit that worker still needs a moment to
        // actually take control of the open page. Wait for that before
        // trusting streamed saves, or the first stream request 404s.
        if (!navigator.serviceWorker.controller) {
          await new Promise<void>(resolve => {
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
          })
        }
        this.streamServer = this.client.createServer({ controller: registration }, 'browser')
        this.streamServer.listen(0, () => {})
      })
      .catch((err: unknown) => {
        console.warn('streamed downloads unavailable, falling back to in-memory saves:', err)
      })
  }

  subscribe (cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  getSnapshot (): DownloadEntry[] {
    return this.snapshot
  }

  private notify (): void {
    this.snapshot = [...this.entries.values()]
    for (const cb of this.listeners) cb()
  }

  private setEntry (path: string, patch: Partial<DownloadEntry>): void {
    const existing = this.entries.get(path)
    if (!existing) return
    this.entries.set(path, { ...existing, ...patch })
    this.notify()
  }

  /**
   * Runs once, the first time the browser view is shown: reap stale/orphaned
   * OPFS stores, then re-add every saved download so refreshed/reopened tabs
   * pick their transfers back up.
   */
  async init (apiFetch: ApiFetch): Promise<void> {
    if (this.restored) return
    this.restored = true
    await this.reconcile()
    for (const saved of savedDownloads()) {
      void this.start(saved.path, saved.name, apiFetch, { startPaused: saved.paused ?? false })
    }
  }

  private async reconcile (): Promise<void> {
    const list = savedDownloads()
    const now = Date.now()
    const keep: SavedDownload[] = []
    const reap = new Set<string>()

    for (const entry of list) {
      const abandoned = now - entry.lastActiveAt > STALE_DOWNLOAD_MS
      if (entry.pendingCleanup || abandoned) {
        if (entry.infoHash) reap.add(entry.infoHash)
        continue
      }
      keep.push(entry)
    }
    if (keep.length !== list.length) {
      localStorage.setItem('p2f-downloads', JSON.stringify(keep))
    }

    const trackedHashes = new Set(keep.map(e => e.infoHash).filter((h): h is string => Boolean(h)))
    for (const key of await OpfsChunkStore.listKeys()) {
      if (!trackedHashes.has(key)) reap.add(key)
    }
    await Promise.all([...reap].map(key => OpfsChunkStore.remove(key)))
  }

  async start (
    entryPath: string,
    name: string,
    apiFetch: ApiFetch,
    { startPaused = false } = {}
  ): Promise<void> {
    const existing = this.entries.get(entryPath)
    if (existing) {
      // still active: no-op, same as before. Finished (done/error): clicking
      // Download again re-queues it instead of requiring a manual Clear first.
      if (existing.status !== 'done' && existing.status !== 'error') return
      await this.restartAndWait(entryPath)
    }
    this.apiFetch = apiFetch
    this.entries.set(entryPath, blankEntry(entryPath, name))
    this.notify()

    try {
      // ECDH key wrap (fresh ephemeral keypair per download) so the
      // transfer key below never crosses the wire in the clear — see
      // src/server/keyExchange.ts and packages/shared/src/browserCrypto.ts.
      const serverPublicKey = await getServerEcdhPublicKey(async () => {
        const res = await apiFetch('/api/info')
        return await res.json() as { ecdhPublicKey: string }
      })
      const keyWrap = await establishKeyWrap(serverPublicKey)

      // The server hashes the file on first request — may take a while for
      // large files, hence the "preparing" state. Re-fetched on every start
      // so restored downloads get fresh transfer tokens (the infohash — and
      // with it the OPFS piece store — stays the same for unchanged files).
      const res = await apiFetch(
        `/api/torrent?path=${encodeURIComponent(entryPath)}&ck=${encodeURIComponent(keyWrap.clientPublicKeyBase64)}`
      )
      const meta = await res.json() as {
        infoHash: string
        length: number
        magnet: string
        webseed: string
        torrentBase64: string
        encKeyWrapped: string
      }
      const torrentFile = Uint8Array.from(atob(meta.torrentBase64), c => c.charCodeAt(0))
      persistDownload({
        path: entryPath, name, paused: startPaused,
        infoHash: meta.infoHash, lastActiveAt: Date.now()
      })
      this.setEntry(entryPath, { infoHash: meta.infoHash, length: meta.length })

      // The wire carries AES-256-CTR ciphertext (see cipherCache.ts /
      // torrents.ts server-side) — register the key so the patched File
      // iterator (below) can decrypt transparently once a torrent comes back.
      const keyMaterial = await unwrapKeyMaterial(keyWrap.wrapKey, meta.encKeyWrapped)
      transferKeys.set(meta.infoHash, {
        key: await importCtrKey(keyMaterial.subarray(0, 32)),
        iv: keyMaterial.subarray(32, 48)
      })

      const opfsAvailable = typeof navigator.storage?.getDirectory === 'function'
      this.client.add(torrentFile, {
        // more parallel webseed connections: smoother, higher throughput
        maxWebConns: 8,
        // persist verified pieces so a refreshed tab resumes, not restarts
        ...(opfsAvailable ? { store: OpfsChunkStore } : {})
      }, torrent => {
        if (torrent.files[0]) ensureFileDecryptionPatched(torrent.files[0])
        this.track(torrent, meta.webseed, entryPath, startPaused)
      })
    } catch (err) {
      this.setEntry(entryPath, { status: 'error', message: `failed: ${errMessage(err)}` })
    }
  }

  private pauseTorrent (torrent: WTTorrent): void {
    torrent.pause() // stop new peer connections
    // ...and drop live ones, so paused really means zero bandwidth
    for (const wire of [...torrent.wires]) {
      try { wire.destroy() } catch { /* already gone */ }
    }
  }

  private track (torrent: WTTorrent, webseed: string, entryPath: string, startPaused: boolean): void {
    const t: Tracked = {
      torrent, webseed, finished: false,
      tick: undefined as unknown as ReturnType<typeof setInterval>,
      startedAt: Date.now(), lastWebseedRetry: 0, lastTouch: 0, smoothedSpeed: 0
    }
    this.tracked.set(entryPath, t)

    if (startPaused) {
      this.pauseTorrent(torrent)
      this.setEntry(entryPath, { status: 'paused', paused: true, canPause: true, started: true })
    } else {
      this.setEntry(entryPath, { status: 'downloading', paused: false, canPause: true, started: true })
    }

    t.tick = setInterval(() => {
      if (t.finished || torrent.destroyed) { clearInterval(t.tick); return }

      const peers: PeerInfo[] = torrent.wires.map(wire => ({
        type: wire.type === 'webSeed' ? 'webseed' : wire.type,
        addr: wire.remoteAddress
          ? `${wire.remoteAddress}${wire.remotePort ? ':' + wire.remotePort : ''}`
          : wire.type === 'webSeed' ? 'server' : 'address unavailable',
        speedBytesPerSec: wire.downloadSpeed()
      }))
      const elapsedMs = Date.now() - t.startedAt

      if (torrent.paused) {
        t.smoothedSpeed = 0
        this.setEntry(entryPath, {
          progress: torrent.progress, downloaded: torrent.downloaded, length: torrent.length,
          speedBytesPerSec: 0, etaMs: Infinity, numPeers: torrent.numPeers, elapsedMs, peers
        })
        return
      }

      // exponential smoothing keeps the displayed speed from jumping around
      t.smoothedSpeed = t.smoothedSpeed === 0
        ? torrent.downloadSpeed
        : t.smoothedSpeed * 0.7 + torrent.downloadSpeed * 0.3
      const eta = t.smoothedSpeed > 0
        ? (torrent.length - torrent.downloaded) / t.smoothedSpeed * 1000
        : Infinity

      this.setEntry(entryPath, {
        status: torrent.numPeers === 0 ? 'waiting' : 'downloading',
        progress: torrent.progress, downloaded: torrent.downloaded, length: torrent.length,
        speedBytesPerSec: t.smoothedSpeed, etaMs: eta, numPeers: torrent.numPeers, elapsedMs, peers
      })

      if (Date.now() - t.lastTouch > TOUCH_INTERVAL_MS) {
        t.lastTouch = Date.now()
        touchDownload(entryPath)
      }

      // Resume watchdog. The WebRTC path re-establishes itself via tracker
      // re-announce; the webseed connection is not re-added by WebTorrent
      // after it dies, so when all sources are gone, re-attach it.
      if (torrent.numPeers === 0 && Date.now() - t.lastWebseedRetry > 5000) {
        t.lastWebseedRetry = Date.now()
        // a dead webconn can linger in the peer table and make addWebSeed a
        // silent no-op — clear it first
        try { torrent.removePeer(webseed) } catch { /* not present */ }
        try { torrent.addWebSeed(webseed) } catch { /* already attached */ }
      }
    }, 500)

    torrent.on('done', () => {
      if (t.finished) return
      t.finished = true
      clearInterval(t.tick)
      this.setEntry(entryPath, { canPause: false })
      void this.saveFile(torrent, entryPath)
    })

    torrent.on('error', (err: unknown) => {
      clearInterval(t.tick)
      this.setEntry(entryPath, { status: 'error', message: `failed: ${errMessage(err)}` })
    })
  }

  togglePause (path: string): void {
    const t = this.tracked.get(path)
    if (!t || t.finished || t.torrent.destroyed) return
    if (t.torrent.paused) {
      t.torrent.resume()
      t.lastWebseedRetry = 0 // let the watchdog re-attach the webseed right away
      this.setEntry(path, { status: 'downloading', paused: false })
      touchDownload(path, { paused: false })
    } else {
      this.pauseTorrent(t.torrent)
      this.setEntry(path, { status: 'paused', paused: true })
      touchDownload(path, { paused: true })
    }
  }

  /**
   * Force-destroys a previously finished (done/error) download's torrent so
   * it can be safely re-added, and waits for that teardown to fully finish —
   * not just for destroy() to be *called*. Store teardown (an OPFS directory
   * removal, via a worker) is asynchronous, so re-adding the same infoHash
   * before this resolves would race the old store's in-flight directory
   * removal against the new download's piece writes into that same
   * directory. This has to check torrent.destroyed, not our own t.finished —
   * t.finished is already true the moment a download reaches 'done' (see
   * track()), long before completeSave() actually destroys the torrent, so a
   * guard on t.finished would skip destroying it here. WebTorrent then treats
   * the re-add as a duplicate infoHash and hands back the *same*, already-
   * completed torrent object instead of downloading again — 'done' has
   * already fired once on it and never fires again for a newly attached
   * listener, so the UI gets stuck at 100%/downloading forever.
   *
   * Only used for an explicit restart. cancel() below intentionally does NOT
   * do this for an already-finished download — forcing an immediate destroy
   * there would reintroduce the large-file truncation bug (#38/#39): a
   * service-worker-streamed save has no completion signal of its own, so its
   * store is kept alive on a real-completion timer even after the UI already
   * shows 'done'. A restart is a deliberate user action that supersedes that
   * old save, so overriding it here is correct specifically for this path.
   */
  private restartAndWait (path: string): Promise<void> {
    const t = this.tracked.get(path)
    let destroyed: Promise<void> = Promise.resolve()
    if (t) {
      t.finished = true
      clearInterval(t.tick)
      transferKeys.delete(t.torrent.infoHash)
      if (!t.torrent.destroyed) {
        destroyed = new Promise(resolve => {
          t.torrent.destroy({ destroyStore: true }, () => resolve()) // free bandwidth AND stored pieces
        })
      }
    }
    forgetDownload(path)
    this.tracked.delete(path)
    this.entries.delete(path)
    this.notify()
    return destroyed
  }

  cancel (path: string): void {
    const t = this.tracked.get(path)
    if (t && !t.finished) {
      t.finished = true
      clearInterval(t.tick)
      transferKeys.delete(t.torrent.infoHash)
      t.torrent.destroy({ destroyStore: true }) // free bandwidth AND stored pieces
    }
    forgetDownload(path)
    this.tracked.delete(path)
    this.entries.delete(path)
    this.notify()
  }

  /**
   * Three ways to get a completed download onto disk, tried in order of how
   * little memory they use — none but the last builds a single in-memory
   * Blob sized to the whole file:
   *
   *  1. File System Access API: streams straight from the OPFS piece store
   *     to the chosen file with a small, bounded memory footprint, and gives
   *     a real completion promise — safe to reclaim the piece store the
   *     instant it resolves.
   *  2. WebTorrent's own service worker + an `<a>` click: streams to the
   *     browser's native download with no Blob ever created (this is what
   *     actually fixes Safari, whose Blob size limit is the reason a whole
   *     download can OOM there). There is no JS-visible "finished" signal
   *     for an anchor-triggered download, so the piece store is reclaimed
   *     after a grace period instead of immediately.
   *  3. Both of the above need a secure context; on plain HTTP a Blob is the
   *     only remaining option, built from the file's individual chunks
   *     (skips the extra full-size copy `file.blob()` does internally, but
   *     the memory footprint is still proportional to the file size).
   */
  private async saveFile (torrent: WTTorrent, entryPath: string): Promise<void> {
    this.setEntry(entryPath, { status: 'saving' })
    try {
      const file = torrent.files[0]
      if (!file) throw new Error('torrent has no files')

      if (window.showSaveFilePicker) {
        console.debug('[p2f] save tier 1: File System Access API')
        const handle = await window.showSaveFilePicker({ suggestedName: file.name })
        const writable = await handle.createWritable()
        await file.stream().pipeTo(writable)
        this.completeSave(torrent, entryPath, true)
      } else if (this.streamServer) {
        console.debug('[p2f] save tier 2: service worker stream, url =', file.streamURL)
        // Reads from here on are the service worker actually streaming the
        // file to the browser's download manager — start tracking now, not
        // from construction, or piece-verification reads already made
        // during the download itself (every piece is read back out and
        // hashed right after it's written) would make it look like the
        // save already finished before the browser has read a single byte.
        OpfsChunkStore.instances.get(torrent.infoHash)?.beginTrackingReads()
        // No `download` attribute here: the service worker's response
        // already carries Content-Disposition: attachment, so setting the
        // HTML attribute too makes Chromium cancel the download outright —
        // two competing "force download" signals on the same navigation.
        clickDownloadLink(file.streamURL)
        this.completeSave(torrent, entryPath, false)
      } else {
        console.debug('[p2f] save tier 3: chunked blob fallback')
        const chunks: Uint8Array<ArrayBuffer>[] = []
        for await (const chunk of file) chunks.push(chunk as Uint8Array<ArrayBuffer>)
        const url = URL.createObjectURL(new Blob(chunks, { type: file.type }))
        // blob: URLs carry no headers at all, so this one does need `download`.
        clickDownloadLink(url, file.name)
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        this.completeSave(torrent, entryPath, true)
      }
    } catch (err) {
      // The torrent (and its OPFS pieces) is left intact on failure — e.g.
      // the user cancelled a save-as dialog — so reloading the page picks
      // the already-complete download back up and offers to save it again.
      this.setEntry(entryPath, { status: 'error', message: `save failed: ${errMessage(err)}` })
    }
  }

  private recordHistory (entryPath: string): void {
    const entry = this.entries.get(entryPath)
    const apiFetch = this.apiFetch
    if (!entry || !apiFetch) return
    // Best-effort: history is a convenience list, not load-bearing for the
    // download itself, so a failure here doesn't surface as a save error.
    // Fired right as this download's own WebSeed connections and the
    // tracker WebSocket are winding down, which can trip a transient
    // per-origin connection-pool error in some browsers — one retry after a
    // short delay clears that without needing to touch the connection
    // count itself.
    const post = (): Promise<Response> => apiFetch('/api/downloads/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entryPath, name: entry.name, length: entry.length })
    })
    void post().catch(async () => {
      await new Promise(resolve => setTimeout(resolve, 800))
      await post()
    }).catch(() => {})
  }

  private completeSave (torrent: WTTorrent, entryPath: string, immediateCleanup: boolean): void {
    this.setEntry(entryPath, { status: 'done', progress: 1 })
    this.recordHistory(entryPath)
    if (immediateCleanup) {
      forgetDownload(entryPath)
      transferKeys.delete(torrent.infoHash)
      torrent.destroy({ destroyStore: true })
      return
    }
    touchDownload(entryPath, { pendingCleanup: true })

    let cleaned = false
    let safetyNet: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      clearTimeout(safetyNet)
      if (!torrent.destroyed) torrent.destroy({ destroyStore: true })
      transferKeys.delete(torrent.infoHash)
      forgetDownload(entryPath)
    }

    // The service-worker-streamed save (the no-completion-signal path this
    // branch handles) reads every piece back out of the store as it streams
    // the file to the browser's native download — previously this store was
    // reclaimed on a flat 2-minute timer regardless of file size, which for
    // a large/slow download destroyed the pieces (and broke the still-in-
    // flight stream, which Safari surfaces as a "stopped" download) well
    // before the browser had actually finished saving it. Real completion,
    // when available, now drives cleanup instead of a guessed timeout.
    const store = OpfsChunkStore.instances.get(torrent.infoHash)
    if (store) {
      // guard against the (unlikely, only possible for a very small/fast
      // file) race where every piece was already read back out before this
      // listener could be attached
      if (store.readComplete) {
        setTimeout(cleanup, POST_READ_CLEANUP_DELAY_MS)
      } else {
        store.onAllRead = () => { setTimeout(cleanup, POST_READ_CLEANUP_DELAY_MS) }
      }
    }
    safetyNet = setTimeout(cleanup, MAX_PENDING_CLEANUP_DELAY_MS)
  }
}

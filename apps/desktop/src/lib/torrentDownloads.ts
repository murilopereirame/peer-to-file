import {
  ApiError, createDownloadKeys, ensureFileDecryptionPatched, errMessage, getServerEcdhPublicKey, importCtrKey, OpfsChunkStore,
  opfsAvailable, rawKeyToBase64, transferKeys, type P2FClient, type PrepareProgress
} from '@p2f/shared'
import { loadWebTorrent } from './loadWebTorrent'
import { FsChunkStore } from './fsChunkStore'
import {
  askSavePath, awaitDownloadCompletion, cancelRepair, currentDownloadDir, hashFile, loadSavedDownloads,
  registerPendingDownload, repairSavedDownload, saveSavedDownloads, settings, type RepairPhase, type SavedDownload
} from './electronApi'

export type DownloadStatus = 'preparing' | 'downloading' | 'paused' | 'saving' | 'repairing' | 'done' | 'error'
export type ChecksumStatus = 'verifying' | 'ok' | 'mismatch' | 'unavailable'

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
  /** Where the finished file landed (as reported by Electron's download
   * manager once it's written). */
  savedTo?: string
  /** Destination picked up front via "Save as…" / "ask each time". */
  savePath?: string
  /** Compares the server's plaintext SHA-256 (independent of BitTorrent's
   * own per-piece hashing, which only covers the ciphertext) against the
   * saved file — catches decrypt bugs or a truncated/corrupted save that
   * piece verification alone wouldn't. */
  checksumStatus?: ChecksumStatus
  mountId?: number
  /** Progress of a running repair (status 'repairing'). */
  repair?: { phase: RepairPhase, done: number, total: number }
  /** How many damaged or missing pieces the last repair re-downloaded. */
  repairedPieces?: number
}

interface Tracked {
  torrent: WTTorrent
  webseed: string
  tick: ReturnType<typeof setInterval>
  startedAt: number
  lastWebseedRetry: number
  lastTouch: number
  /** Set as soon as 'done'/'error' fires, so the tick (below) stops
   * overwriting status/elapsedMs/speed after that — without this, a
   * still-running tick flips a finished download's status back to
   * 'downloading' every 500ms (torrent.paused stays false after done) and
   * keeps advancing elapsedMs against a now-static byte count, making the
   * displayed average speed drift for no reason. */
  finished: boolean
}

// Old enough that resuming it silently on the next launch would be more
// surprising than useful (the file may well have changed by then) — same
// cutoff the web client uses.
const STALE_DOWNLOAD_MS = 14 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 30_000

async function persistDownload (entry: SavedDownload): Promise<void> {
  const list = (await loadSavedDownloads()).filter(d => d.path !== entry.path)
  list.push(entry)
  await saveSavedDownloads(list)
}

async function touchDownload (path: string, patch: Partial<SavedDownload> = {}): Promise<void> {
  const list = await loadSavedDownloads()
  const existing = list.find(d => d.path === path)
  if (!existing) return
  await persistDownload({ ...existing, ...patch, lastActiveAt: Date.now() })
}

async function forgetDownload (path: string): Promise<void> {
  const list = await loadSavedDownloads()
  await saveSavedDownloads(list.filter(d => d.path !== path))
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

// Retrying the "preparing" requests. For a huge file the server reads and
// fingerprints the whole thing before answering /api/torrent, which can take
// many minutes — long enough that a flaky connection (or an expiring
// session) is likely to interrupt it. The server keeps working on it
// regardless and caches the result, so retrying simply picks it back up.
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 30_000
const MAX_CONSECUTIVE_AUTH_RETRIES = 3

/** Thrown out of start() when the user cancelled the download while it was
 * still preparing — not an error to show. */
class DownloadAborted extends Error {}

function isTransientError (err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500
}

const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

/** The status line while the server reads and hashes a file (p2f-lib waits it out). */
function preparingMessage (p: PrepareProgress): string {
  if (p.bytesTotal > 0) return `Server is preparing the file… ${Math.floor((100 * p.bytesDone) / p.bytesTotal)}%`
  return 'Waiting for the server to prepare the file…'
}

/**
 * Real P2P transfers, same engine and transport as the browser web client
 * (WebTorrent over WebRTC, HTTP webseed fallback) — this is what
 * distinguishes the desktop app from a plain HTTP client.
 *
 * Pieces go through our own on-disk chunk store (FsChunkStore, in the
 * user-chosen cache folder) rather than WebTorrent's default browser store,
 * for two reasons: only a store we own can release
 * individual pieces, which is what lets save() free the downloaded
 * ciphertext as it writes the decrypted file instead of holding all of it
 * until the save finishes (see FsChunkStore.startDraining) — and, same as
 * the browser web client, it's what lets a download resume mid-file rather
 * than restart from scratch across an app restart: the piece list persists
 * to disk independently of the (freshly re-created, every launch) WebTorrent
 * client object. The queue of what's in flight is persisted separately (see
 * persistDownload/loadSavedDownloads) and replayed by init() below.
 */
export class TorrentDownloadManager {
  private client: InstanceType<typeof window.WebTorrent> | null = null
  private streamServer: WTServer | null = null
  private readonly snapshots = new Map<string, DownloadSnapshot>()
  private readonly tracked = new Map<string, Tracked>()
  private readonly listeners = new Set<() => void>()
  // infoHash -> in-flight chunk-store teardown, so re-downloading the same
  // file doesn't race the previous attempt's piece-folder removal.
  private readonly storeTeardown = new Map<string, Promise<void>>()
  // Cached, only rebuilt in notify() — list() is used as useSyncExternalStore's
  // getSnapshot in DownloadsContext.tsx, which calls it on every render to
  // check for changes; a fresh array on every call (even when nothing
  // changed) makes React see a "change" every time and re-render forever
  // (error #185, "too many re-renders").
  private listSnapshot: DownloadSnapshot[] = []
  // init() is called from a mount effect keyed on `app.client` becoming
  // available — guards against a double-run re-queuing every saved download
  // twice if that effect ever re-fires.
  private initialized = false
  // Per-path token for the current start() attempt — cancel() drops it, so a
  // start() still preparing (possibly retrying for minutes) notices and stops
  // instead of adding a torrent nobody wants any more.
  private readonly attempts = new Map<string, symbol>()
  private reauth: (() => Promise<boolean>) | null = null
  // path -> id of the repair running for it, so it can be stopped.
  private readonly repairIds = new Map<string, string>()

  /** How to refresh an expired session (see DownloadsContext). Resolves true
   * if the session was refreshed. */
  setReauth (fn: () => Promise<boolean>): void {
    this.reauth = fn
  }

  /** Runs a request needed to prepare a download, retrying through
   * connection drops / server hiccups (with backoff, for as long as it
   * takes — the user can cancel) and expired sessions. Anything else (e.g.
   * the file no longer exists) fails immediately. */
  private async withRetry<T> (path: string, attempt: symbol, what: string, fn: () => Promise<T>): Promise<T> {
    let delay = RETRY_BASE_MS
    let authRetries = 0
    for (;;) {
      if (this.attempts.get(path) !== attempt) throw new DownloadAborted()
      try {
        const result = await fn()
        if (this.attempts.get(path) !== attempt) throw new DownloadAborted()
        if (this.snapshots.get(path)?.message) this.set(path, { message: undefined })
        return result
      } catch (err) {
        if (err instanceof DownloadAborted) throw err
        if (err instanceof ApiError && err.status === 401 && this.reauth && authRetries < MAX_CONSECUTIVE_AUTH_RETRIES) {
          authRetries++
          if (await this.reauth()) continue
          // Couldn't refresh right now — most likely the server is
          // unreachable too, so wait and try again like any other drop.
        } else if (!isTransientError(err)) {
          throw err
        }
        if (this.attempts.get(path) !== attempt) throw new DownloadAborted()
        this.set(path, { message: `Connection to the server lost while ${what} — retrying in ${Math.round(delay / 1000)}s…` })
        await sleep(delay)
        delay = Math.min(delay * 2, RETRY_MAX_MS)
      }
    }
  }

  /** `client` is only needed here to re-request torrent metadata for
   * whatever was still in flight when the app last quit — see the restore
   * loop at the end of this method. */
  async init (onError: (msg: string) => void, client: P2FClient): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await loadWebTorrent()
    FsChunkStore.defaultDir = await settings.getCacheDir()
    // Prunes anything stale (or already-finished, orphaned by a crash/force
    // quit before its store was destroyed) and reaps whatever OPFS pieces
    // aren't backing one of the downloads about to be resumed below — same
    // cost/benefit as before (a machine tight on space doesn't start the
    // next session still carrying dead weight), just no longer wiping pieces
    // that are actually going to be resumed.
    const toResume = await this.reconcile()
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
    for (const saved of toResume) {
      void this.start(client, saved.path, saved.name, saved.mountId, {
        startPaused: saved.paused ?? false, savePath: saved.savePath, cacheDir: saved.cacheDir
      })
    }
  }

  /** Drops anything abandoned long enough that silently resuming it would be
   * more surprising than useful, then reaps every piece set that isn't
   * backing one of the downloads being kept — mirrors the browser web
   * client's reconcile() in downloadManager.ts. Returns what's left to
   * resume.
   *
   * Looks in the current cache folder *and* every folder a kept download
   * started in (the setting may have changed since). Anything left in the
   * old OPFS store is from before the cache folder existed and is always
   * reaped — those downloads resume into the cache folder from scratch. */
  private async reconcile (): Promise<SavedDownload[]> {
    const list = await loadSavedDownloads()
    const now = Date.now()
    const keep: SavedDownload[] = []

    for (const entry of list) {
      const abandoned = now - entry.lastActiveAt > STALE_DOWNLOAD_MS
      if (!abandoned) keep.push(entry)
    }
    if (keep.length !== list.length) await saveSavedDownloads(keep)

    const currentDir = await settings.getCacheDir()
    const dirs = new Set([currentDir, ...keep.map(e => e.cacheDir).filter((d): d is string => Boolean(d))])
    for (const dir of dirs) {
      const tracked = new Set(keep.filter(e => (e.cacheDir ?? currentDir) === dir && e.infoHash).map(e => e.infoHash))
      const keys = await FsChunkStore.listKeys(dir)
      await Promise.all(keys.filter(k => !tracked.has(k)).map(k => FsChunkStore.remove(dir, k)))
    }
    // Abandoned downloads' parts, in whatever folder they started in.
    for (const entry of list) {
      if (!keep.includes(entry) && entry.infoHash && entry.cacheDir) await FsChunkStore.remove(entry.cacheDir, entry.infoHash)
    }

    if (opfsAvailable()) {
      await Promise.all((await OpfsChunkStore.listKeys()).map(key => OpfsChunkStore.remove(key)))
    }
    return keep
  }

  subscribe (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify (): void {
    this.listSnapshot = [...this.snapshots.values()]
    for (const l of this.listeners) l()
  }

  private set (path: string, patch: Partial<DownloadSnapshot>): void {
    const cur = this.snapshots.get(path) ?? blank(path, patch.name ?? path)
    this.snapshots.set(path, { ...cur, ...patch })
    this.notify()
  }

  list (): DownloadSnapshot[] {
    return this.listSnapshot
  }

  /** True while `path` is queued or transferring (a second request for it
   * would be ignored). */
  isActive (path: string): boolean {
    const existing = this.snapshots.get(path)
    return Boolean(existing && existing.status !== 'done' && existing.status !== 'error')
  }

  /**
   * Entry point for a download the user just asked for. With `saveAs` (the
   * "Save as…" action) or the "ask where to save each time" setting on, the
   * native Save dialog is shown *now* — so the user picks a place once and
   * the transfer can then finish unattended. Resolves false if the user
   * cancelled that dialog (nothing is started).
   */
  async request (client: P2FClient, path: string, name: string, mountId: number | undefined, saveAs = false): Promise<boolean> {
    if (this.isActive(path)) return true
    let savePath: string | undefined
    if (saveAs || await settings.getAskBeforeSave()) {
      const picked = await askSavePath(name)
      if (!picked) return false
      savePath = picked
    }
    void this.start(client, path, name, mountId, { savePath })
    return true
  }

  /** `startPaused` is only ever true when this is a restore on app startup
   * (see init()), replaying a download that was paused when the app last
   * quit — a fresh download from the UI always starts running. `cacheDir`
   * is likewise only passed on a restore, to keep using the folder the
   * download's parts are already in. */
  async start (
    client: P2FClient, path: string, name: string, mountId?: number,
    opts: { startPaused?: boolean, savePath?: string, cacheDir?: string } = {}
  ): Promise<void> {
    if (!this.client) return
    const { startPaused = false, savePath } = opts
    if (this.isActive(path)) return
    const attempt = Symbol(path)
    this.attempts.set(path, attempt)
    this.set(path, { ...blank(path, name), savePath, mountId })
    try {
      const cacheDir = opts.cacheDir ?? await settings.getCacheDir()
      // ECDH key wrap (fresh ephemeral keypair per download) so the
      // transfer key below never crosses the wire in the clear — see
      // src/server/keyExchange.ts and packages/shared/src/browserCrypto.ts.
      const serverPublicKey = await this.withRetry(path, attempt, 'connecting',
        async () => await getServerEcdhPublicKey(async () => await client.info()))
      const keys = await createDownloadKeys(rawKeyToBase64(serverPublicKey))

      // p2f-lib waits while the server prepares a big file (and retries
      // drops); withRetry still covers an expired session.
      const meta = await this.withRetry(path, attempt, 'preparing the file',
        async () => await client.torrentMeta(path, keys.clientPublicKeyBase64, mountId, {
          onPreparing: (p) => {
            if (this.attempts.get(path) !== attempt) throw new DownloadAborted()
            this.set(path, { message: preparingMessage(p) })
          }
        }))
      const torrentFile = Uint8Array.from(atob(meta.torrentBase64), c => c.charCodeAt(0))
      this.set(path, { length: meta.length, infoHash: meta.infoHash })
      // Recorded now (rather than only once fully done) so a quit mid-transfer
      // has something to resume from — see init()/reconcile().
      await persistDownload({ path, name, mountId, paused: startPaused, infoHash: meta.infoHash, savePath, cacheDir, lastActiveAt: Date.now() })

      // The wire carries AES-256-CTR ciphertext (encrypted on the fly
      // server-side, see torrents.ts) — register the key so the patched File
      // iterator (below) decrypts transparently, same as the web client.
      const transfer = keys.unwrap(meta.encKeyWrapped)
      keys.dispose()
      transferKeys.set(meta.infoHash, {
        key: await importCtrKey(transfer.key),
        iv: transfer.iv
      })
      transfer.key.fill(0)

      // A previous attempt at this exact file (completed or otherwise) may
      // still be registered under this infoHash. WebTorrent's own add()
      // doesn't refuse a duplicate by throwing to *us* — it silently hands
      // the *old* torrent back to the callback below instead of creating a
      // new one. For an already-finished old torrent that means attaching a
      // fresh 'done' listener to a torrent that already emitted 'done' once
      // in the past — which never fires again, so the UI gets stuck showing
      // 100% progress with a 'downloading' status forever. Clearing any
      // leftover first guarantees add() always creates a genuinely new
      // torrent.
      await this.forgetExisting(meta.infoHash)
      // ...and wait for that leftover's *store* to finish tearing down too.
      // The OPFS store is one directory per infoHash, removed recursively and
      // asynchronously; re-adding the same infoHash before that finishes would
      // race the old directory removal against the new download's piece writes
      // into the very same directory.
      await this.storeTeardown.get(meta.infoHash)

      FsChunkStore.dirs.set(meta.infoHash, cacheDir)
      this.client.add(torrentFile, {
        maxWebConns: 8,
        // Our own store, so save() can drain it piece by piece (see the class
        // comment) and so parts land in the user's chosen cache folder.
        store: FsChunkStore
      }, torrent => {
        if (torrent.files[0]) ensureFileDecryptionPatched(torrent.files[0])
        this.track(client, torrent, meta.webseed, path, meta.plainSha256, startPaused, savePath)
      })
    } catch (err) {
      // Cancelled while preparing: the entry is already gone, and set()
      // would bring it back as an error.
      if (err instanceof DownloadAborted || this.attempts.get(path) !== attempt) return
      this.set(path, { status: 'error', message: errMessage(err) })
    }
  }

  private async forgetExisting (infoHash: string): Promise<void> {
    if (!this.client) return
    const existing = await this.client.get(infoHash).catch(() => null)
    if (!existing || existing.destroyed) return
    this.destroyAndTrackTeardown(existing)
  }

  /**
   * Destroys a torrent along with its chunk store, and records a promise that
   * resolves once the store teardown has actually completed — see the wait in
   * start(). WebTorrent's own `remove()`/`destroy()` return as soon as the
   * teardown is *scheduled*, so without this there is no way to know when the
   * piece folder for an infoHash is really gone.
   */
  private destroyAndTrackTeardown (torrent: WTTorrent): void {
    const { infoHash } = torrent
    const done = new Promise<void>(resolve => {
      torrent.destroy({ destroyStore: true }, () => resolve())
    }).finally(() => {
      if (this.storeTeardown.get(infoHash) === done) this.storeTeardown.delete(infoHash)
    })
    this.storeTeardown.set(infoHash, done)
  }

  private track (
    client: P2FClient, torrent: WTTorrent, webseed: string, path: string, plainSha256: string | undefined,
    startPaused: boolean, savePath: string | undefined
  ): void {
    const t: Tracked = {
      torrent, webseed, startedAt: Date.now(), lastWebseedRetry: 0, lastTouch: 0, finished: false,
      tick: undefined as unknown as ReturnType<typeof setInterval>
    }
    this.tracked.set(path, t)

    if (startPaused) {
      torrent.pause()
      for (const wire of [...torrent.wires]) { try { (wire as unknown as { destroy: () => void }).destroy() } catch { /* gone */ } }
      this.set(path, { status: 'paused' })
    }

    const onDone = (): void => {
      if (t.finished) return
      t.finished = true
      clearInterval(t.tick)
      // The final tick can land slightly before WebTorrent's own 'done'
      // fires, so `downloaded` may be a few KB/MB short of `length` right
      // up until this point — set both explicitly rather than trusting
      // whatever the last tick happened to capture.
      this.set(path, { progress: 1, downloaded: torrent.length, length: torrent.length })
      void this.save(client, torrent, path, Date.now() - t.startedAt, plainSha256, savePath)
        .finally(() => { this.forgetTracked(path, torrent) })
    }
    const onError = (err: unknown): void => {
      if (t.finished) return
      t.finished = true
      clearInterval(t.tick)
      this.set(path, { status: 'error', message: errMessage(err) })
      this.forgetTracked(path, torrent)
    }

    // forgetExisting() in start() should mean add() always hands back a
    // genuinely new torrent, but as a safety net: a torrent that's already
    // done by the time it gets here would never fire 'done' again (it's a
    // one-time event, already emitted in its past), which is exactly the
    // "stuck at 100%, status stays 'downloading'" bug this class of issue
    // produces — handle it as immediately complete instead of waiting.
    if (torrent.progress >= 1 && !torrent.destroyed) { onDone(); return }

    t.tick = setInterval(() => {
      if (t.finished || torrent.destroyed) { clearInterval(t.tick); return }
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
      // Keeps a long-running download's `lastActiveAt` fresh so reconcile()
      // on the next launch doesn't mistake it for abandoned.
      if (Date.now() - t.lastTouch > TOUCH_INTERVAL_MS) {
        t.lastTouch = Date.now()
        void touchDownload(path)
      }
    }, 500)

    torrent.on('done', onDone)
    torrent.on('error', onError)
  }

  /** Once a download is truly finished (saved or failed), drop it from both
   * our own tracking and WebTorrent's client registry — otherwise it lingers
   * forever and a later re-download of the same file hits the stale-torrent
   * bug forgetExisting()/the progress>=1 guard above exist to work around.
   *
   * `destroyStore: true` is essential, not incidental: the chunk store keeps
   * the downloaded *ciphertext* in the cache folder (on disk). Destroying without it frees
   * the torrent but leaves that full second copy of every finished file sitting
   * on disk for the rest of the session — so a few large downloads balloon to
   * ~2x their size on disk. This is now the *tail* of the cleanup rather than
   * all of it: save() drains the store as it reads, so by the time this runs
   * only the last piece or two is left. It still matters for the paths that
   * never drain (a failed save) and for whatever the drain's
   * strictly-behind-the-read rule leaves over. */
  private forgetTracked (path: string, torrent: WTTorrent): void {
    this.tracked.delete(path)
    transferKeys.delete(torrent.infoHash)
    if (!torrent.destroyed) this.destroyAndTrackTeardown(torrent)
  }

  pause (path: string): void {
    const t = this.tracked.get(path)
    if (!t) return
    t.torrent.pause()
    for (const wire of [...t.torrent.wires]) { try { (wire as unknown as { destroy: () => void }).destroy() } catch { /* gone */ } }
    this.set(path, { status: 'paused' })
    void touchDownload(path, { paused: true })
  }

  resume (path: string): void {
    const t = this.tracked.get(path)
    if (!t) return
    t.torrent.resume()
    this.set(path, { status: 'downloading' })
    void touchDownload(path, { paused: false })
  }

  cancel (path: string): void {
    this.attempts.delete(path)
    this.stopRepair(path)
    const t = this.tracked.get(path)
    if (t) {
      transferKeys.delete(t.torrent.infoHash)
      if (!t.torrent.destroyed) this.destroyAndTrackTeardown(t.torrent)
    }
    this.tracked.delete(path)
    this.snapshots.delete(path)
    void forgetDownload(path)
    this.notify()
  }

  /** Only ever called for a `done`/`error` entry (see DownloadsScreen's
   * "Clear" button) — a `done` one is already gone from the saved list (see
   * save()), so this only matters for dropping an `error` one that would
   * otherwise be retried again on the next launch. */
  remove (path: string): void {
    this.snapshots.delete(path)
    void forgetDownload(path)
    this.notify()
  }

  /**
   * Lands the finished file on disk via Electron's download manager (see the
   * `will-download` hook in electron/main.cts): either at the exact path the
   * user picked when starting the download ("Save as…" / "ask each time"),
   * or in the default download folder.
   *
   * Either way, once the file is on disk it's checksummed against the
   * server's plaintext SHA-256 (`plainSha256`, from /api/torrent) — this is
   * deliberately separate from BitTorrent's own per-piece hashing, which
   * only proves the *ciphertext* arrived intact, not that this app's own
   * AES-CTR decrypt and save actually reproduced the original bytes.
   */
  private async save (
    client: P2FClient, torrent: WTTorrent, path: string, durationMs: number, plainSha256: string | undefined,
    savePath: string | undefined
  ): Promise<void> {
    this.set(path, { status: 'saving' })
    try {
      const file = torrent.files[0]
      if (!file) throw new Error('torrent has no files')

      // Only present if the server exposes it (see /api/torrent) — an older,
      // not-yet-upgraded server simply won't send this field, which must
      // read as "can't verify", not as a mismatch against `undefined`.
      if (!plainSha256) console.warn('[p2f] server did not provide a plaintext checksum for this file — is it running the latest version?')

      const saved = await this.saveToDisk(torrent, file, plainSha256, savePath)
      const { savedTo } = saved
      let { checksumStatus } = saved
      let message: string | undefined
      let repairedPieces: number | undefined

      // The saved file doesn't match the server's: find the pieces that are
      // missing or damaged and fetch just those again.
      if (checksumStatus === 'mismatch' && savedTo) {
        const outcome = await this.runRepair(client, path, savedTo, torrent.infoHash)
        // Cancelled (and cleared) while the repair ran.
        if (!this.snapshots.has(path)) return
        checksumStatus = outcome.checksumStatus
        message = outcome.message
        repairedPieces = outcome.repairedPieces
      }

      this.set(path, {
        status: 'done', progress: 1, downloaded: file.length, length: file.length, savedTo, checksumStatus,
        message, repairedPieces, repair: undefined
      })
      // Genuinely finished — nothing left to resume on a future launch. An
      // error, below, deliberately leaves the saved entry in place so it's
      // retried automatically next time instead of silently dropped.
      void forgetDownload(path)
      await client.historyRecord(path, file.name, file.length, torrent.infoHash, durationMs).catch(() => {})
    } catch (err) {
      this.set(path, { status: 'error', message: `save failed: ${errMessage(err)}` })
    }
  }

  /** Streams into `savePath`, or the configured default download folder —
   * see the `will-download` session hook in electron/main.cts, which is
   * what actually redirects the resulting native "download" there.
   * Registers for that hook's completion signal *before* triggering the
   * download, both to learn the real final save path (Electron may rename on
   * a collision, so this can differ from the `dir + file.name` guess) and to
   * know when it's safe to hash the result. */
  private async saveToDisk (
    torrent: WTTorrent, file: WTFile, plainSha256: string | undefined, savePath: string | undefined
  ): Promise<{ savedTo?: string, checksumStatus: ChecksumStatus }> {
    const dir = savePath ? undefined : await currentDownloadDir()
    const guessedPath = savePath ?? (dir ? joinNativePath(dir, file.name) : undefined)
    const ticketId = await registerPendingDownload(savePath)

    // Free each stored ciphertext piece as the read below moves past it, so
    // the piece cache shrinks while the saved file grows instead of both
    // sitting on disk at full size at the same time.
    FsChunkStore.startDrainingFor(torrent.infoHash)

    if (this.streamServer) {
      // No `download` attribute: the service worker's response already
      // sets Content-Disposition: attachment, and setting the HTML
      // attribute too makes Chromium cancel the download outright — two
      // competing "force download" signals on the same navigation.
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

    try {
      const info = await awaitDownloadCompletion(ticketId)
      // Cut off partway: whatever is (or isn't) at the destination is
      // incomplete, which a repair can fill in.
      if (info.state === 'interrupted' && info.path) return { savedTo: info.path, checksumStatus: plainSha256 ? 'mismatch' : 'unavailable' }
      if (info.state !== 'completed') return { savedTo: guessedPath, checksumStatus: 'unavailable' }
      const finalPath = info.path
      if (!plainSha256) return { savedTo: finalPath, checksumStatus: 'unavailable' }
      const actualSha256 = await hashFile(finalPath)
      if (actualSha256 !== null && actualSha256 !== plainSha256) {
        console.warn('[p2f] checksum mismatch', { path: finalPath, expected: plainSha256, actual: actualSha256 })
      }
      return { savedTo: finalPath, checksumStatus: actualSha256 === null ? 'unavailable' : actualSha256 === plainSha256 ? 'ok' : 'mismatch' }
    } catch {
      // No completion signal within the timeout — still likely saved fine
      // (this only means we couldn't confirm it), so keep the best-guess
      // path rather than losing "where did this go" entirely.
      return { savedTo: guessedPath, checksumStatus: 'unavailable' }
    }
  }

  /** "Repair" on a finished download whose checksum didn't match: checks the
   * saved file piece by piece and re-downloads only the bad pieces. */
  async repair (client: P2FClient, path: string): Promise<void> {
    const snap = this.snapshots.get(path)
    if (!snap || snap.status !== 'done' || !snap.savedTo || !snap.infoHash) return
    const outcome = await this.runRepair(client, path, snap.savedTo, snap.infoHash)
    if (!this.snapshots.has(path)) return
    this.set(path, { status: 'done', repair: undefined, ...outcome })
  }

  /** Stops a running repair. The download is left as it was (a mismatch). */
  stopRepair (path: string): void {
    const id = this.repairIds.get(path)
    if (!id) return
    this.repairIds.delete(path)
    this.attempts.delete(path)
    void cancelRepair(id)
  }

  /**
   * Fixes the saved file at `savedTo` in place (see electron/pieceRepair.cts):
   * every piece is checked against the torrent's piece hashes, and only the
   * missing or damaged ones are fetched again from the server's webseed, then
   * the whole file is checksummed again.
   *
   * Asks the server for fresh metadata first: the webseed's transfer token
   * from the original request may have expired during a long download, and
   * it confirms the file hasn't changed on the server since.
   */
  private async runRepair (
    client: P2FClient, path: string, savedTo: string, infoHash: string
  ): Promise<{ checksumStatus: ChecksumStatus, message?: string, repairedPieces?: number }> {
    const attempt = Symbol(path)
    this.attempts.set(path, attempt)
    const repairId = crypto.randomUUID()
    this.repairIds.set(path, repairId)
    this.set(path, { status: 'repairing', message: undefined, repair: { phase: 'verifying', done: 0, total: 0 } })
    try {
      const mountId = this.snapshots.get(path)?.mountId
      const serverPublicKey = await this.withRetry(path, attempt, 'starting the repair',
        async () => await getServerEcdhPublicKey(async () => await client.info()))
      const keys = await createDownloadKeys(rawKeyToBase64(serverPublicKey))
      const meta = await this.withRetry(path, attempt, 'starting the repair',
        async () => await client.torrentMeta(path, keys.clientPublicKeyBase64, mountId, {
          onPreparing: () => { if (this.attempts.get(path) !== attempt) throw new DownloadAborted() }
        }))
      if (meta.infoHash !== infoHash) {
        keys.dispose()
        return { checksumStatus: 'mismatch', message: 'the file changed on the server since it was downloaded — download it again' }
      }
      const transfer = keys.unwrap(meta.encKeyWrapped)
      keys.dispose()
      const result = await repairSavedDownload(repairId, {
        filePath: savedTo,
        torrent: Uint8Array.from(atob(meta.torrentBase64), c => c.charCodeAt(0)),
        key: transfer.key,
        iv: transfer.iv,
        webseed: meta.webseed
      }, (phase, done, total) => {
        if (this.repairIds.get(path) === repairId) this.set(path, { repair: { phase, done, total } })
      })
      if (result.damaged.length > 0) {
        console.warn(`[p2f] repaired ${result.damaged.length} of ${result.pieces} pieces`, { path: savedTo, pieces: result.damaged })
      }
      const actual = await hashFile(savedTo)
      const checksumStatus: ChecksumStatus = actual === null ? 'unavailable' : actual === meta.plainSha256 ? 'ok' : 'mismatch'
      return {
        checksumStatus,
        repairedPieces: result.damaged.length,
        message: checksumStatus === 'mismatch' ? 'still does not match the server after the repair' : undefined
      }
    } catch (err) {
      const stopped = err instanceof DownloadAborted || this.repairIds.get(path) !== repairId
      return { checksumStatus: 'mismatch', message: stopped ? 'repair stopped' : `repair failed: ${errMessage(err)}` }
    } finally {
      if (this.repairIds.get(path) === repairId) this.repairIds.delete(path)
      if (this.attempts.get(path) === attempt) this.attempts.delete(path)
    }
  }
}

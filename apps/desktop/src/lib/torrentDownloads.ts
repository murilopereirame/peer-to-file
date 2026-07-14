import {
  establishKeyWrap, ensureFileDecryptionPatched, errMessage, getServerEcdhPublicKey, importCtrKey, transferKeys,
  unwrapKeyMaterial, type P2FClient
} from '@p2f/shared'
import { loadWebTorrent } from './loadWebTorrent'
import { awaitDownloadCompletion, currentDownloadDir, hashFile, registerPendingDownload, settings } from './electronApi'

export type DownloadStatus = 'preparing' | 'downloading' | 'paused' | 'saving' | 'done' | 'error'
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
  /** Where the finished file landed — only known when saved via the
   * configured download folder (the `will-download` redirect); a manual
   * Save As pick leaves this unset since the OS doesn't hand the resulting
   * path back to the page. */
  savedTo?: string
  /** Compares the server's plaintext SHA-256 (independent of BitTorrent's
   * own per-piece hashing, which only covers the ciphertext) against the
   * saved file — catches decrypt bugs or a truncated/corrupted save that
   * piece verification alone wouldn't. */
  checksumStatus?: ChecksumStatus
}

interface Tracked {
  torrent: WTTorrent
  webseed: string
  tick: ReturnType<typeof setInterval>
  startedAt: number
  lastWebseedRetry: number
  /** Set as soon as 'done'/'error' fires, so the tick (below) stops
   * overwriting status/elapsedMs/speed after that — without this, a
   * still-running tick flips a finished download's status back to
   * 'downloading' every 500ms (torrent.paused stays false after done) and
   * keeps advancing elapsedMs against a now-static byte count, making the
   * displayed average speed drift for no reason. */
  finished: boolean
}

function isUserGestureError (err: unknown): boolean {
  return err instanceof Error && /user gesture/i.test(err.message)
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
  // Cached, only rebuilt in notify() — list() is used as useSyncExternalStore's
  // getSnapshot in DownloadsContext.tsx, which calls it on every render to
  // check for changes; a fresh array on every call (even when nothing
  // changed) makes React see a "change" every time and re-render forever
  // (error #185, "too many re-renders").
  private listSnapshot: DownloadSnapshot[] = []

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

      this.client.add(torrentFile, { maxWebConns: 8 }, torrent => {
        if (torrent.files[0]) ensureFileDecryptionPatched(torrent.files[0])
        this.track(client, torrent, meta.webseed, path, meta.plainSha256)
      })
    } catch (err) {
      this.set(path, { status: 'error', message: errMessage(err) })
    }
  }

  private async forgetExisting (infoHash: string): Promise<void> {
    if (!this.client) return
    try {
      await this.client.remove(infoHash, { destroyStore: true })
    } catch {
      // nothing registered under this infoHash — nothing to clear
    }
  }

  private track (client: P2FClient, torrent: WTTorrent, webseed: string, path: string, plainSha256: string | undefined): void {
    const t: Tracked = {
      torrent, webseed, startedAt: Date.now(), lastWebseedRetry: 0, finished: false,
      tick: undefined as unknown as ReturnType<typeof setInterval>
    }
    this.tracked.set(path, t)

    const onDone = (): void => {
      if (t.finished) return
      t.finished = true
      clearInterval(t.tick)
      // The final tick can land slightly before WebTorrent's own 'done'
      // fires, so `downloaded` may be a few KB/MB short of `length` right
      // up until this point — set both explicitly rather than trusting
      // whatever the last tick happened to capture.
      this.set(path, { progress: 1, downloaded: torrent.length, length: torrent.length })
      void this.save(client, torrent, path, Date.now() - t.startedAt, plainSha256)
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
    }, 500)

    torrent.on('done', onDone)
    torrent.on('error', onError)
  }

  /** Once a download is truly finished (saved or failed), drop it from both
   * our own tracking and WebTorrent's client registry — otherwise it lingers
   * forever and a later re-download of the same file hits the stale-torrent
   * bug forgetExisting()/the progress>=1 guard above exist to work around. */
  private forgetTracked (path: string, torrent: WTTorrent): void {
    this.tracked.delete(path)
    transferKeys.delete(torrent.infoHash)
    if (!torrent.destroyed) torrent.destroy()
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

  /**
   * Two ways to land the finished file on disk:
   *  - Automatic (default): stream into the configured default download
   *    folder with no dialog, via the `will-download` main-process hook
   *    (electron/main.cts) — same path whether or not a streamed service
   *    worker is available (falls back to an in-memory Blob otherwise).
   *  - Ask each time: the native Save dialog (`showSaveFilePicker`).
   *
   * `showSaveFilePicker` only works while still "handling a user gesture" —
   * a window that expires a few seconds after the click that started the
   * download, long before a slow key-exchange + torrent-metadata fetch +
   * the transfer itself finishes and this method actually runs. When that
   * window has closed, fall back to the automatic path instead of
   * surfacing an error for something the user can't control the timing of.
   *
   * Either way, once the file is on disk it's checksummed against the
   * server's plaintext SHA-256 (`plainSha256`, from /api/torrent) — this is
   * deliberately separate from BitTorrent's own per-piece hashing, which
   * only proves the *ciphertext* arrived intact, not that this app's own
   * AES-CTR decrypt and save actually reproduced the original bytes.
   */
  private async save (client: P2FClient, torrent: WTTorrent, path: string, durationMs: number, plainSha256: string | undefined): Promise<void> {
    this.set(path, { status: 'saving' })
    try {
      const file = torrent.files[0]
      if (!file) throw new Error('torrent has no files')

      // Only present if the server exposes it (see /api/torrent) — an older,
      // not-yet-upgraded server simply won't send this field, which must
      // read as "can't verify", not as a mismatch against `undefined`.
      if (!plainSha256) console.warn('[p2f] server did not provide a plaintext checksum for this file — is it running the latest version?')

      const askBeforeSave = await settings.getAskBeforeSave()
      let savedTo: string | undefined
      let checksumStatus: ChecksumStatus = 'unavailable'
      let pickerFailed = false

      if (askBeforeSave && window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: file.name })
          const writable = await handle.createWritable()
          await file.stream().pipeTo(writable)
          checksumStatus = plainSha256 ? await verifyBrowserFile(handle, plainSha256) : 'unavailable'
        } catch (err) {
          if (!isUserGestureError(err)) throw err
          pickerFailed = true
        }
      }

      if (!askBeforeSave || pickerFailed) {
        const result = await this.saveAutomatically(file, plainSha256)
        savedTo = result.savedTo
        checksumStatus = result.checksumStatus
      }

      this.set(path, { status: 'done', progress: 1, downloaded: file.length, length: file.length, savedTo, checksumStatus })
      await client.historyRecord(path, file.name, file.length, torrent.infoHash, durationMs).catch(() => {})
    } catch (err) {
      this.set(path, { status: 'error', message: `save failed: ${errMessage(err)}` })
    }
  }

  /** Streams into the configured default download folder — see the
   * `will-download` session hook in electron/main.cts, which is what
   * actually redirects the resulting native "download" there. Registers for
   * that hook's completion signal *before* triggering the download, both to
   * learn the real final save path (Electron may rename on a collision, so
   * this can differ from the `dir + file.name` guess) and to know when it's
   * safe to hash the result. */
  private async saveAutomatically (file: WTFile, plainSha256: string | undefined): Promise<{ savedTo?: string, checksumStatus: ChecksumStatus }> {
    const dir = await currentDownloadDir()
    const guessedPath = dir ? joinNativePath(dir, file.name) : undefined
    const ticketId = await registerPendingDownload()

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
      const finalPath = await awaitDownloadCompletion(ticketId)
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
}

/** SHA-256 of a File System Access API handle's on-disk contents, computed
 * in the renderer (no main-process round trip needed — the handle already
 * gives direct read access to what was just written). Loads the whole file
 * into memory for the digest, same trade-off the Blob-fallback save tier
 * already accepts. */
async function verifyBrowserFile (handle: { getFile: () => Promise<File> }, expectedSha256: string): Promise<ChecksumStatus> {
  try {
    const savedFile = await handle.getFile()
    const buf = await savedFile.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
    if (hex !== expectedSha256) {
      console.warn('[p2f] checksum mismatch', { expected: expectedSha256, actual: hex, bytes: buf.byteLength })
    }
    return hex === expectedSha256 ? 'ok' : 'mismatch'
  } catch {
    return 'unavailable'
  }
}

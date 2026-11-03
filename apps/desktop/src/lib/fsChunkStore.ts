// Disk-backed chunk store for WebTorrent, writing download parts into a
// folder the user picks (Settings → "Download cache folder") rather than the
// browser's private OPFS storage inside the app profile. Same contract and
// drain behaviour as @p2f/shared's OpfsChunkStore (see that file for the
// reasoning); the actual file I/O happens in the main process
// (electron/pieceCache.cts), since the sandboxed renderer can't touch disk.

import { SequentialReadCursor, transferReadProgress } from '@p2f/shared'

type StoreCb<T = void> = (err: Error | null, value?: T) => void

export class FsChunkStore {
  chunkLength: number
  length: number
  private readonly lastChunkIndex: number
  private readonly lastChunkLength: number
  private readonly key: string
  private readonly dir: string
  private draining = false
  private reapedUpTo = 0
  // How far the save's sequential read has got — fed by the file iterator,
  // never by get(), which WebTorrent also uses to serve other peers. See
  // readProgress.ts in @p2f/shared.
  private readonly cursor: SequentialReadCursor

  /** Live stores by infoHash — WebTorrent constructs these itself and only
   * ever gets the class from us, so this is how the download manager finds
   * the one backing a given torrent. */
  static readonly instances = new Map<string, FsChunkStore>()
  /** Which cache folder each infoHash should use — set by the download
   * manager right before `client.add()`, so a download keeps using the
   * folder it started in even if the setting changes mid-transfer. */
  static readonly dirs = new Map<string, string>()
  /** Folder for any torrent with no entry in `dirs`. */
  static defaultDir: string | null = null

  constructor (
    chunkLength: number,
    opts: { torrent?: { infoHash?: string }, length?: number, name?: string }
  ) {
    this.chunkLength = chunkLength
    this.length = opts.length ?? 0
    this.lastChunkIndex = Math.max(0, Math.ceil(this.length / chunkLength) - 1)
    this.lastChunkLength = this.length - this.lastChunkIndex * chunkLength
    this.key = opts.torrent?.infoHash ?? opts.name ?? 'unknown'
    const dir = FsChunkStore.dirs.get(this.key) ?? FsChunkStore.defaultDir
    if (!dir) throw new Error('download cache folder is not configured')
    this.dir = dir
    this.cursor = new SequentialReadCursor(chunkLength, this.length)
    FsChunkStore.instances.set(this.key, this)
    transferReadProgress.set(this.key, (start, end) => { this.onConsumed(start, end) })
  }

  static startDrainingFor (infoHash: string): void {
    FsChunkStore.instances.get(infoHash)?.startDraining()
  }

  static async remove (dir: string, key: string): Promise<void> {
    await window.p2f.cacheRemoveKey(dir, key).catch(() => {})
  }

  static async listKeys (dir: string): Promise<string[]> {
    return await window.p2f.cacheListKeys(dir).catch(() => [])
  }

  private expectedLength (index: number): number {
    return index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength
  }

  put (index: number, buf: Uint8Array, cb: StoreCb): void {
    window.p2f.cachePut(this.dir, this.key, index, buf).then(() => cb(null), (err: Error) => cb(err))
  }

  get (index: number, opts: { offset?: number, length?: number } | StoreCb<Uint8Array>, cb?: StoreCb<Uint8Array>): void {
    let options: { offset?: number, length?: number } = {}
    if (typeof opts === 'function') cb = opts
    else if (opts) options = opts
    const done = cb as StoreCb<Uint8Array>
    window.p2f.cacheGet(this.dir, this.key, index, options.offset ?? 0, options.length, this.expectedLength(index))
      .then(data => { done(null, data) }, (err: Error) => done(err))
  }

  /** The save has consumed file bytes [start, end). */
  onConsumed (start: number, end: number): void {
    this.cursor.advance(start, end)
    this.reap()
  }

  // Frees every piece the save's sequential read has fully passed — same
  // rule as OpfsChunkStore.
  private reap (): void {
    if (!this.draining) return
    const upTo = this.cursor.piecesBehind()
    if (upTo <= this.reapedUpTo) return
    const from = this.reapedUpTo
    this.reapedUpTo = upTo
    window.p2f.cacheRemovePieces(this.dir, this.key, from, upTo).catch(() => {})
  }

  /** One-way: from here on, pieces are deleted as the save reads past them. */
  startDraining (): void {
    this.draining = true
    this.reap()
  }

  close (cb: StoreCb): void { cb(null) }

  destroy (cb: StoreCb): void {
    if (FsChunkStore.instances.get(this.key) === this) {
      FsChunkStore.instances.delete(this.key)
      transferReadProgress.delete(this.key)
    }
    window.p2f.cacheRemoveKey(this.dir, this.key).then(() => cb(null), (err: Error) => cb(err))
  }
}

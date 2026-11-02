// Disk-backed chunk store for WebTorrent, writing download parts into a
// folder the user picks (Settings → "Download cache folder") rather than the
// browser's private OPFS storage inside the app profile. Same contract and
// drain behaviour as @p2f/shared's OpfsChunkStore (see that file for the
// reasoning); the actual file I/O happens in the main process
// (electron/pieceCache.cts), since the sandboxed renderer can't touch disk.

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
    FsChunkStore.instances.set(this.key, this)
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
    window.p2f.cacheGet(this.dir, this.key, index, options.offset ?? 0, options.length, this.expectedLength(index)).then(data => {
      done(null, data)
      // Free everything strictly before this piece once a sequential save
      // read has moved past it — see OpfsChunkStore.get for the details.
      if (this.draining && index > this.reapedUpTo) {
        const from = this.reapedUpTo
        this.reapedUpTo = index
        window.p2f.cacheRemovePieces(this.dir, this.key, from, index).catch(() => {})
      }
    }, (err: Error) => done(err))
  }

  /** One-way: from here on, pieces are deleted as the save reads past them. */
  startDraining (): void { this.draining = true }

  close (cb: StoreCb): void { cb(null) }

  destroy (cb: StoreCb): void {
    if (FsChunkStore.instances.get(this.key) === this) FsChunkStore.instances.delete(this.key)
    window.p2f.cacheRemoveKey(this.dir, this.key).then(() => cb(null), (err: Error) => cb(err))
  }
}

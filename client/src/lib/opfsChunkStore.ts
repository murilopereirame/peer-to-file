// OPFS chunk store: persists verified pieces in the browser's origin-private
// file system so a refreshed tab can resume a download instead of restarting.
// Implements the abstract-chunk-store interface WebTorrent expects; one file
// per piece under p2f-downloads/<infohash>/.

type StoreCb<T = void> = (err: Error | null, value?: T) => void

export class OpfsChunkStore {
  chunkLength: number
  length: number
  private readonly lastChunkIndex: number
  private readonly lastChunkLength: number
  private readonly key: string
  private readonly dirPromise: Promise<FileSystemDirectoryHandle>

  constructor (
    chunkLength: number,
    opts: { torrent?: { infoHash?: string }, length?: number, name?: string }
  ) {
    this.chunkLength = chunkLength
    this.length = opts.length ?? 0
    this.lastChunkIndex = Math.max(0, Math.ceil(this.length / chunkLength) - 1)
    this.lastChunkLength = this.length - this.lastChunkIndex * chunkLength
    this.key = opts.torrent?.infoHash ?? opts.name ?? 'unknown'
    this.dirPromise = OpfsChunkStore.dirFor(this.key)
  }

  static async dirFor (key: string): Promise<FileSystemDirectoryHandle> {
    const rootDir = await navigator.storage.getDirectory()
    const parent = await rootDir.getDirectoryHandle('p2f-downloads', { create: true })
    return parent.getDirectoryHandle(key, { create: true })
  }

  static async remove (key: string): Promise<void> {
    try {
      const rootDir = await navigator.storage.getDirectory()
      const parent = await rootDir.getDirectoryHandle('p2f-downloads')
      await parent.removeEntry(key, { recursive: true })
    } catch { /* nothing stored */ }
  }

  /** All infoHash keys currently holding pieces on disk — used to reap orphans on startup. */
  static async listKeys (): Promise<string[]> {
    try {
      const rootDir = await navigator.storage.getDirectory()
      const parent = await rootDir.getDirectoryHandle('p2f-downloads')
      const keys: string[] = []
      // FileSystemDirectoryHandle is async-iterable in browsers that support
      // OPFS, but TS's DOM lib doesn't declare that yet — cast to iterate.
      const iter = parent as unknown as AsyncIterable<[string, FileSystemHandle]>
      for await (const [name, handle] of iter) {
        if (handle.kind === 'directory') keys.push(name)
      }
      return keys
    } catch {
      return []
    }
  }

  private expectedLength (index: number): number {
    return index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength
  }

  put (index: number, buf: Uint8Array, cb: StoreCb): void {
    this.dirPromise.then(async dir => {
      const handle = await dir.getFileHandle(String(index), { create: true })
      const writable = await handle.createWritable()
      // cast: TS's DOM lib insists on non-shared ArrayBuffer backing
      await writable.write(buf as Uint8Array<ArrayBuffer>)
      await writable.close()
    }).then(() => cb(null), (err: Error) => cb(err))
  }

  get (index: number, opts: { offset?: number, length?: number } | StoreCb<Uint8Array>, cb?: StoreCb<Uint8Array>): void {
    let options: { offset?: number, length?: number } = {}
    if (typeof opts === 'function') {
      cb = opts
    } else if (opts) {
      options = opts
    }
    const done = cb as StoreCb<Uint8Array>
    this.dirPromise.then(async dir => {
      const handle = await dir.getFileHandle(String(index)) // throws if absent
      const file = await handle.getFile()
      if (file.size !== this.expectedLength(index)) {
        throw new Error(`chunk ${index} is incomplete`)
      }
      const offset = options.offset ?? 0
      const end = options.length !== undefined ? offset + options.length : file.size
      const buf = await file.slice(offset, end).arrayBuffer()
      return new Uint8Array(buf)
    }).then(data => done(null, data), (err: Error) => done(err))
  }

  close (cb: StoreCb): void { cb(null) }

  destroy (cb: StoreCb): void {
    OpfsChunkStore.remove(this.key).then(() => cb(null), (err: Error) => cb(err))
  }
}

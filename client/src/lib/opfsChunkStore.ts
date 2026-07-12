// OPFS chunk store: persists verified pieces in the browser's origin-private
// file system so a refreshed tab can resume a download instead of restarting.
// Implements the abstract-chunk-store interface WebTorrent expects; one file
// per piece under p2f-downloads/<infohash>/.
//
// All actual piece reads/writes are proxied to a dedicated worker (see
// opfsWorker.ts) that performs them with FileSystemSyncAccessHandle instead
// of the main-thread-only, async createWritable() stream. A sync access
// handle takes an exclusive lock on the file for its whole
// open/write-or-read/flush/close lifetime, so two writes (or a write and a
// read) can never race the same file, and a write is guaranteed durably
// flushed before close() returns. Safari's async OPFS writes have been
// observed to leave a file readable-but-truncated under concurrent access —
// this sidesteps that class of bug rather than working around one symptom.

import type { OpfsWorkerRequest, OpfsWorkerResponse } from './opfsWorkerProtocol'

type StoreCb<T = void> = (err: Error | null, value?: T) => void

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<number, { resolve: (v: Uint8Array | undefined) => void, reject: (err: Error) => void }>()

function getWorker (): Worker {
  if (!worker) {
    worker = new Worker(new URL('./opfsWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<OpfsWorkerResponse>) => {
      const res = ev.data
      const req = pending.get(res.id)
      if (!req) return
      pending.delete(res.id)
      if (res.ok) req.resolve(res.data)
      else req.reject(new Error(res.error ?? 'OPFS worker error'))
    }
  }
  return worker
}

function callWorker (req: Omit<OpfsWorkerRequest, 'id'>): Promise<Uint8Array | undefined> {
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ ...req, id } satisfies OpfsWorkerRequest)
  })
}

export class OpfsChunkStore {
  chunkLength: number
  length: number
  private readonly lastChunkIndex: number
  private readonly lastChunkLength: number
  private readonly totalChunks: number
  private readonly key: string

  // Instances keyed by infoHash, so code elsewhere (downloadManager.ts) can
  // find the store WebTorrent created internally for a given torrent — it
  // only ever hands us the *class*, not a reference to what it constructs.
  static readonly instances = new Map<string, OpfsChunkStore>()

  // WebTorrent reads every piece back out via get() during normal download
  // too — each piece is hashed to verify it right after it's written (see
  // Torrent.prototype._verifyPiece upstream) — so tracking reads from the
  // start would make readComplete true as soon as the download itself
  // finishes, nowhere near when a save has actually streamed the file
  // through. Tracking only starts once beginTrackingReads() is called,
  // which downloadManager.ts does right as the save-time read-through
  // begins, so only *that* pass over the pieces is ever counted.
  private armed = false
  private readonly readIndices = new Set<number>()
  /** True once every piece has been read back out at least once since beginTrackingReads() — check this before subscribing via onAllRead, in case it's already happened (a very small/fast file). */
  readComplete = false
  /**
   * Fires once every piece has been read back out at least once since
   * beginTrackingReads() — i.e. a consumer (the service worker streaming a
   * completed download) has pulled the whole file through. Used to detect
   * *real* completion of a save that has no other completion signal,
   * instead of guessing at a fixed timeout — see downloadManager.ts.
   */
  onAllRead: (() => void) | null = null

  /** Start tracking reads from this point on — call right before the actual save-time read-through begins (see downloadManager.ts). */
  beginTrackingReads (): void {
    this.armed = true
    this.readIndices.clear()
    this.readComplete = false
  }

  constructor (
    chunkLength: number,
    opts: { torrent?: { infoHash?: string }, length?: number, name?: string }
  ) {
    this.chunkLength = chunkLength
    this.length = opts.length ?? 0
    this.lastChunkIndex = Math.max(0, Math.ceil(this.length / chunkLength) - 1)
    this.lastChunkLength = this.length - this.lastChunkIndex * chunkLength
    this.totalChunks = this.lastChunkIndex + 1
    this.key = opts.torrent?.infoHash ?? opts.name ?? 'unknown'
    OpfsChunkStore.instances.set(this.key, this)
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
    callWorker({ op: 'put', key: this.key, index, buf }).then(
      () => cb(null),
      (err: Error) => cb(err)
    )
  }

  get (index: number, opts: { offset?: number, length?: number } | StoreCb<Uint8Array>, cb?: StoreCb<Uint8Array>): void {
    let options: { offset?: number, length?: number } = {}
    if (typeof opts === 'function') {
      cb = opts
    } else if (opts) {
      options = opts
    }
    const done = cb as StoreCb<Uint8Array>
    callWorker({
      op: 'get',
      key: this.key,
      index,
      offset: options.offset,
      length: options.length,
      expectedLength: this.expectedLength(index)
    }).then(data => {
      if (this.armed) {
        this.readIndices.add(index)
        if (!this.readComplete && this.readIndices.size >= this.totalChunks) {
          this.readComplete = true
          this.onAllRead?.()
        }
      }
      done(null, data as Uint8Array)
    }, (err: Error) => done(err))
  }

  close (cb: StoreCb): void { cb(null) }

  destroy (cb: StoreCb): void {
    if (OpfsChunkStore.instances.get(this.key) === this) OpfsChunkStore.instances.delete(this.key)
    callWorker({ op: 'destroy', key: this.key }).then(() => cb(null), (err: Error) => cb(err))
  }
}

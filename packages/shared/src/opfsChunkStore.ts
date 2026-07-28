// OPFS chunk store: persists verified pieces in the browser's origin-private
// file system, one file per piece under p2f-downloads/<infohash>/. Implements
// the abstract-chunk-store interface WebTorrent expects, and is used by both
// apps (the web client and the Electron desktop app) in place of WebTorrent's
// own default browser store.
//
// Using our own store rather than the built-in one is what makes *draining*
// possible: WebTorrent's default browser store has no way to release
// individual pieces, so every piece of a finished download stays on disk for
// the entire time the final file is being assembled from them — peak disk use
// of roughly twice the file size, which is what makes a large download run out
// of space on a machine that has room for the file itself. See
// startDraining() below.
//
// All actual piece reads/writes are proxied to a dedicated worker (see
// opfsWorkerCore.ts) that performs them with FileSystemSyncAccessHandle
// instead of the main-thread-only, async createWritable() stream. A sync
// access handle takes an exclusive lock on the file for its whole
// open/write-or-read/flush/close lifetime, so two writes (or a write and a
// read) can never race the same file, and a write is guaranteed durably
// flushed before close() returns. Safari's async OPFS writes have been
// observed to leave a file readable-but-truncated under concurrent access —
// this sidesteps that class of bug rather than working around one symptom.

import type { OpfsWorkerRequest, OpfsWorkerResponse } from './opfsWorkerProtocol.ts'

type StoreCb<T = void> = (err: Error | null, value?: T) => void

/**
 * Structural stand-in for the DOM `Worker` type. The worker itself is created
 * by each app (see setOpfsWorkerFactory) rather than here, because
 * `new Worker(new URL('./opfsWorker.ts', import.meta.url))` has to appear in a
 * file the app's own bundler is compiling for the worker chunk to be emitted.
 *
 * `onmessage` is typed as `unknown` only because a real `Worker`'s handler
 * signature (`(ev: MessageEvent<any>) => any`) can't be narrowed to ours
 * without tripping strictFunctionTypes — this module writes the property and
 * never reads it, and the one write below says what it actually expects.
 */
export interface OpfsWorkerHandle {
  postMessage: (message: OpfsWorkerRequest) => void
  onmessage: unknown
}

type OpfsWorkerMessageSink = { onmessage: (ev: { data: OpfsWorkerResponse }) => void }

// The handful of OPFS shapes this module touches, declared structurally rather
// than pulled from TS's DOM lib. That keeps the file compilable — and, more to
// the point, unit-testable with a stub worker — outside a browser program,
// where `FileSystemDirectoryHandle` and `navigator.storage` don't exist. The
// worker on the other side of the wire does all the real I/O; the only OPFS
// calls here are the directory-level bookkeeping below.
interface OpfsDirectory extends AsyncIterable<[string, { kind: string }]> {
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<OpfsDirectory>
  removeEntry: (name: string, opts?: { recursive?: boolean }) => Promise<void>
}

interface OpfsCapableNavigator {
  storage?: { getDirectory?: () => Promise<OpfsDirectory> }
}

function opfsRoot (): Promise<OpfsDirectory> {
  const storage = (globalThis.navigator as unknown as OpfsCapableNavigator | undefined)?.storage
  if (!storage?.getDirectory) throw new Error('OPFS is not available')
  return storage.getDirectory()
}

let workerFactory: (() => OpfsWorkerHandle) | null = null
let worker: OpfsWorkerHandle | null = null
let nextRequestId = 0
const pending = new Map<number, { resolve: (v: Uint8Array | undefined) => void, reject: (err: Error) => void }>()

/**
 * Registers how to spawn the OPFS I/O worker. Must be called once, at module
 * init, before any download starts — each app passes a factory that points at
 * its own one-line worker entry (which in turn calls installOpfsWorker).
 */
export function setOpfsWorkerFactory (factory: () => OpfsWorkerHandle): void {
  workerFactory = factory
}

function getWorker (): OpfsWorkerHandle {
  if (!worker) {
    if (!workerFactory) throw new Error('OPFS worker factory not registered')
    worker = workerFactory()
    ;(worker as unknown as OpfsWorkerMessageSink).onmessage = (ev) => {
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
    getWorker().postMessage({ ...req, id })
  })
}

/** True when this browser exposes OPFS at all — otherwise this store can't be used. */
export function opfsAvailable (): boolean {
  return typeof (globalThis.navigator as unknown as OpfsCapableNavigator | undefined)?.storage?.getDirectory === 'function'
}

/** Resets module-level worker state. Exported for tests; not used by the apps. */
export function resetOpfsWorkerForTests (): void {
  worker = null
  workerFactory = null
  pending.clear()
}

export class OpfsChunkStore {
  chunkLength: number
  length: number
  private readonly lastChunkIndex: number
  private readonly lastChunkLength: number
  private readonly key: string
  // Drain mode: once the final file is being assembled from the pieces (a
  // strictly sequential, single-pass read), each piece is deleted as soon as
  // the read moves past it — see startDraining(). Off during the download
  // itself, where pieces must persist so a refreshed tab can resume.
  private draining = false
  // Pieces with index < reapedUpTo have already been deleted while draining.
  private reapedUpTo = 0

  // Instances keyed by infoHash, so code elsewhere (each app's download
  // manager) can find the store WebTorrent created internally for a given
  // torrent — it only ever hands us the *class*, not a reference to what it
  // constructs.
  static readonly instances = new Map<string, OpfsChunkStore>()

  constructor (
    chunkLength: number,
    opts: { torrent?: { infoHash?: string }, length?: number, name?: string }
  ) {
    this.chunkLength = chunkLength
    this.length = opts.length ?? 0
    this.lastChunkIndex = Math.max(0, Math.ceil(this.length / chunkLength) - 1)
    this.lastChunkLength = this.length - this.lastChunkIndex * chunkLength
    this.key = opts.torrent?.infoHash ?? opts.name ?? 'unknown'
    OpfsChunkStore.instances.set(this.key, this)
  }

  /**
   * Puts the store for `infoHash` into drain mode, if one exists. Convenience
   * for the download managers, which only ever hold a torrent — WebTorrent
   * constructs the store itself and never hands the instance back.
   */
  static startDrainingFor (infoHash: string): void {
    OpfsChunkStore.instances.get(infoHash)?.startDraining()
  }

  static async remove (key: string): Promise<void> {
    try {
      const rootDir = await opfsRoot()
      const parent = await rootDir.getDirectoryHandle('p2f-downloads')
      await parent.removeEntry(key, { recursive: true })
    } catch { /* nothing stored */ }
  }

  /** All infoHash keys currently holding pieces on disk — used to reap orphans on startup. */
  static async listKeys (): Promise<string[]> {
    try {
      const rootDir = await opfsRoot()
      const parent = await rootDir.getDirectoryHandle('p2f-downloads')
      const keys: string[] = []
      for await (const [name, handle] of parent) {
        if (handle.kind === 'directory') keys.push(name)
      }
      return keys
    } catch {
      return []
    }
  }

  /** Deletes every stored piece set except those in `keep` — startup orphan reaping. */
  static async reapAllExcept (keep: Set<string>): Promise<void> {
    const keys = await OpfsChunkStore.listKeys()
    await Promise.all(keys.filter(k => !keep.has(k)).map(k => OpfsChunkStore.remove(k)))
  }

  private expectedLength (index: number): number {
    return index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength
  }

  put (index: number, buf: Uint8Array, cb: StoreCb): void {
    callWorker({ op: 'put', key: this.key, index, buf }).then(() => cb(null), (err: Error) => cb(err))
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
      done(null, data as Uint8Array)
      // Serve first, then free everything strictly before this piece: reaching
      // piece N in a sequential file read means N-1 and earlier are done with
      // and will never be re-read, so their disk space can be reclaimed now
      // instead of at the end. The current piece is only reaped once a later
      // one is requested, which keeps partial (offset/length) reads of the
      // same piece safe. The final piece is left to destroy() (which the
      // wholesale store teardown after a completed save handles anyway).
      if (this.draining && index > this.reapedUpTo) {
        const from = this.reapedUpTo
        this.reapedUpTo = index
        callWorker({ op: 'removeChunks', key: this.key, fromIndex: from, toIndex: index }).catch(() => {})
      }
    }, (err: Error) => done(err))
  }

  /**
   * Switch the store into drain mode for the final-file assembly. From here
   * on, each piece is deleted as the sequential save-read advances past it, so
   * peak disk use stays near 1x the file size (the shrinking piece store plus
   * the growing output) rather than the ~2x a hold-everything-until-done save
   * needs. One-way: a download whose pieces are being drained is being turned
   * into the saved file and won't be resumed from OPFS afterward.
   *
   * Every save path in both apps turns this on before it starts reading, which
   * means a save that fails partway through can't be retried from the pieces
   * still on disk — that is the deliberate trade: the alternative is needing
   * room for two full copies of the file to finish a download at all.
   */
  startDraining (): void { this.draining = true }

  close (cb: StoreCb): void { cb(null) }

  destroy (cb: StoreCb): void {
    if (OpfsChunkStore.instances.get(this.key) === this) OpfsChunkStore.instances.delete(this.key)
    callWorker({ op: 'destroy', key: this.key }).then(() => cb(null), (err: Error) => cb(err))
  }
}

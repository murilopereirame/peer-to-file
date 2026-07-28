// Dedicated-worker body for OPFS piece I/O, shared by the web client and the
// desktop app (each ships a one-line worker entry that calls
// installOpfsWorker(self) — see client/src/lib/opfsWorker.ts and
// apps/desktop/src/lib/opfsWorker.ts, which exist only so each app's bundler
// sees a `new Worker(new URL('./opfsWorker.ts', import.meta.url))` inside its
// own source tree).
//
// createSyncAccessHandle() is only reachable from inside a dedicated worker —
// that's not a limitation we're working around, it's the point: unlike the
// async createWritable() stream (main-thread only), a sync access handle takes
// an exclusive lock on the file for its whole open/write-or-read/flush/close
// lifetime and every operation on it completes before the next line of worker
// code runs. Two pieces of our own code can never race the same file the way
// concurrent async writable streams can, and a write is guaranteed durably
// flushed to disk before close() returns rather than racing however the
// browser happens to schedule it. Safari's async OPFS writes have been
// observed to leave a file readable-but-truncated under exactly that kind of
// race — routing every piece read/write through one sync handle per operation,
// in one worker, avoids the whole class of bug rather than working around a
// single symptom of it.

import type { OpfsWorkerRequest, OpfsWorkerResponse } from './opfsWorkerProtocol.ts'

// createSyncAccessHandle() lives only in TS's WebWorker lib, but this module
// is also pulled into programs compiled under the DOM lib (each app's worker
// entry is an ordinary file in its src tree). Declaring the one worker-only
// method structurally keeps this file compilable under either lib instead of
// forcing every consumer into a separate WebWorker-lib tsconfig.
interface SyncAccessHandle {
  read (buffer: Uint8Array, opts: { at: number }): number
  write (buffer: Uint8Array, opts: { at: number }): number
  truncate (size: number): void
  getSize (): number
  flush (): void
  close (): void
}

interface SyncCapableFileHandle {
  createSyncAccessHandle (): Promise<SyncAccessHandle>
}

/** The subset of DedicatedWorkerGlobalScope this module drives. */
export interface OpfsWorkerScope {
  onmessage: ((ev: { data: OpfsWorkerRequest }) => void) | null
  postMessage: (message: OpfsWorkerResponse, transfer?: ArrayBufferLike[]) => void
}

const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>()

function dirFor (key: string): Promise<FileSystemDirectoryHandle> {
  let p = dirs.get(key)
  if (!p) {
    p = (async () => {
      const root = await navigator.storage.getDirectory()
      const parent = await root.getDirectoryHandle('p2f-downloads', { create: true })
      return await parent.getDirectoryHandle(key, { create: true })
    })()
    dirs.set(key, p)
  }
  return p
}

async function syncHandle (dir: FileSystemDirectoryHandle, index: number, create: boolean): Promise<SyncAccessHandle> {
  const handle = await dir.getFileHandle(String(index), { create }) // throws if absent and !create
  return await (handle as unknown as SyncCapableFileHandle).createSyncAccessHandle()
}

async function put (key: string, index: number, buf: Uint8Array): Promise<void> {
  const dir = await dirFor(key)
  const access = await syncHandle(dir, index, true)
  try {
    access.write(buf, { at: 0 })
    access.truncate(buf.byteLength)
    access.flush()
  } finally {
    access.close()
  }
}

async function get (
  key: string, index: number, offset: number, length: number | undefined, expectedLength: number
): Promise<Uint8Array> {
  const dir = await dirFor(key)
  const access = await syncHandle(dir, index, false)
  try {
    const size = access.getSize()
    if (size !== expectedLength) throw new Error(`chunk ${index} is incomplete`)
    const end = length !== undefined ? offset + length : size
    const out = new Uint8Array(end - offset)
    access.read(out, { at: offset })
    return out
  } finally {
    access.close()
  }
}

// Deletes a half-open range of stored pieces, freeing their disk space
// immediately. Used to drain the store as the final file is assembled from it
// (see OpfsChunkStore.startDraining), rather than holding every piece until
// the whole save finishes and only then destroying the store wholesale.
// Range-shaped rather than one-at-a-time so a save that advances several
// pieces between store reads (the cache wrapper WebTorrent puts in front of
// this store can absorb some of them) still costs one message, not N.
async function removeChunks (key: string, fromIndex: number, toIndex: number): Promise<void> {
  const dir = await dirFor(key)
  for (let i = fromIndex; i < toIndex; i++) {
    try {
      await dir.removeEntry(String(i))
    } catch { /* already gone — nothing to free */ }
  }
}

async function destroy (key: string): Promise<void> {
  dirs.delete(key)
  try {
    const root = await navigator.storage.getDirectory()
    const parent = await root.getDirectoryHandle('p2f-downloads')
    await parent.removeEntry(key, { recursive: true })
  } catch { /* nothing stored */ }
}

async function handle (scope: OpfsWorkerScope, req: OpfsWorkerRequest): Promise<void> {
  try {
    if (req.op === 'put') {
      if (req.index === undefined || !req.buf) throw new Error('put: missing index/buf')
      await put(req.key, req.index, req.buf)
      scope.postMessage({ id: req.id, ok: true })
    } else if (req.op === 'get') {
      if (req.index === undefined || req.expectedLength === undefined) throw new Error('get: missing index/expectedLength')
      const data = await get(req.key, req.index, req.offset ?? 0, req.length, req.expectedLength)
      // The array form (not the newer {transfer: [...]} options-bag form) is
      // the one every browser's postMessage has supported since transferable
      // objects existed at all — no reason to depend on the newer overload.
      scope.postMessage({ id: req.id, ok: true, data }, [data.buffer])
    } else if (req.op === 'removeChunks') {
      if (req.fromIndex === undefined || req.toIndex === undefined) throw new Error('removeChunks: missing range')
      await removeChunks(req.key, req.fromIndex, req.toIndex)
      scope.postMessage({ id: req.id, ok: true })
    } else {
      await destroy(req.key)
      scope.postMessage({ id: req.id, ok: true })
    }
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Wires this module's request handler onto a dedicated worker's global scope. */
export function installOpfsWorker (scope: OpfsWorkerScope): void {
  scope.onmessage = (ev) => { void handle(scope, ev.data) }
}

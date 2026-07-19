/// <reference lib="webworker" />
// Dedicated worker for OPFS piece I/O. createSyncAccessHandle() is only
// reachable from inside a dedicated worker — that's not a limitation we're
// working around, it's the point: unlike the async createWritable() stream
// (main-thread only), a sync access handle takes an exclusive lock on the
// file for its whole open/write-or-read/flush/close lifetime and every
// operation on it completes before the next line of worker code runs. Two
// pieces of our own code can never race the same file the way concurrent
// async writable streams can, and a write is guaranteed durably flushed to
// disk before close() returns rather than racing however the browser
// happens to schedule it. Safari's async OPFS writes have been observed to
// leave a file readable-but-truncated under exactly that kind of race —
// routing every piece read/write through one sync handle per operation, in
// one worker, avoids the whole class of bug rather than working around a
// single symptom of it.

import type { OpfsWorkerRequest, OpfsWorkerResponse } from './opfsWorkerProtocol'

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

async function put (key: string, index: number, buf: Uint8Array): Promise<void> {
  const dir = await dirFor(key)
  const handle = await dir.getFileHandle(String(index), { create: true })
  const access = await handle.createSyncAccessHandle()
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
  const handle = await dir.getFileHandle(String(index)) // throws if absent
  const access = await handle.createSyncAccessHandle()
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

// Deletes a single stored piece, freeing its disk space immediately. Used to
// drain the store piece-by-piece while assembling the final file (see
// OpfsChunkStore.startDraining), rather than holding every piece until the
// whole save finishes and only then destroying the store wholesale.
async function removeChunk (key: string, index: number): Promise<void> {
  const dir = await dirFor(key)
  try {
    await dir.removeEntry(String(index))
  } catch { /* already gone — nothing to free */ }
}

async function destroy (key: string): Promise<void> {
  dirs.delete(key)
  try {
    const root = await navigator.storage.getDirectory()
    const parent = await root.getDirectoryHandle('p2f-downloads')
    await parent.removeEntry(key, { recursive: true })
  } catch { /* nothing stored */ }
}

async function handle (req: OpfsWorkerRequest): Promise<void> {
  try {
    if (req.op === 'put') {
      if (req.index === undefined || !req.buf) throw new Error('put: missing index/buf')
      await put(req.key, req.index, req.buf)
      postMessage({ id: req.id, ok: true } satisfies OpfsWorkerResponse)
    } else if (req.op === 'get') {
      if (req.index === undefined || req.expectedLength === undefined) throw new Error('get: missing index/expectedLength')
      const data = await get(req.key, req.index, req.offset ?? 0, req.length, req.expectedLength)
      // The array form (not the newer {transfer: [...]} options-bag form) is
      // the one every browser's postMessage has supported since transferable
      // objects existed at all — no reason to depend on the newer overload.
      postMessage({ id: req.id, ok: true, data } satisfies OpfsWorkerResponse, [data.buffer])
    } else if (req.op === 'removeChunk') {
      if (req.index === undefined) throw new Error('removeChunk: missing index')
      await removeChunk(req.key, req.index)
      postMessage({ id: req.id, ok: true } satisfies OpfsWorkerResponse)
    } else {
      await destroy(req.key)
      postMessage({ id: req.id, ok: true } satisfies OpfsWorkerResponse)
    }
  } catch (err) {
    postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies OpfsWorkerResponse)
  }
}

onmessage = (ev: MessageEvent<OpfsWorkerRequest>) => { void handle(ev.data) }

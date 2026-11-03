// Drain bookkeeping for the shared OPFS chunk store — the logic that decides
// which stored pieces are freed, and when, while a finished download is being
// written out as the final file. That decision is what keeps peak disk use
// near 1x the file size instead of 2x (the piece store *plus* the output), so
// it's worth pinning down away from a real browser: the store talks to its
// OPFS worker exclusively through an injected factory (see
// setOpfsWorkerFactory), which makes a stub worker enough to observe every
// piece deletion it asks for.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// Imported by module path rather than through the package barrel on purpose:
// the barrel also pulls in the browser-only parts of @p2f/shared (Notification,
// BufferSource, ...) that don't typecheck under this Node-targeted program,
// whereas the store itself is deliberately free of them.
import {
  OpfsChunkStore, resetOpfsWorkerForTests, setOpfsWorkerFactory
} from '@p2f/shared/src/opfsChunkStore.ts'
import { transferReadProgress } from '@p2f/shared/src/readProgress.ts'
import type { OpfsWorkerRequest, OpfsWorkerResponse } from '@p2f/shared/src/opfsWorkerProtocol.ts'

const CHUNK = 1024
const PIECES = 8
const LENGTH = CHUNK * PIECES

/** Records every request and answers `get` with plausible piece bytes. */
class StubWorker {
  readonly requests: OpfsWorkerRequest[] = []
  onmessage: ((ev: { data: OpfsWorkerResponse }) => void) | null = null
  /** Piece indices deleted so far, in the order the store asked for them. */
  readonly removed: number[] = []

  postMessage (req: OpfsWorkerRequest): void {
    this.requests.push(req)
    if (req.op === 'removeChunks') {
      for (let i = req.fromIndex!; i < req.toIndex!; i++) this.removed.push(i)
    }
    const data = req.op === 'get' ? new Uint8Array(req.expectedLength ?? 0) : undefined
    // Async, like a real worker round trip.
    queueMicrotask(() => { this.onmessage?.({ data: { id: req.id, ok: true, data } }) })
  }
}

let stub: StubWorker

function newStore (key = 'abc123'): OpfsChunkStore {
  return new OpfsChunkStore(CHUNK, { torrent: { infoHash: key }, length: LENGTH })
}

async function getPiece (store: OpfsChunkStore, index: number, opts: { offset?: number, length?: number } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    store.get(index, opts, err => { err ? reject(err) : resolve() })
  })
}

/** Let the stub's microtask-based round trips settle before asserting. */
async function settle (): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

/** Reads pieces from..to-1 in order and reports each one as consumed, the way
 * the save's file iterator does (see ensureFileDecryptionPatched). */
async function readSequentially (store: OpfsChunkStore, to: number, from = 0, key = 'abc123'): Promise<void> {
  for (let i = from; i < to; i++) {
    await getPiece(store, i)
    transferReadProgress.get(key)?.(i * CHUNK, Math.min((i + 1) * CHUNK, store.length))
  }
  await settle()
}

beforeEach(() => {
  resetOpfsWorkerForTests()
  OpfsChunkStore.instances.clear()
  transferReadProgress.clear()
  stub = new StubWorker()
  setOpfsWorkerFactory(() => stub)
})

test('nothing is deleted while the download is still running', async () => {
  const store = newStore()
  await readSequentially(store, PIECES)
  assert.deepEqual(stub.removed, [], 'pieces must survive reads until a save starts draining')
})

test('draining frees every piece the sequential read has passed', async () => {
  const store = newStore()
  store.startDraining()
  await readSequentially(store, 4)
  assert.deepEqual(stub.removed, [0, 1, 2, 3])
  await readSequentially(store, PIECES, 4)
  assert.deepEqual(stub.removed, [0, 1, 2, 3, 4, 5, 6, 7])
})

test('a piece is only freed once the save has consumed all of it', async () => {
  const store = newStore()
  store.startDraining()
  await getPiece(store, 0)
  // The iterator hands piece 0 on in two halves.
  transferReadProgress.get('abc123')?.(0, CHUNK / 2)
  await settle()
  assert.deepEqual(stub.removed, [], 'half a piece consumed frees nothing')
  transferReadProgress.get('abc123')?.(CHUNK / 2, CHUNK)
  await settle()
  assert.deepEqual(stub.removed, [0])
})

test('serving pieces to other peers never frees pieces the save has not read', async () => {
  // Regression: WebTorrent calls get() to answer peers' requests too. A peer
  // asking for a far-ahead piece used to look like "the save has read this
  // far" and delete everything before it, so the save hit missing pieces and
  // ended early — a "completed" but truncated file.
  const store = newStore()
  store.startDraining()
  await readSequentially(store, 2)
  await getPiece(store, 7)
  await getPiece(store, 5, { offset: 16, length: 32 })
  await settle()
  assert.deepEqual(stub.removed, [0, 1])
})

test('reads that do not continue the save from where it is are ignored', async () => {
  const store = newStore()
  store.startDraining()
  await readSequentially(store, 2)
  // A ranged read further on (not the save's own sequential pass)...
  transferReadProgress.get('abc123')?.(5 * CHUNK, 6 * CHUNK)
  // ...and a re-read of something already freed.
  transferReadProgress.get('abc123')?.(0, CHUNK)
  await settle()
  assert.deepEqual(stub.removed, [0, 1])
})

test('a piece is freed only once, however many times the read revisits it', async () => {
  const store = newStore()
  store.startDraining()
  await readSequentially(store, 4)
  await readSequentially(store, 4, 2)
  assert.deepEqual(stub.removed, [0, 1, 2, 3])
})

test('draining mid-save frees the pieces already behind the read, not just later ones', async () => {
  const store = newStore()
  // Half the file is read before the save switches the store into drain mode
  // (the service-worker tier turns draining on as the stream is starting).
  await readSequentially(store, 4)
  assert.deepEqual(stub.removed, [])
  store.startDraining()
  await settle()
  assert.deepEqual(stub.removed, [0, 1, 2, 3])
  await readSequentially(store, PIECES, 4)
  assert.deepEqual(stub.removed, [0, 1, 2, 3, 4, 5, 6, 7])
})

test('startDrainingFor targets the store registered for an infoHash', async () => {
  const mine = newStore('mine')
  const theirs = newStore('theirs')
  OpfsChunkStore.startDrainingFor('mine')

  await readSequentially(mine, 3, 0, 'mine')
  assert.deepEqual(stub.removed, [0, 1, 2], 'the drained store frees what the read passed')

  stub.removed.length = 0
  await readSequentially(theirs, 3, 0, 'theirs')
  assert.deepEqual(stub.removed, [], 'an unrelated download keeps its pieces')
})

test('startDrainingFor is a no-op for an unknown infoHash', () => {
  assert.doesNotThrow(() => { OpfsChunkStore.startDrainingFor('never-added') })
})

test('the last piece is short, and reads of it still report the right length', async () => {
  // 8 whole pieces exactly: the last piece is a full chunk here. Use an
  // odd-sized torrent to check the short-tail arithmetic the worker relies on
  // to detect a truncated piece file.
  const odd = new OpfsChunkStore(CHUNK, { torrent: { infoHash: 'odd' }, length: CHUNK * 2 + 100 })
  await new Promise<void>((resolve, reject) => {
    odd.get(2, {}, err => { err ? reject(err) : resolve() })
  })
  const lastGet = stub.requests.filter(r => r.op === 'get').at(-1)
  assert.equal(lastGet?.expectedLength, 100)
})

test('destroy drops the instance from the registry so a re-add starts clean', async () => {
  const store = newStore('gone')
  assert.equal(OpfsChunkStore.instances.get('gone'), store)
  await new Promise<void>((resolve, reject) => {
    store.destroy(err => { err ? reject(err) : resolve() })
  })
  assert.equal(OpfsChunkStore.instances.has('gone'), false)
  assert.equal(transferReadProgress.has('gone'), false)
  assert.equal(stub.requests.at(-1)?.op, 'destroy')
})

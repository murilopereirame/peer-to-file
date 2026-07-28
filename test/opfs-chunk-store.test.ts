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

/** Reads pieces 0..count-1 in order, the way a save's sequential pass does. */
async function readSequentially (store: OpfsChunkStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve, reject) => {
      store.get(i, {}, err => { err ? reject(err) : resolve() })
    })
  }
  // Reaps are fired after the read is served, without being awaited — let the
  // stub's microtask-based round trips settle before asserting.
  await new Promise(resolve => setImmediate(resolve))
}

beforeEach(() => {
  resetOpfsWorkerForTests()
  OpfsChunkStore.instances.clear()
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
  await readSequentially(store, PIECES)
  // The piece currently being served is kept (a partial re-read of it is still
  // legal); everything strictly behind the read is gone.
  assert.deepEqual(stub.removed, [0, 1, 2, 3, 4, 5, 6])
})

test('a piece is freed only once, however many times the read revisits it', async () => {
  const store = newStore()
  store.startDraining()
  await readSequentially(store, 4)
  // A partial re-read of an already-served piece must not re-reap behind it.
  await new Promise<void>((resolve, reject) => {
    store.get(3, { offset: 16, length: 32 }, err => { err ? reject(err) : resolve() })
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(stub.removed, [0, 1, 2])
})

test('draining mid-save frees the pieces already behind the read, not just later ones', async () => {
  const store = newStore()
  // Half the file is read before the save switches the store into drain mode
  // (the service-worker tier turns draining on as the stream is starting).
  await readSequentially(store, 4)
  assert.deepEqual(stub.removed, [])
  store.startDraining()
  await readSequentially(store, PIECES)
  assert.deepEqual(stub.removed, [0, 1, 2, 3, 4, 5, 6])
})

test('startDrainingFor targets the store registered for an infoHash', async () => {
  const mine = newStore('mine')
  const theirs = newStore('theirs')
  OpfsChunkStore.startDrainingFor('mine')

  await readSequentially(mine, 3)
  assert.deepEqual(stub.removed, [0, 1], 'the drained store frees what the read passed')

  stub.removed.length = 0
  await readSequentially(theirs, 3)
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
  assert.equal(stub.requests.at(-1)?.op, 'destroy')
})

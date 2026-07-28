// Message shapes shared between opfsChunkStore.ts (the app's main thread) and
// opfsWorkerCore.ts (the worker thread). Deliberately its own file with no
// DOM/WebWorker-specific types: the store side is compiled under the DOM lib
// and the worker side may be compiled under the WebWorker lib (see
// tsconfig.client.json vs tsconfig.worker.json — those two libs conflict if
// loaded together in one program), so anything imported by both must stay
// lib-neutral.

export interface OpfsWorkerRequest {
  id: number
  op: 'put' | 'get' | 'destroy' | 'removeChunks'
  key: string
  index?: number
  buf?: Uint8Array
  offset?: number
  length?: number
  expectedLength?: number
  /** removeChunks: first piece index to delete (inclusive). */
  fromIndex?: number
  /** removeChunks: one past the last piece index to delete (exclusive). */
  toIndex?: number
}

export interface OpfsWorkerResponse {
  id: number
  ok: boolean
  error?: string
  data?: Uint8Array
}

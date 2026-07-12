// Message shapes shared between opfsChunkStore.ts (main thread) and
// opfsWorker.ts (worker thread). Deliberately its own file with no
// DOM/WebWorker-specific types: opfsChunkStore.ts is compiled under the
// DOM lib and opfsWorker.ts under the WebWorker lib (see tsconfig.client
// vs tsconfig.worker.json — those two libs conflict if loaded together in
// one program), so anything imported by both must stay lib-neutral.

export interface OpfsWorkerRequest {
  id: number
  op: 'put' | 'get' | 'destroy'
  key: string
  index?: number
  buf?: Uint8Array
  offset?: number
  length?: number
  expectedLength?: number
}

export interface OpfsWorkerResponse {
  id: number
  ok: boolean
  error?: string
  data?: Uint8Array
}

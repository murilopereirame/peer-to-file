// The download side of the protocol, from p2f-lib — the client library this
// repo started and that the PS4 app (P2PS) uses too. Its core is C compiled
// to WebAssembly, so the web app, the desktop app and the PS4 app run the
// same code for:
//
//   - waiting while the server prepares a file. The server reads and hashes
//     a whole file before it can describe it; for a big file that takes
//     minutes the first time. The request asks with async=1, the server
//     answers 202 with its progress, and the client polls. Dropped
//     connections, 5xx and proxy error pages are retried with a backoff; the
//     server's own errors (404, 403, 401) are final.
//   - the ECDH key exchange that unwraps a download's transfer key.
//
// The bulk AES-CTR decryption of the torrent pieces stays on WebCrypto
// (browserCrypto.ts): the browser's native AES is much faster than any
// WebAssembly AES, and it produces the same bytes.

import { generateClientKeyPair, initP2F, P2FError, waitForTorrentMeta } from 'p2f-lib'
import type { PrepareProgress } from 'p2f-lib'
import { ApiError } from './types.ts'
import type { TorrentMeta } from './types.ts'

export type { PrepareProgress }

/** One download's key exchange (a fresh ECDH keypair, run in the p2f-lib core). */
export interface DownloadKeys {
  /** Send as `ck` on the metadata request. */
  clientPublicKeyBase64: string
  /** Unwrap the metadata's `encKeyWrapped` into the file's AES-256-CTR key and IV. */
  unwrap: (encKeyWrapped: string) => { key: Uint8Array, iv: Uint8Array }
  /** Free the keypair (also freed automatically once unreachable). */
  dispose: () => void
}

export async function createDownloadKeys (serverPublicKeyBase64: string): Promise<DownloadKeys> {
  await initP2F()
  const kp = generateClientKeyPair()
  return {
    clientPublicKeyBase64: kp.publicKeyBase64,
    unwrap: (encKeyWrapped) => {
      try {
        return kp.unwrap(serverPublicKeyBase64, encKeyWrapped)
      } catch (err) {
        throw new ApiError(0, err instanceof Error ? err.message : 'transfer key unwrap failed')
      }
    },
    dispose: () => { kp.dispose() }
  }
}

export interface TorrentMetaRequest {
  path: string
  /** DownloadKeys.clientPublicKeyBase64 */
  ck: string
  mount?: number | string
}

export interface PrepareOptions {
  signal?: AbortSignal
  /** Called while the server prepares the file, and before each retry. */
  onPreparing?: (progress: PrepareProgress) => void
}

/** The /api/torrent path + query for a request (always with async=1). */
export function torrentMetaPath (req: TorrentMetaRequest): string {
  const params = new URLSearchParams({ path: req.path, ck: req.ck, async: '1' })
  if (req.mount !== undefined) params.set('mount', String(req.mount))
  return `/api/torrent?${params.toString()}`
}

/**
 * Ask for a file's torrent metadata until the server has prepared it.
 * `send` makes one GET of `pathAndQuery` and returns the Response — an HTTP
 * error must come back as a Response, not a throw (see responseFromError).
 * Errors surface as ApiError, like the rest of the shared client.
 */
export async function fetchTorrentMeta (
  send: (pathAndQuery: string, signal: AbortSignal) => Promise<Response>,
  req: TorrentMetaRequest,
  opts: PrepareOptions = {}
): Promise<TorrentMeta> {
  const pathAndQuery = torrentMetaPath(req)
  try {
    return await waitForTorrentMeta(async (signal) => await send(pathAndQuery, signal), opts) as unknown as TorrentMeta
  } catch (err) {
    if (err instanceof P2FError) throw new ApiError(err.status, err.message)
    throw err
  }
}

/**
 * For a fetch wrapper that throws on an HTTP error (status + message): turn
 * the error back into a Response so fetchTorrentMeta can tell a final answer
 * from a transient one. Anything without a numeric `status` is rethrown (a
 * network error, which fetchTorrentMeta retries).
 */
export function responseFromError (err: unknown): Response {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    const message = err instanceof Error ? err.message : ''
    // A wrapper falls back to "HTTP <status>" when the body had no JSON
    // error, i.e. it didn't come from the server (a proxy page): keep it
    // non-JSON so it stays retryable.
    if (!message || message === `HTTP ${status}`) return new Response(message, { status })
    return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } })
  }
  throw err
}

/** Raw key bytes -> base64 (for the cached server public key). */
export function rawKeyToBase64 (bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

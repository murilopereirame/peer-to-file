// AES-256-CTR transfer encryption for browser-engine WebTorrent clients (the
// web app and the Tauri desktop app both load the same prebuilt WebTorrent
// browser bundle — see loadWebTorrent.ts in each). Keeps the wire from ever
// carrying plaintext, independent of whatever TLS/VPN the deployment does or
// doesn't have — see src/server/cipherCache.ts for the server-side half.
//
// CTR encrypt and decrypt are the *same* XOR-with-keystream operation, so one
// function serves both directions: the download side decrypts what the
// server encrypted, the upload side encrypts what the server will decrypt.

/** Imports a raw AES-256 key for use with ctrXor. */
export async function importCtrKey (rawKeyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawKeyBase64)
  return crypto.subtle.importKey('raw', raw.buffer, { name: 'AES-CTR' }, false, ['encrypt', 'decrypt'])
}

export function base64ToBytes (b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>
}

/**
 * XORs `chunk` (ciphertext or plaintext — CTR is symmetric) against the AES
 * keystream for the block(s) covering `absoluteOffset..absoluteOffset+chunk.length`
 * of the file, given the file's key and base IV (the 16-byte initial counter
 * block, incrementing exactly like Node's `crypto.createCipheriv('aes-256-ctr', ...)`
 * — the whole 128 bits count, no fixed nonce prefix).
 *
 * `chunk` need not be block-aligned: a chunk starting mid-block is handled by
 * padding the front with zero bytes up to the block boundary, transforming
 * the padded buffer (the padding bytes just absorb keystream bytes that are
 * then discarded), and slicing the padding back off — the standard technique
 * for random-access CTR decryption at an arbitrary byte offset.
 */
export async function ctrXor (
  chunk: Uint8Array, absoluteOffset: number, key: CryptoKey, baseIv: Uint8Array
): Promise<Uint8Array> {
  const blockOffset = absoluteOffset % 16
  const blockIndex = Math.floor(absoluteOffset / 16)
  const counter = addToCounter(baseIv, blockIndex)

  const padded = new Uint8Array(blockOffset + chunk.length)
  padded.set(chunk, blockOffset)

  const out = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: counter.buffer, length: 128 },
    key,
    padded
  )
  return new Uint8Array(out).subarray(blockOffset)
}

/** Adds `blocks` to the 128-bit big-endian counter represented by `iv`. */
function addToCounter (iv: Uint8Array, blocks: number): Uint8Array<ArrayBuffer> {
  const counter = new Uint8Array(new ArrayBuffer(16))
  counter.set(iv)
  let carry = blocks
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const sum = counter[i]! + (carry % 256)
    counter[i] = sum % 256
    carry = Math.floor(carry / 256) + Math.floor(sum / 256)
  }
  return counter
}

export interface EncryptedUpload {
  body: Blob
  headers: Record<string, string>
}

/**
 * Encrypts a file client-side before it goes over the wire to /api/upload.
 * Unlike downloads (a server-generated, cross-session-stable key), uploads
 * are one-shot — the client just generates a fresh random key/IV, encrypts,
 * and hands the server what it needs to decrypt via headers (see the
 * doc comment on the /api/upload handler in src/server/app.ts). Reads the
 * file twice (once streamed through ctrXor for the ciphertext body, once via
 * `arrayBuffer()` for the plaintext SHA-256 the server verifies after
 * decrypting) rather than hand-rolling an incremental SHA-256 — this project
 * already accepts O(file size) memory for the equivalent download-side
 * fallback, so the same trade-off here isn't a new category of limitation.
 */
export async function encryptFileForUpload (file: Blob): Promise<EncryptedUpload> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CTR' }, false, ['encrypt'])

  const parts: Uint8Array[] = []
  let offset = 0
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const cipher = await ctrXor(value, offset, key, iv)
    parts.push(cipher)
    offset += value.length
  }

  const plainDigest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const plainSha256 = Array.from(new Uint8Array(plainDigest))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  return {
    body: new Blob(parts as BlobPart[]),
    headers: {
      'X-P2F-Enc-Key': bytesToBase64(rawKey),
      'X-P2F-Enc-Iv': bytesToBase64(iv),
      'X-P2F-Plain-Sha256': plainSha256
    }
  }
}

function bytesToBase64 (bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export interface EncKeyEntry {
  key: CryptoKey
  iv: Uint8Array
}

/**
 * infoHash -> key/IV registry, populated when a download starts (from the
 * `encKey`/`encIv` fields on the /api/torrent response) and consulted by the
 * patched File async iterator below. Shared module-level state: the registry
 * and the monkey-patch both need to be the same instance across every caller
 * in a page (downloadManager.ts et al.), so this file, not its caller, owns it.
 */
export const transferKeys = new Map<string, EncKeyEntry>()

// WebTorrent's browser `File` class isn't exposed as a static export on the
// `WebTorrent` client constructor — the only way to reach its prototype is
// through an actual File instance (`torrent.files[0]`), so patching happens
// lazily on first use rather than once at bundle-load time. Idempotent: the
// prototype is shared by every torrent/file for the lifetime of the page, so
// this only needs to run once.
let patched = false

/**
 * Monkey-patches the WebTorrent File prototype's async iterator — the single
 * choke point `createReadStream()`, `.stream()`, `.arrayBuffer()`, `.blob()`
 * and the service-worker-streamed save path all delegate to internally (see
 * webtorrent's lib/file.js and lib/server.js) — so every save path decrypts
 * transparently with zero changes to downloadManager.ts's three save tiers,
 * the OPFS chunk store, or the service worker.
 */
export function ensureFileDecryptionPatched (file: { constructor: unknown }): void {
  if (patched) return
  patched = true

  interface PatchableFile {
    _torrent?: { infoHash?: string }
    [Symbol.asyncIterator] (opts?: { start?: number, end?: number }): AsyncIterableIterator<Uint8Array>
  }
  const proto = (file.constructor as { prototype: PatchableFile }).prototype
  const original = proto[Symbol.asyncIterator]

  proto[Symbol.asyncIterator] = function (this: PatchableFile, opts?: { start?: number, end?: number }) {
    const infoHash = this._torrent?.infoHash
    const entry = infoHash ? transferKeys.get(infoHash) : undefined
    const iterator = original.call(this, opts)
    if (!entry) return iterator

    let offset = opts?.start ?? 0
    const { key, iv } = entry
    return {
      async next (): Promise<IteratorResult<Uint8Array>> {
        const result = await iterator.next()
        if (result.done) return result
        const plain = await ctrXor(result.value, offset, key, iv)
        offset += result.value.length
        return { done: false, value: plain }
      },
      async return (value?: unknown): Promise<IteratorResult<Uint8Array>> {
        if (iterator.return) return iterator.return(value) as Promise<IteratorResult<Uint8Array>>
        return { done: true, value: undefined as unknown as Uint8Array }
      },
      [Symbol.asyncIterator] () { return this }
    }
  }
}

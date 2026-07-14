// AES-256-CTR transfer encryption for browser-engine WebTorrent clients (the
// web app and the Electron desktop app both load the same prebuilt WebTorrent
// browser bundle — see loadWebTorrent.ts in each). Keeps the wire from ever
// carrying plaintext, independent of whatever TLS/VPN the deployment does or
// doesn't have — see src/server/cipherCache.ts for the server-side half.
//
// The AES-256-CTR key/IV that actually encrypts a transfer never crosses the
// wire in the clear: each request establishes an ECDH (P-256) shared secret
// with the server's stable public key, using a fresh ephemeral keypair, and
// the key material is AES-256-GCM-wrapped under a key derived from that
// secret (see keyExchange.ts server-side). A passive observer of the wire
// sees ciphertext and a wrapped-key blob, but recovering the key requires
// solving ECDH, not just capturing traffic.
//
// CTR encrypt and decrypt are the *same* XOR-with-keystream operation, so one
// function (ctrXor) serves both directions: the download side decrypts what
// the server encrypted, the upload side encrypts what the server will decrypt.

export function base64ToBytes (b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>
}

function bytesToBase64 (bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

// --- ECDH key wrapping -------------------------------------------------------

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' } as const
const WRAP_INFO = new TextEncoder().encode('p2f-key-wrap')
const GCM_NONCE_LEN = 12
const GCM_TAG_LEN = 16

export interface KeyWrap {
  wrapKey: CryptoKey
  /** This session's ephemeral ECDH public key (base64) — send as `ck`/`X-P2F-Enc-Client-Pubkey`. */
  clientPublicKeyBase64: string
}

/**
 * Fetches (once) and caches the server's stable ECDH public key. `fetchInfo`
 * is injected so this module stays transport-agnostic (plain fetch on web,
 * a main-process-proxied fetch on desktop — see apps/desktop/electron/
 * netFetch.cts) — same pattern as P2FClient. A
 * failed fetch (a transient network blip, a 401 before the session is
 * ready, ...) is not cached — same don't-cache-failures rule the server's
 * own TorrentStore/CipherCache follow — so the next call retries instead of
 * every future download/upload on the page failing forever against one
 * bad attempt.
 */
let serverPublicKeyPromise: Promise<Uint8Array> | null = null
export function getServerEcdhPublicKey (fetchInfo: () => Promise<{ ecdhPublicKey: string }>): Promise<Uint8Array> {
  if (!serverPublicKeyPromise) {
    const fresh = fetchInfo().then(info => base64ToBytes(info.ecdhPublicKey))
    fresh.catch(() => { if (serverPublicKeyPromise === fresh) serverPublicKeyPromise = null })
    serverPublicKeyPromise = fresh
  }
  return serverPublicKeyPromise
}

/**
 * Generates a fresh ephemeral ECDH keypair and derives the AES-256-GCM
 * wrapping key shared with the server (same derivation as keyExchange.ts:
 * ECDH shared secret -> HKDF-SHA256, info "p2f-key-wrap" -> 32-byte key).
 * A new keypair per call, not reused across requests, so each transfer's
 * key-wrap is independent.
 */
export async function establishKeyWrap (serverPublicKeyRaw: Uint8Array): Promise<KeyWrap> {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveBits'])
  const serverPublicKey = await crypto.subtle.importKey('raw', serverPublicKeyRaw as BufferSource, ECDH_PARAMS, false, [])
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPublicKey }, keyPair.privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: WRAP_INFO },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
  const clientPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  return { wrapKey, clientPublicKeyBase64: bytesToBase64(clientPublicKeyRaw) }
}

/** AES-256-GCM-wraps `plaintext` (the transfer key+IV) — wire format: nonce(12) || ciphertext || tag(16). */
export async function wrapKeyMaterial (wrapKey: CryptoKey, plaintext: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_LEN))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, wrapKey, plaintext as BufferSource)
  const out = new Uint8Array(nonce.length + ciphertext.byteLength)
  out.set(nonce, 0)
  out.set(new Uint8Array(ciphertext), nonce.length)
  return bytesToBase64(out)
}

/** Reverses wrapKeyMaterial(). Throws if the GCM tag doesn't verify. */
export async function unwrapKeyMaterial (wrapKey: CryptoKey, wrappedBase64: string): Promise<Uint8Array> {
  const blob = base64ToBytes(wrappedBase64)
  if (blob.length < GCM_NONCE_LEN + GCM_TAG_LEN) throw new Error('invalid wrapped key')
  const nonce = blob.subarray(0, GCM_NONCE_LEN)
  const ciphertextAndTag = blob.subarray(GCM_NONCE_LEN)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, wrapKey, ciphertextAndTag)
  return new Uint8Array(plain)
}

// --- AES-256-CTR bulk transfer encryption -----------------------------------

/** Imports raw AES-256 key bytes for use with ctrXor. */
export async function importCtrKey (rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-CTR' }, false, ['encrypt', 'decrypt'])
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

  // length: 64 only tells WebCrypto how many low-order counter bits it's
  // allowed to increment *within this one call*; the actual 128-bit value
  // passed in `counter` is still computed to match Node's full-width
  // increment via addToCounter above. Chunks never span anywhere near 2^64
  // blocks, so this is equivalent to length: 128 for any real file — chosen
  // over 128 because it's the far more common/battle-tested WebCrypto
  // AES-CTR parameterization across browser engines.
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: counter.buffer, length: 64 },
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
 * and hands the server what it needs to decrypt: the key/IV themselves
 * ECDH-wrapped under `keyWrap` (see the doc comment on the /api/upload
 * handler in src/server/app.ts), plus a plaintext SHA-256 the server
 * verifies after decrypting. Reads the file twice (once streamed through
 * ctrXor for the ciphertext body, once via `arrayBuffer()` for the SHA-256)
 * rather than hand-rolling an incremental SHA-256 — this project already
 * accepts O(file size) memory for the equivalent download-side fallback, so
 * the same trade-off here isn't a new category of limitation.
 */
export async function encryptFileForUpload (file: Blob, keyWrap: KeyWrap): Promise<EncryptedUpload> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', rawKey.buffer, { name: 'AES-CTR' }, false, ['encrypt'])

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

  const keyMaterial = new Uint8Array(48)
  keyMaterial.set(rawKey, 0)
  keyMaterial.set(iv, 32)

  return {
    body: new Blob(parts as BlobPart[]),
    headers: {
      'X-P2F-Enc-Client-Pubkey': keyWrap.clientPublicKeyBase64,
      'X-P2F-Enc-Key-Wrapped': await wrapKeyMaterial(keyWrap.wrapKey, keyMaterial),
      'X-P2F-Plain-Sha256': plainSha256
    }
  }
}

export interface EncKeyEntry {
  key: CryptoKey
  iv: Uint8Array
}

/**
 * infoHash -> key/IV registry, populated when a download starts (from the
 * unwrapped `encKeyWrapped` field on the /api/torrent response) and
 * consulted by the patched File async iterator below. Shared module-level
 * state: the registry and the monkey-patch both need to be the same
 * instance across every caller in a page (downloadManager.ts et al.), so
 * this file, not its caller, owns it.
 */
export const transferKeys = new Map<string, EncKeyEntry>()

/**
 * infoHash -> callback, fired when a patched file iterator (below) fully
 * drains — every chunk read from the underlying store *and* decrypted *and*
 * yielded to whatever is consuming the file. A caller with no other
 * completion signal for a consumer (e.g. downloadManager.ts's
 * service-worker-streamed save, triggered by an anchor click with no
 * JS-visible "finished" event of its own) can use this instead of guessing
 * at when the underlying chunk store finishes serving reads: the AES-CTR
 * decrypt this patch inserts is itself async (a crypto.subtle call per
 * chunk), so "every piece has been read from the store" can be reached
 * measurably *before* "every decrypted byte has actually been handed to the
 * consumer" — the gap that made a store-read-based completion signal
 * unreliable once decryption sat in the middle of that pipe.
 */
export const transferDrainCallbacks = new Map<string, () => void>()

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

    const hash = infoHash as string
    let offset = opts?.start ?? 0
    const { key, iv } = entry
    return {
      async next (): Promise<IteratorResult<Uint8Array>> {
        const result = await iterator.next()
        if (result.done) {
          transferDrainCallbacks.get(hash)?.()
          return result
        }
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

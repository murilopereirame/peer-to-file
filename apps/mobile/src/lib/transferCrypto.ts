import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'react-native-quick-crypto'
import { Buffer } from '@craftzdog/react-native-buffer'
import { fromByteArray, toByteArray } from 'react-native-quick-base64'
import type { File } from 'expo-file-system'

// AES-256-CTR transfer encryption for the mobile app. Unlike the web/desktop
// clients (which patch WebTorrent's File stream to decrypt/encrypt on the
// fly), mobile has no WebTorrent, no chunk store, and no streaming hook at
// all — downloads/uploads are single native expo-file-system tasks with no
// JS-visible byte stream. So encryption here is necessarily whole-file:
// read the complete file into memory, transform it, write it back out. This
// is the same worst-case memory trade-off already documented/accepted for
// the Android SAF-relocation step in transfers.ts, not a new limitation.
//
// The AES-256-CTR key/IV that actually encrypts a transfer never crosses the
// wire in the clear: each request establishes an ECDH (P-256) shared secret
// with the server's stable public key, using a fresh ephemeral keypair, and
// the key material is AES-256-GCM-wrapped under a key derived from that
// secret — mirrors src/server/keyExchange.ts and
// packages/shared/src/browserCrypto.ts's establishKeyWrap, using
// react-native-quick-crypto's Node-crypto-compatible API instead of Web
// Crypto (react-native-quick-crypto's ECDH uses the same OpenSSL
// uncompressed-point format and 'prime256v1'/P-256 curve, so public keys and
// shared secrets are byte-identical with the server and the other clients).

const CURVE = 'prime256v1'
const HKDF_INFO = 'p2f-key-wrap'
const NONCE_LEN = 12
const TAG_LEN = 16

export function base64ToBytes (b64: string): Uint8Array {
  return toByteArray(b64)
}

function concatBytes (a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export interface KeyWrap {
  wrapKey: Uint8Array
  clientPublicKeyBase64: string
}

/** Fetches (once) and caches the server's stable ECDH public key — same pattern as browserCrypto.ts. */
let serverPublicKeyPromise: Promise<string> | null = null
export function getServerEcdhPublicKey (fetchInfo: () => Promise<{ ecdhPublicKey: string }>): Promise<string> {
  serverPublicKeyPromise ??= fetchInfo().then(info => info.ecdhPublicKey)
  return serverPublicKeyPromise
}

/** Generates a fresh ephemeral ECDH keypair and derives the AES-256-GCM wrapping key shared with the server. */
export function establishKeyWrap (serverPublicKeyBase64: string): KeyWrap {
  const ecdh = createECDH(CURVE)
  const clientPublicKey = ecdh.generateKeys()
  const shared = ecdh.computeSecret(Buffer.from(base64ToBytes(serverPublicKeyBase64)))
  const wrapKey = new Uint8Array(hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32))
  return { wrapKey, clientPublicKeyBase64: fromByteArray(new Uint8Array(clientPublicKey)) }
}

/** AES-256-GCM-wraps `plaintext` (the transfer key+IV) — wire format: nonce(12) || ciphertext || tag(16). */
export function wrapKeyMaterial (wrapKey: Uint8Array, plaintext: Uint8Array): string {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', wrapKey, nonce)
  const ciphertext = concatBytes(new Uint8Array(cipher.update(plaintext)), new Uint8Array(cipher.final()))
  const tag = new Uint8Array(cipher.getAuthTag())
  return fromByteArray(concatBytes(concatBytes(new Uint8Array(nonce), ciphertext), tag))
}

/** Reverses wrapKeyMaterial(). Throws if the GCM tag doesn't verify. */
export function unwrapKeyMaterial (wrapKey: Uint8Array, wrappedBase64: string): Uint8Array {
  const blob = base64ToBytes(wrappedBase64)
  const nonce = blob.subarray(0, NONCE_LEN)
  const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', wrapKey, nonce)
  decipher.setAuthTag(Buffer.from(tag))
  return concatBytes(new Uint8Array(decipher.update(ciphertext)), new Uint8Array(decipher.final()))
}

/** Decrypts a completed download's ciphertext in place, overwriting the file with plaintext. */
export async function decryptFileInPlace (file: File, key: Uint8Array, iv: Uint8Array): Promise<void> {
  const ciphertext = await file.bytes()
  const decipher = createDecipheriv('aes-256-ctr', key, iv)
  const plaintext = concatBytes(new Uint8Array(decipher.update(ciphertext)), new Uint8Array(decipher.final()))
  file.write(plaintext)
}

export interface EncryptedUpload {
  ciphertext: Uint8Array
  headers: Record<string, string>
}

/**
 * Encrypts a file's full contents for upload. Mirrors
 * packages/shared/src/browserCrypto.ts's encryptFileForUpload (client
 * generates a fresh one-shot key/IV, then ECDH-wraps it via `keyWrap`; the
 * server decrypts and verifies the plaintext SHA-256 — see the doc comment
 * on the /api/upload handler in src/server/app.ts) but reads/writes whole
 * buffers since there's no streaming file API available here.
 */
export async function encryptFileForUpload (file: File, keyWrap: KeyWrap): Promise<EncryptedUpload> {
  const key = randomBytes(32)
  const iv = randomBytes(16)
  const plaintext = await file.bytes()

  const cipher = createCipheriv('aes-256-ctr', key, iv)
  const ciphertext = concatBytes(new Uint8Array(cipher.update(plaintext)), new Uint8Array(cipher.final()))
  const plainSha256 = createHash('sha256').update(plaintext).digest('hex')

  const keyMaterial = concatBytes(new Uint8Array(key), new Uint8Array(iv))

  return {
    ciphertext,
    headers: {
      'X-P2F-Enc-Client-Pubkey': keyWrap.clientPublicKeyBase64,
      'X-P2F-Enc-Key-Wrapped': wrapKeyMaterial(keyWrap.wrapKey, keyMaterial),
      'X-P2F-Plain-Sha256': plainSha256
    }
  }
}

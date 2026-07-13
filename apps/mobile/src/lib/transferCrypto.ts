import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'react-native-quick-crypto'
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

export function base64ToBytes (b64: string): Uint8Array {
  return toByteArray(b64)
}

function concatBytes (a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
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
 * generates a fresh one-shot key/IV; the server decrypts and verifies the
 * plaintext SHA-256 — see the doc comment on the /api/upload handler in
 * src/server/app.ts) but reads/writes whole buffers since there's no
 * streaming file API available here.
 */
export async function encryptFileForUpload (file: File): Promise<EncryptedUpload> {
  const key = randomBytes(32)
  const iv = randomBytes(16)
  const plaintext = await file.bytes()

  const cipher = createCipheriv('aes-256-ctr', key, iv)
  const ciphertext = concatBytes(new Uint8Array(cipher.update(plaintext)), new Uint8Array(cipher.final()))
  const plainSha256 = createHash('sha256').update(plaintext).digest('hex')

  return {
    ciphertext,
    headers: {
      'X-P2F-Enc-Key': fromByteArray(new Uint8Array(key)),
      'X-P2F-Enc-Iv': fromByteArray(new Uint8Array(iv)),
      'X-P2F-Plain-Sha256': plainSha256
    }
  }
}

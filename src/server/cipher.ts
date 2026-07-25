import crypto from 'node:crypto'
import { Transform } from 'node:stream'

export const CIPHER_ALGO = 'aes-256-ctr'
export const IV_LEN = 16
export const BLOCK_LEN = 16

/**
 * Application-layer transfer encryption, streamed. Every shared file is
 * AES-256-CTR encrypted with a key+IV derived deterministically from a
 * per-server master secret and the file's identity (path+size+mtime) — never
 * randomly per process. Determinism is what lets the ciphertext (and therefore
 * the BitTorrent infohash computed over it) stay byte-identical across restarts
 * without persisting anything: the same file always encrypts to the same bytes,
 * so a client holding old torrent metadata can keep downloading after the
 * server comes back.
 *
 * CTR is a stream cipher whose keystream for any byte is computable directly
 * from its offset, so we never have to materialize the whole ciphertext. The
 * torrent metadata is hashed in a single streaming pass (torrents.ts), the HTTP
 * webseed encrypts each requested byte range on the fly (app.ts /api/raw), and
 * the WebRTC seeder serves pieces through an on-demand chunk store
 * (cipherStore.ts) — none of them keep more than a small buffer resident. These
 * helpers are the shared, I/O-free core all three build on.
 */

/** HKDF-derive a deterministic AES-256-CTR key+IV for one file identity. */
export function deriveFileCipher (masterSecret: Buffer, identity: string): { key: Buffer, iv: Buffer } {
  const derived = Buffer.from(crypto.hkdfSync('sha256', masterSecret, identity, 'p2f-transfer-cipher', 48))
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) }
}

/**
 * The CTR counter block `blockIndex` 16-byte blocks past `iv`: a big-endian
 * 128-bit add. Encrypting starting at block N with this counter yields exactly
 * the same keystream a from-zero pass would produce at that block, which is
 * what makes seeking into the ciphertext byte-exact.
 */
export function ctrCounter (iv: Buffer, blockIndex: number): Buffer {
  const c = Buffer.from(iv)
  let carry = blockIndex
  for (let i = IV_LEN - 1; i >= 0 && carry > 0; i--) {
    const sum = c[i]! + (carry % 256)
    c[i] = sum & 0xff
    carry = Math.floor(carry / 256) + (sum > 255 ? 1 : 0)
  }
  return c
}

/** A CTR cipher whose keystream is positioned at the start of block `blockIndex`. */
export function ctrCipherAt (key: Buffer, iv: Buffer, blockIndex: number): crypto.Cipheriv {
  return crypto.createCipheriv(CIPHER_ALGO, key, ctrCounter(iv, blockIndex))
}

/**
 * Encrypt a plaintext slice that begins at absolute byte offset `absOffset`,
 * producing exactly the ciphertext bytes a full-file encrypt would have at
 * [absOffset, absOffset+plain.length). Seeks to the containing block, then
 * discards the intra-block keystream so unaligned offsets come out right.
 */
export function encryptRange (plain: Buffer, key: Buffer, iv: Buffer, absOffset: number): Buffer {
  const blockIndex = Math.floor(absOffset / BLOCK_LEN)
  const intra = absOffset % BLOCK_LEN
  const cipher = ctrCipherAt(key, iv, blockIndex)
  if (intra > 0) cipher.update(Buffer.alloc(intra)) // burn keystream up to absOffset
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/** Transform that drops the first `n` bytes it sees, then passes the rest through. */
export class DropBytes extends Transform {
  private left: number
  constructor (n: number) { super(); this.left = n }
  _transform (chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    if (this.left > 0) {
      const drop = Math.min(this.left, chunk.length)
      this.left -= drop
      chunk = chunk.subarray(drop)
    }
    cb(null, chunk)
  }
}

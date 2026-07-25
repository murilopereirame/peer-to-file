import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import { deriveFileCipher, ctrCipherAt, BLOCK_LEN } from './cipher.ts'

export interface FileCipher {
  key: Buffer
  iv: Buffer
  /** Plaintext size in bytes; CTR is length-preserving, so also the ciphertext size. */
  size: number
}

export interface CipherKeys {
  /** Deterministic AES-256-CTR key+IV for a file, derived from its identity. Cheap: a stat plus HKDF, no I/O over the data. */
  getKeys (absPath: string): Promise<FileCipher>
  /**
   * A Readable of ciphertext for the plaintext byte range [start, end]
   * (inclusive), encrypted on the fly from a small rolling buffer — nothing is
   * cached. Used by the HTTP webseed to answer Range requests.
   */
  encryptedRange (absPath: string, key: Buffer, iv: Buffer, start: number, end: number): Readable
}

/** Read size for the on-the-fly encryptor: small enough that a transfer never holds much ciphertext, large enough to keep the pipe full. */
const READ_CHUNK = 64 * 1024

export function createCipherKeys (masterSecret: Buffer): CipherKeys {
  async function getKeys (absPath: string): Promise<FileCipher> {
    const st = await fs.stat(absPath)
    const identity = `${absPath}:${st.size}:${st.mtimeMs}`
    const { key, iv } = deriveFileCipher(masterSecret, identity)
    return { key, iv, size: st.size }
  }

  function encryptedRange (absPath: string, key: Buffer, iv: Buffer, start: number, end: number): Readable {
    // Align the read down to the containing cipher block, then drop the
    // intra-block prefix so an unaligned `start` still yields the exact bytes
    // a from-zero encrypt would have produced there.
    const blockIndex = Math.floor(start / BLOCK_LEN)
    const intra = start % BLOCK_LEN
    const alignedStart = blockIndex * BLOCK_LEN

    async function * encrypt (): AsyncGenerator<Buffer> {
      const fh = await fs.open(absPath, 'r')
      try {
        const cipher = ctrCipherAt(key, iv, blockIndex)
        const buf = Buffer.allocUnsafe(READ_CHUNK)
        let pos = alignedStart
        let dropped = 0
        while (pos <= end) {
          const toRead = Math.min(buf.length, end - pos + 1)
          const { bytesRead } = await fh.read(buf, 0, toRead, pos)
          if (bytesRead === 0) break
          pos += bytesRead
          let ct = cipher.update(buf.subarray(0, bytesRead))
          if (dropped < intra) {
            const drop = Math.min(intra - dropped, ct.length)
            dropped += drop
            ct = ct.subarray(drop)
          }
          if (ct.length > 0) yield ct
        }
        const fin = cipher.final()
        if (fin.length > 0) yield fin
      } finally {
        await fh.close()
      }
    }

    return Readable.from(encrypt())
  }

  return { getKeys, encryptedRange }
}

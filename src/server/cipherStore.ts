import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { encryptRange } from './cipher.ts'

/**
 * A WebTorrent chunk store that serves ciphertext pieces on demand instead of
 * from a pre-encrypted file on disk. WebTorrent's Node seeder needs random
 * access to any piece at any time; a stream won't do. But because AES-CTR is
 * seekable, each `get(index)` can read just that piece's plaintext from the
 * source file and encrypt it right there — so the seeder holds only the pieces
 * currently in flight, never a whole ciphertext copy. WebTorrent wraps this in
 * its own small LRU (storeCacheSlots, default 20), which keeps hot pieces from
 * being re-encrypted on every request.
 *
 * The store is read-only: seeding never writes pieces (we already have the
 * plaintext), so `put` is a no-op. `get` deterministically reproduces the exact
 * ciphertext the infohash was computed over, so every piece verifies and the
 * torrent seeds at 100%.
 *
 * `makeCipherStore` binds the source file + key/iv into a store class WebTorrent
 * can instantiate as `new Store(pieceLength, { length, ... })`.
 */
export function makeCipherStore (absPath: string, key: Buffer, iv: Buffer): new (chunkLength: number, opts: { length: number }) => CipherChunkStore {
  return class extends CipherChunkStore {
    constructor (chunkLength: number, opts: { length: number }) {
      super(chunkLength, opts.length, absPath, key, iv)
    }
  }
}

type GetOpts = { offset?: number, length?: number }
type Cb<T> = (err: Error | null, value?: T) => void

class CipherChunkStore {
  readonly chunkLength: number
  private readonly length: number
  private readonly absPath: string
  private readonly key: Buffer
  private readonly iv: Buffer
  private fh: Promise<FileHandle> | null = null

  constructor (chunkLength: number, length: number, absPath: string, key: Buffer, iv: Buffer) {
    this.chunkLength = chunkLength
    this.length = length
    this.absPath = absPath
    this.key = key
    this.iv = iv
  }

  private handle (): Promise<FileHandle> {
    return (this.fh ??= fs.open(this.absPath, 'r'))
  }

  // Seeding never receives piece data — we produce it from the source instead.
  put (_index: number, _buf: Buffer, cb?: Cb<void>): void {
    if (cb) cb(null)
  }

  get (index: number, opts: GetOpts | Cb<Buffer>, cb?: Cb<Buffer>): void {
    if (typeof opts === 'function') { cb = opts; opts = {} }
    const done = cb!
    const pieceStart = index * this.chunkLength
    const pieceLength = Math.min(this.chunkLength, this.length - pieceStart)
    const offset = opts.offset ?? 0
    const wantLength = opts.length ?? (pieceLength - offset)
    const absOffset = pieceStart + offset
    if (absOffset < 0 || wantLength < 0 || absOffset + wantLength > this.length) {
      done(new Error('cipher store: read out of range'))
      return
    }
    this.handle().then(async fh => {
      const plain = Buffer.allocUnsafe(wantLength)
      const { bytesRead } = await fh.read(plain, 0, wantLength, absOffset)
      done(null, encryptRange(plain.subarray(0, bytesRead), this.key, this.iv, absOffset))
    }).catch((err: Error) => done(err))
  }

  close (cb?: Cb<void>): void {
    const pending = this.fh
    this.fh = null
    if (!pending) { if (cb) cb(null); return }
    pending.then(fh => fh.close()).then(() => cb?.(null), () => cb?.(null))
  }

  destroy (cb?: Cb<void>): void {
    this.close(cb)
  }
}

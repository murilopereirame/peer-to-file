import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { Transform } from 'node:stream'
import createTorrent from 'create-torrent'
import parseTorrent, { toMagnetURI, toTorrentFile, type ParsedTorrent } from 'parse-torrent'
import { BrowseError } from './browse.ts'
import { CIPHER_ALGO } from './cipher.ts'
import type { CipherKeys } from './cipherKeys.ts'

export interface RenderedTorrent {
  torrentFile: Uint8Array
  magnet: string
}

export interface TorrentMeta {
  meta: ParsedTorrent
  /** SHA-256 of the original plaintext (hex) — lets a client verify a finished
   * download decrypted and saved correctly, independent of BitTorrent's own
   * per-piece hashing (which only covers the ciphertext reaching the client). */
  plainSha256: string
}

export interface TorrentStore {
  getMeta (absPath: string): Promise<TorrentMeta>
}

/**
 * On-demand torrent metadata store. Hashing a file is expensive, so parsed
 * metadata is cached per absolute path and invalidated when size/mtime change.
 * The info dict (and therefore the infohash) is deterministic for unchanged
 * file content, so it survives server restarts — a client holding old metadata
 * can keep downloading after the server comes back.
 *
 * Metadata is built over the file's *ciphertext*, streamed on the fly: the
 * plaintext is read once, encrypted (cipherKeys' deterministic key/IV), and fed
 * straight into create-torrent's piece hasher, which consumes it incrementally
 * — so the piece hashes (and infohash) end up computed over exactly the bytes
 * the webseed and WebRTC seeder serve, without ever materializing the whole
 * ciphertext. The same pass hashes the plaintext for the end-to-end checksum.
 */
export function createTorrentStore (cipherKeys: CipherKeys): TorrentStore {
  const cache = new Map<string, { key: string, promise: Promise<TorrentMeta> }>()

  async function getMeta (absPath: string): Promise<TorrentMeta> {
    const st = await fs.stat(absPath)
    if (!st.isFile()) {
      throw new BrowseError(400, 'not a file')
    }
    const key = `${st.size}:${st.mtimeMs}`
    let entry = cache.get(absPath)
    if (!entry || entry.key !== key) {
      const fresh: { key: string, promise: Promise<TorrentMeta> } = {
        key,
        promise: buildMeta(absPath, st.size)
      }
      fresh.promise.catch(() => {
        // don't cache failures
        if (cache.get(absPath) === fresh) cache.delete(absPath)
      })
      cache.set(absPath, fresh)
      entry = fresh
    }
    return entry.promise
  }

  async function buildMeta (absPath: string, size: number): Promise<TorrentMeta> {
    const { key, iv } = await cipherKeys.getKeys(absPath)
    const plainHash = crypto.createHash('sha256')

    const read = fsSync.createReadStream(absPath)
    // Tap the plaintext for the end-to-end checksum as it flows past.
    const tap = new Transform({
      transform (chunk, _enc, cb) { plainHash.update(chunk as Buffer); cb(null, chunk) }
    })
    const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv)
    read.on('error', err => cipher.destroy(err))
    tap.on('error', err => cipher.destroy(err))
    read.pipe(tap).pipe(cipher)

    const meta = await new Promise<ParsedTorrent>((resolve, reject) => {
      // `private` keeps conforming clients off DHT/PEX; announce/urlList live
      // outside the info dict and get filled in per request. `name` is the
      // source basename (a stream has no filename of its own), so what the user
      // asked to download still matches. create-torrent hashes the ciphertext
      // stream incrementally — no whole-file buffer.
      createTorrent(cipher, { name: path.basename(absPath), private: true, pieceLength: pieceLengthFor(size) }, (err, buf) => {
        if (err) { read.destroy(); return reject(err) }
        parseTorrent(buf).then(resolve, reject)
      })
    })

    return { meta, plainSha256: plainHash.digest('hex') }
  }

  return { getMeta }
}

// Aim for ~1024 pieces, clamped to [256 KiB, 8 MiB]. create-torrent's default
// (16 KiB minimum) produces tens of thousands of pieces for big files, which
// drags transfers down: every piece is a request round-trip, a hash check and
// a browser storage write. Fewer, larger pieces keep the pipe full.
export function pieceLengthFor (size: number): number {
  const target = Math.ceil(size / 1024)
  let pieceLength = 256 * 1024
  while (pieceLength < target && pieceLength < 8 * 1024 * 1024) pieceLength *= 2
  return pieceLength
}

/**
 * Render cached metadata into a .torrent buffer + magnet URI with
 * request-specific tracker and webseed URLs. announce/urlList live outside
 * the info dict, so the infohash stays identical no matter which
 * host/tracker the client reached us on.
 */
export function renderTorrent (
  meta: ParsedTorrent,
  { announce, urlList }: { announce: string[], urlList: string[] }
): RenderedTorrent {
  const shaped = { ...meta, announce, urlList }
  return {
    torrentFile: toTorrentFile(shaped),
    magnet: toMagnetURI(shaped)
  }
}

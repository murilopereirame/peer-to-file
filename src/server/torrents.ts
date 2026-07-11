import fs from 'node:fs/promises'
import createTorrent from 'create-torrent'
import parseTorrent, { toMagnetURI, toTorrentFile, type ParsedTorrent } from 'parse-torrent'
import { BrowseError } from './browse.ts'

export interface RenderedTorrent {
  torrentFile: Uint8Array
  magnet: string
}

export interface TorrentStore {
  getMeta (absPath: string): Promise<ParsedTorrent>
}

/**
 * On-demand torrent metadata store. Hashing a file is expensive, so parsed
 * metadata is cached per absolute path and invalidated when size/mtime
 * change. The info dict (and therefore the infohash) is deterministic for
 * unchanged file content, so it survives server restarts — a client holding
 * old metadata can keep downloading after the server comes back.
 */
export function createTorrentStore (): TorrentStore {
  const cache = new Map<string, { key: string, promise: Promise<ParsedTorrent> }>()

  async function getMeta (absPath: string): Promise<ParsedTorrent> {
    const st = await fs.stat(absPath)
    if (!st.isFile()) {
      throw new BrowseError(400, 'not a file')
    }
    const key = `${st.size}:${st.mtimeMs}`
    let entry = cache.get(absPath)
    if (!entry || entry.key !== key) {
      const fresh: { key: string, promise: Promise<ParsedTorrent> } = {
        key,
        promise: buildMeta(absPath)
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

async function buildMeta (absPath: string): Promise<ParsedTorrent> {
  const { size } = await fs.stat(absPath)
  return new Promise((resolve, reject) => {
    // `private` keeps conforming clients off DHT/PEX; announce/urlList live
    // outside the info dict and get filled in per request.
    createTorrent(absPath, { private: true, pieceLength: pieceLengthFor(size) }, (err, buf) => {
      if (err) return reject(err)
      parseTorrent(buf).then(resolve, reject)
    })
  })
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

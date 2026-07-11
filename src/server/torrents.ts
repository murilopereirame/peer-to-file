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

function buildMeta (absPath: string): Promise<ParsedTorrent> {
  return new Promise((resolve, reject) => {
    // `private` keeps conforming clients off DHT/PEX; announce/urlList live
    // outside the info dict and get filled in per request.
    createTorrent(absPath, { private: true }, (err, buf) => {
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

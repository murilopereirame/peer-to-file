import path from 'node:path'
import { toTorrentFile, type ParsedTorrent } from 'parse-torrent'
import type { Logger } from './log.ts'

export interface Seeder {
  enabled: boolean
  ensureSeeding (cipherPath: string, meta: ParsedTorrent): void
  /** Whether a ciphertext cache file is currently being seeded (pins it against cache eviction). */
  isSeeding (cipherPath: string): boolean
  /**
   * Stop seeding any torrent that currently has no connected peers and has seen
   * no peer activity for at least `idleMs` — i.e. is no longer being
   * transferred. Its cache file is unpinned (so the cache reaper can then
   * delete it) and re-added deterministically on the next request. Returns the
   * ciphertext cache paths that were unpinned.
   */
  reapIdle (idleMs: number): string[]
  destroy (): Promise<void>
}

/**
 * WebRTC seeder: a Node-side WebTorrent client that seeds requested files so
 * browsers can pull them over WebRTC (peers meet via the embedded tracker).
 *
 * WebTorrent's Node WebRTC support needs the node-datachannel native module.
 * If it can't be loaded (unsupported platform, failed install), the server
 * still works: torrents carry an HTTP webseed URL, which browsers use as a
 * data source through the exact same chunked/verified/resumable machinery.
 */
export async function createSeeder (
  { announce, log }: { announce: (infoHash: string) => string[], log: Logger }
): Promise<Seeder> {
  let WebTorrent: typeof import('webtorrent').default
  try {
    WebTorrent = (await import('webtorrent')).default
  } catch (err) {
    log.warn(`WebRTC seeding disabled (webtorrent failed to load: ${(err as Error).message})`)
    log.warn('Downloads will use the HTTP webseed path only.')
    return {
      enabled: false,
      ensureSeeding () {},
      isSeeding: () => false,
      reapIdle: () => [],
      async destroy () {}
    }
  }

  // The tracker handles peer discovery; DHT/LSD/NAT traversal are pointless
  // on a two-peer VPN and would leak announces beyond it.
  const client = new WebTorrent({
    dht: false,
    lsd: false,
    natUpnp: false,
    natPmp: false
  })
  client.on('error', (err: unknown) => log.error(`seeder error: ${(err as Error).message}`))

  interface Seeded {
    torrent: import('webtorrent').NodeTorrent
    cipherPath: string
    /** Last time this torrent had peer activity (added, a peer connected, or a
     * byte was uploaded) — the clock the idle reaper measures against. */
    lastActive: number
  }
  const seeded = new Map<string, Seeded>() // infohash -> seeding record
  const seededPaths = new Set<string>() // ciphertext cache files pinned against eviction

  function ensureSeeding (cipherPath: string, meta: ParsedTorrent): void {
    const existing = seeded.get(meta.infoHash)
    if (existing) {
      // Already seeding — a fresh request means it's wanted again, so keep it
      // out of the idle reaper's reach.
      existing.lastActive = Date.now()
      return
    }
    // Re-use the exact metadata served to clients (same infohash) and point
    // the store at the ciphertext cache file (same basename as the source,
    // see cipherCache.ts): WebTorrent verifies pieces, then seeds — peers get
    // ciphertext over the wire, matching what /api/raw serves.
    const torrentFile = toTorrentFile({ ...meta, announce: announce(meta.infoHash) })
    const torrent = client.add(torrentFile, { path: path.dirname(cipherPath) })
    const record: Seeded = { torrent, cipherPath, lastActive: Date.now() }
    seeded.set(meta.infoHash, record)
    seededPaths.add(cipherPath)
    torrent.on('ready', () => {
      log.info(`seeding ${meta.name} (${meta.infoHash})`)
    })
    // Any sign of a live transfer refreshes the idle clock.
    const touch = (): void => { record.lastActive = Date.now() }
    torrent.on('wire', touch)
    torrent.on('upload', touch)
    torrent.on('error', (err: unknown) => {
      seeded.delete(meta.infoHash)
      seededPaths.delete(cipherPath)
      log.error(`failed to seed ${meta.name}: ${(err as Error).message}`)
    })
  }

  function reapIdle (idleMs: number): string[] {
    const now = Date.now()
    const reaped: string[] = []
    for (const [infoHash, record] of seeded) {
      // A connected peer means it's actively being transferred — keep it, and
      // reset the clock so it survives the next sweep too.
      if (record.torrent.numPeers > 0) {
        record.lastActive = now
        continue
      }
      if (now - record.lastActive < idleMs) continue
      try {
        client.remove(infoHash)
      } catch (err) {
        log.warn(`failed to stop seeding ${infoHash}: ${(err as Error).message}`)
      }
      seeded.delete(infoHash)
      seededPaths.delete(record.cipherPath)
      reaped.push(record.cipherPath)
      log.info(`stopped seeding idle ${infoHash}`)
    }
    return reaped
  }

  return {
    enabled: true,
    ensureSeeding,
    isSeeding: cipherPath => seededPaths.has(cipherPath),
    reapIdle,
    destroy () {
      return new Promise(resolve => client.destroy(() => resolve()))
    }
  }
}

import { toTorrentFile, type ParsedTorrent } from 'parse-torrent'
import { makeCipherStore } from './cipherStore.ts'
import type { Logger } from './log.ts'

export interface Seeder {
  enabled: boolean
  /** Seed a file over WebRTC, serving ciphertext pieces on demand (no cache file). */
  ensureSeeding (absPath: string, meta: ParsedTorrent, key: Buffer, iv: Buffer): void
  /**
   * Stop seeding any torrent that currently has no connected peers and has seen
   * no peer activity for at least `idleMs` — i.e. is no longer being
   * transferred — so idle swarms don't accumulate in the client forever. It's
   * re-added deterministically on the next request. Returns how many were dropped.
   */
  reapIdle (idleMs: number): number
  destroy (): Promise<void>
}

/**
 * WebRTC seeder: a Node-side WebTorrent client that seeds requested files so
 * browsers can pull them over WebRTC (peers meet via the embedded tracker).
 *
 * Pieces are served through an on-demand ciphertext store (cipherStore.ts)
 * rather than a pre-encrypted file — the seeder holds only the pieces currently
 * in flight, and the bytes it serves match what /api/raw serves and what the
 * infohash was computed over.
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
      reapIdle: () => 0,
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
    /** Last time this torrent had peer activity — the clock the idle reaper measures against. */
    lastActive: number
  }
  const seeded = new Map<string, Seeded>() // infohash -> seeding record

  function ensureSeeding (absPath: string, meta: ParsedTorrent, key: Buffer, iv: Buffer): void {
    const existing = seeded.get(meta.infoHash)
    if (existing) {
      // Already seeding — a fresh request means it's wanted again, so keep it
      // out of the idle reaper's reach.
      existing.lastActive = Date.now()
      return
    }

    // Re-use the exact metadata served to clients (same infohash). The store
    // encrypts each requested piece on demand from the source file, so peers
    // get ciphertext over the wire matching what /api/raw serves — no cache
    // file, and none needed for verification (every piece reproduces exactly).
    const torrentFile = toTorrentFile({ ...meta, announce: announce(meta.infoHash) })
    const torrent = client.add(torrentFile, { store: makeCipherStore(absPath, key, iv) })
    const record: Seeded = { torrent, lastActive: Date.now() }
    seeded.set(meta.infoHash, record)
    torrent.on('ready', () => {
      log.info(`seeding ${meta.name} (${meta.infoHash})`)
    })
    // Any sign of a live transfer refreshes the idle clock.
    const touch = (): void => { record.lastActive = Date.now() }
    torrent.on('wire', touch)
    torrent.on('upload', touch)
    torrent.on('error', (err: unknown) => {
      seeded.delete(meta.infoHash)
      log.error(`failed to seed ${meta.name}: ${(err as Error).message}`)
    })
  }

  function reapIdle (idleMs: number): number {
    const now = Date.now()
    let reaped = 0
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
      reaped++
      log.info(`stopped seeding idle ${infoHash}`)
    }
    return reaped
  }

  return {
    enabled: true,
    ensureSeeding,
    reapIdle,
    destroy () {
      return new Promise(resolve => client.destroy(() => resolve()))
    }
  }
}

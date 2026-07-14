import path from 'node:path'
import { toTorrentFile, type ParsedTorrent } from 'parse-torrent'
import type { Logger } from './log.ts'

export interface Seeder {
  enabled: boolean
  ensureSeeding (cipherPath: string, meta: ParsedTorrent): void
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
  { announce, log }: { announce: () => string[], log: Logger }
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

  const seeding = new Set<string>() // infohashes added to the client

  function ensureSeeding (cipherPath: string, meta: ParsedTorrent): void {
    if (seeding.has(meta.infoHash)) return
    seeding.add(meta.infoHash)

    // Re-use the exact metadata served to clients (same infohash) and point
    // the store at the ciphertext cache file (same basename as the source,
    // see cipherCache.ts): WebTorrent verifies pieces, then seeds — peers get
    // ciphertext over the wire, matching what /api/raw serves.
    const torrentFile = toTorrentFile({ ...meta, announce: announce() })
    const torrent = client.add(torrentFile, { path: path.dirname(cipherPath) })
    torrent.on('ready', () => {
      log.info(`seeding ${meta.name} (${meta.infoHash})`)
    })
    torrent.on('error', (err: unknown) => {
      seeding.delete(meta.infoHash)
      log.error(`failed to seed ${meta.name}: ${(err as Error).message}`)
    })
  }

  return {
    enabled: true,
    ensureSeeding,
    destroy () {
      return new Promise(resolve => client.destroy(() => resolve()))
    }
  }
}

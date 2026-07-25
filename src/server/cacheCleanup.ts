import type { Seeder } from './seeder.ts'
import type { CipherCache } from './cipherCache.ts'
import type { ActivityLog } from './activity.ts'
import type { Logger } from './log.ts'

export interface CacheCleanup {
  /** Run one cleanup pass now (also driven on the interval). Never rejects. */
  runOnce (): Promise<void>
  /** Stop the periodic sweep. */
  stop (): void
}

export interface CacheCleanupOptions {
  seeder: Seeder
  cipherCache: CipherCache
  activity: ActivityLog
  log: Logger
  /** How often to sweep (default hourly). */
  intervalMs?: number
  /** How long an entry must sit unused before it's reaped (default 1 hour). */
  idleMs?: number
}

/**
 * Periodic ciphertext-cache reaper. The transfer-encryption cache
 * (cipherCache.ts) writes a full ciphertext copy of every requested file to
 * disk — necessary because the WebRTC seeder and BitTorrent piece hashing both
 * need random access to the complete ciphertext, so we can't encrypt purely on
 * the fly. Left alone, that cache only shrinks when it hits its byte cap, and a
 * file requested once stays pinned as long as the seeder holds its torrent
 * (which, before this, was forever). This sweep closes that gap: on each tick
 * it first drops seeder torrents that have no peers and have gone idle
 * (unpinning their cache files), then deletes any cache entry no longer pinned
 * and untouched within the idle window. Nothing is lost — an unchanged file
 * re-encrypts to byte-identical ciphertext (same infohash) on its next request.
 */
export function startCacheCleanup (
  { seeder, cipherCache, activity, log, intervalMs = 60 * 60 * 1000, idleMs = 60 * 60 * 1000 }: CacheCleanupOptions
): CacheCleanup {
  async function runOnce (): Promise<void> {
    try {
      // Unpin idle torrents first, so entries they were pinning become
      // reapable in this same pass.
      const unpinned = seeder.reapIdle(idleMs)
      const { removed, bytesFreed } = await cipherCache.reapIdle(idleMs)
      if (removed > 0 || unpinned.length > 0) {
        const msg = `cache cleanup: stopped ${unpinned.length} idle torrent(s), ` +
          `removed ${removed} cache entr${removed === 1 ? 'y' : 'ies'} (${bytesFreed} bytes freed)`
        log.info(msg)
        activity.add('server', msg)
      }
    } catch (err) {
      log.warn(`cache cleanup failed: ${(err as Error).message}`)
    }
  }

  const timer = setInterval(() => { void runOnce() }, intervalMs)
  // Don't let the sweep keep the process alive on its own.
  timer.unref?.()

  return {
    runOnce,
    stop () { clearInterval(timer) }
  }
}

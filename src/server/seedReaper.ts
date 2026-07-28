import type { Seeder } from './seeder.ts'
import type { ActivityLog } from './activity.ts'
import type { Logger } from './log.ts'

export interface SeedReaper {
  /** Run one sweep now (also driven on the interval). Never rejects. */
  runOnce (): void
  /** Stop the periodic sweep. */
  stop (): void
}

export interface SeedReaperOptions {
  seeder: Seeder
  activity: ActivityLog
  log: Logger
  /** How often to sweep (default hourly). */
  intervalMs?: number
  /** How long a torrent must sit with no peers before it's dropped (default 1 hour). */
  idleMs?: number
}

/**
 * Periodic idle-torrent reaper. Transfer encryption no longer persists any
 * ciphertext — the webseed and the WebRTC seeder both produce it on the fly —
 * so there is no on-disk cache to reclaim. What can still accumulate is the
 * WebRTC seeder's swarm: requesting a file adds its torrent to the WebTorrent
 * client, and without this it would stay there forever. This sweep drops
 * torrents that have no connected peers and have gone idle; each is re-added
 * deterministically (same infohash) the next time it's requested.
 */
export function startSeedReaper (
  { seeder, activity, log, intervalMs = 60 * 60 * 1000, idleMs = 60 * 60 * 1000 }: SeedReaperOptions
): SeedReaper {
  function runOnce (): void {
    try {
      const reaped = seeder.reapIdle(idleMs)
      if (reaped > 0) {
        const msg = `stopped seeding ${reaped} idle torrent(s)`
        log.info(msg)
        activity.add('server', msg)
      }
    } catch (err) {
      log.warn(`seed reaper failed: ${(err as Error).message}`)
    }
  }

  const timer = setInterval(runOnce, intervalMs)
  // Don't let the sweep keep the process alive on its own.
  timer.unref?.()

  return {
    runOnce,
    stop () { clearInterval(timer) }
  }
}

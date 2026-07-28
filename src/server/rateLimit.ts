/**
 * Tiny in-memory rate limiters — no dependency, single-process only (same
 * scope as the activity log and torrent caches). Two shapes are used:
 *
 *  - a fixed-window counter, for "N failed logins per IP per window" (F1);
 *  - a token bucket, for smoothing bursts against the expensive
 *    hash+encrypt / disk-write endpoints (F2).
 *
 * Both prune opportunistically so a long uptime with many distinct keys
 * doesn't grow the maps without bound — same approach as createDebouncer.
 */

export interface FixedWindowLimiter {
  /** True if `key` has already exceeded the limit in the current window (no increment). */
  isLimited (key: string): boolean
  /** Record one hit for `key` (call on each failure). */
  hit (key: string): void
  /** Milliseconds until the current window resets for `key`. */
  retryAfterMs (key: string): number
  /** Forget a key (e.g. clear an IP's failed-login count after a success). */
  reset (key: string): void
}

export function createFixedWindowLimiter (limit: number, windowMs: number): FixedWindowLimiter {
  const hits = new Map<string, { count: number, resetAt: number }>()

  const prune = (now: number): void => {
    if (hits.size <= 5000) return
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
  }

  const current = (key: string, now: number): { count: number, resetAt: number } | null => {
    const entry = hits.get(key)
    if (!entry || entry.resetAt <= now) return null
    return entry
  }

  return {
    isLimited (key) {
      const entry = current(key, Date.now())
      return entry !== null && entry.count > limit
    },
    hit (key) {
      const now = Date.now()
      prune(now)
      const entry = current(key, now)
      if (!entry) {
        hits.set(key, { count: 1, resetAt: now + windowMs })
        return
      }
      entry.count++
    },
    retryAfterMs (key) {
      const entry = current(key, Date.now())
      return entry ? Math.max(0, entry.resetAt - Date.now()) : 0
    },
    reset (key) {
      hits.delete(key)
    }
  }
}

export interface TokenBucketLimiter {
  /** Try to spend one token for `key`; false means the bucket is empty (throttle). */
  take (key: string): boolean
}

/** Refills `capacity` tokens over `refillMs`, per key. */
export function createTokenBucketLimiter (capacity: number, refillMs: number): TokenBucketLimiter {
  const buckets = new Map<string, { tokens: number, updatedAt: number }>()
  const ratePerMs = capacity / refillMs

  const prune = (now: number): void => {
    if (buckets.size <= 5000) return
    for (const [k, v] of buckets) if (now - v.updatedAt > refillMs) buckets.delete(k)
  }

  return {
    take (key) {
      const now = Date.now()
      prune(now)
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { tokens: capacity, updatedAt: now }
        buckets.set(key, bucket)
      } else {
        bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * ratePerMs)
        bucket.updatedAt = now
      }
      if (bucket.tokens < 1) return false
      bucket.tokens -= 1
      return true
    }
  }
}

/**
 * Bounded in-memory log of connections and transfer activity, for the web
 * client's "Logs" page. Intentionally not persisted: it exists to answer
 * "what's happening right now / just happened", not to be an audit trail —
 * a restart clearing it is fine, and keeps this to a plain ring buffer with
 * no database or file I/O.
 */

export type LogKind = 'auth' | 'browse' | 'torrent' | 'webseed' | 'tracker' | 'connection' | 'server'

export interface LogEntry {
  id: number
  ts: number
  kind: LogKind
  message: string
  meta?: Record<string, unknown>
}

export interface ActivityLog {
  add (kind: LogKind, message: string, meta?: Record<string, unknown>): void
  list (opts?: { limit?: number, sinceId?: number }): LogEntry[]
}

export function createActivityLog (capacity = 500): ActivityLog {
  const entries: LogEntry[] = []
  let nextId = 1

  return {
    add (kind, message, meta) {
      entries.push({ id: nextId++, ts: Date.now(), kind, message, meta })
      if (entries.length > capacity) entries.splice(0, entries.length - capacity)
    },

    list ({ limit = 200, sinceId } = {}) {
      const bounded = Math.max(1, Math.min(limit, capacity))
      let result: LogEntry[] = entries
      if (sinceId !== undefined && Number.isFinite(sinceId)) {
        result = result.filter(e => e.id > sinceId)
      }
      // newest first, most recent `bounded` entries
      return result.slice(-bounded).reverse()
    }
  }
}

/** Debounces noisy per-request events (e.g. ranged webseed hits) to one log line per key per window. */
export function createDebouncer (windowMs: number): (key: string) => boolean {
  const lastSeen = new Map<string, number>()
  return key => {
    const now = Date.now()
    const last = lastSeen.get(key)
    if (last !== undefined && now - last < windowMs) return false
    lastSeen.set(key, now)
    // opportunistic cleanup so the map doesn't grow unbounded over a long uptime
    if (lastSeen.size > 1000) {
      for (const [k, t] of lastSeen) {
        if (now - t > windowMs) lastSeen.delete(k)
      }
    }
    return true
  }
}

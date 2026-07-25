import fs from 'node:fs'
import path from 'node:path'

export interface Config {
  /** Absolute, symlink-resolved directory being shared. */
  root: string
  /** Bind address for HTTP + tracker. Default 127.0.0.1 — set to your VPN IP. */
  host: string
  /** HTTP port (browse API + web client). */
  port: number
  /** Embedded WebSocket tracker port. */
  trackerPort: number
  /** Optional host override used in announce/webseed URLs handed to clients. */
  publicHost: string | null
  /**
   * Optional public origin (e.g. https://files.example.com) when running
   * behind a reverse proxy. Announce/webseed URLs then use this origin, with
   * the tracker reached at <publicUrl>/tracker on the main HTTP port.
   */
  publicUrl: string | null
  /** SQLite database path for users/sessions/tokens (default ./p2f.db). */
  dbPath: string
  /**
   * How long a seeded torrent may sit with no connected peers before the hourly
   * reaper stops seeding it (it's re-added on the next request). Transfer
   * encryption is streamed on the fly, so there is no ciphertext cache to size
   * or reclaim — only the WebRTC swarm. Default 1 hour.
   */
  seedIdleMs: number
  /** How often the seed reaper sweeps for idle torrents. Default 1 hour. */
  seedSweepIntervalMs: number
  /**
   * Whether to mark auth cookies `Secure`. 'auto' (default) derives it from
   * the effective external scheme (P2F_PUBLIC_URL and, with P2F_TRUST_PROXY
   * on, X-Forwarded-Proto); 'on'/'off' force it.
   */
  secureCookies: 'auto' | 'on' | 'off'
  /**
   * When true, trust X-Forwarded-* from a front proxy so req.ip and the
   * request scheme are accurate. Off by default — a direct-bind deployment
   * must not trust spoofable headers.
   */
  trustProxy: boolean
}

function parseSecureCookies (value: string | undefined): 'auto' | 'on' | 'off' {
  if (value === undefined || value === '' || value === 'auto') return 'auto'
  if (value === 'on' || value === 'off') return value
  throw new Error(`P2F_SECURE_COOKIES must be 'auto', 'on' or 'off', got: ${value}`)
}

function parseBool (value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === '1' || value === 'true' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  throw new Error(`expected a boolean (on/off), got: ${value}`)
}

function parseMs (value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid duration (ms): ${value}`)
  return n
}

function parsePublicUrl (value: string | undefined): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`P2F_PUBLIC_URL is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`P2F_PUBLIC_URL must be http(s), got: ${value}`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`P2F_PUBLIC_URL must be a bare origin without a path: ${value}`)
  }
  return url.origin
}

function parsePort (value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return port
}

/**
 * Load configuration from environment variables:
 *
 *   P2F_ROOT         directory to serve (default ./data)
 *   P2F_HOST         bind address (default 127.0.0.1 — set to your VPN IP!)
 *   P2F_PORT         HTTP port for API + web client (default 8000)
 *   P2F_TRACKER_PORT embedded tracker port (default 8001)
 *   P2F_PUBLIC_HOST  optional host override for announce/webseed URLs
 *                    (useful behind port mappings; defaults to the Host
 *                    header of each request)
 *   P2F_PUBLIC_URL   public origin when behind a reverse proxy, e.g.
 *                    https://files.example.com — implies wss announce via
 *                    <origin>/tracker and takes precedence over P2F_PUBLIC_HOST
 *   P2F_DB           SQLite database path for users/sessions/API tokens and
 *                    download history (default ./p2f.db)
 *   P2F_SEED_IDLE_MS         idle time (no peers) before a seeded torrent is dropped (default 1h)
 *   P2F_SEED_SWEEP_INTERVAL_MS  how often the seed reaper runs (default 1h)
 *   P2F_SECURE_COOKIES   'auto' (default), 'on' or 'off' — mark auth cookies Secure
 *   P2F_TRUST_PROXY  'on'/'off' (default off) — trust X-Forwarded-* from a proxy
 */
export function loadConfig (env: NodeJS.ProcessEnv = process.env): Config {
  const rootInput = path.resolve(env.P2F_ROOT || './data')
  let root: string
  try {
    root = fs.realpathSync(rootInput)
  } catch {
    throw new Error(`P2F_ROOT directory does not exist: ${rootInput}`)
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`P2F_ROOT is not a directory: ${root}`)
  }

  return {
    root,
    host: env.P2F_HOST || '127.0.0.1',
    port: parsePort(env.P2F_PORT, 8000),
    trackerPort: parsePort(env.P2F_TRACKER_PORT, 8001),
    publicHost: env.P2F_PUBLIC_HOST || null,
    publicUrl: parsePublicUrl(env.P2F_PUBLIC_URL),
    dbPath: env.P2F_DB || path.resolve('./p2f.db'),
    seedIdleMs: parseMs(env.P2F_SEED_IDLE_MS, 60 * 60 * 1000),
    seedSweepIntervalMs: parseMs(env.P2F_SEED_SWEEP_INTERVAL_MS, 60 * 60 * 1000),
    secureCookies: parseSecureCookies(env.P2F_SECURE_COOKIES),
    trustProxy: parseBool(env.P2F_TRUST_PROXY, false)
  }
}

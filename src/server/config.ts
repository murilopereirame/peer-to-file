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
    publicUrl: parsePublicUrl(env.P2F_PUBLIC_URL)
  }
}

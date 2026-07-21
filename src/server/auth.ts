import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AuthDb, User } from './db.ts'

export const SESSION_COOKIE = 'p2f_session'
export const REFRESH_COOKIE = 'p2f_refresh'
export const REFRESH_PATH = '/api/refresh'
// Short-lived access credential; the refresh token below renews it silently.
export const ACCESS_TTL_MS = 48 * 60 * 60 * 1000 // 48 h, hard cap (not sliding)
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
// Kept short so a token leaked from a URL/proxy log has a small window; clients
// re-fetch /api/torrent (and thus re-mint) transparently on expiry.
export const TRANSFER_TOKEN_TTL_MS = 6 * 60 * 60 * 1000

export interface Session {
  user: User
  /** Raw access-session id (set as the p2f_session cookie). */
  accessId: string
  /** Raw refresh-token id (set as the p2f_refresh cookie). */
  refreshId: string
}

export interface AuthResult {
  user: User
  /** True when the credential was an ambient session cookie (CSRF-relevant),
   *  false for an explicit Authorization: Bearer token. */
  viaCookie: boolean
}

/**
 * Authentication is always on. Three credential kinds, one trust decision:
 *
 *  - Session cookies (HttpOnly, SameSite=Lax) for the web/desktop client,
 *    renewed by a longer-lived, single-use, rotating refresh cookie scoped to
 *    /api/refresh.
 *  - API tokens (`Authorization: Bearer p2f_...`) for scripts/cross-origin.
 *  - Stateless HMAC "transfer tokens" embedded in the webseed and tracker
 *    URLs handed out by /api/torrent. WebTorrent's fetch/WebSocket calls
 *    can't carry cookies reliably (cross-origin, or Node-internal seeder),
 *    so the URLs themselves must prove authorization. Raw-file tokens are
 *    bound to one path; tracker tokens are bound to one infohash.
 */
export interface AuthService {
  /** True until the first user is created (first-run web setup). */
  needsSetup (): boolean
  /** Create the first (admin) user and sign them in. Throws once a user exists. */
  setup (username: string, password: string): Session
  /** Resolve the requesting user from a session cookie or Bearer token. */
  authenticate (req: IncomingMessage): AuthResult | null
  login (username: string, password: string): Session | null
  /** Rotate a refresh token into a fresh access+refresh pair. Null if invalid/expired. */
  refresh (refreshId: string): Session | null
  logout (accessId: string, refreshId: string): void
  /** Invalidate every session and refresh token for a user (revoke-all). */
  logoutAll (userId: number): void
  mintRawToken (relPath: string): string
  verifyRawToken (relPath: string, token: string): boolean
  mintTrackerToken (infoHash: string, ttlMs?: number): string
  verifyTrackerToken (infoHash: string, token: string): boolean
}

export function parseCookies (header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

function sign (secret: Buffer, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

function verifySignedToken (secret: Buffer, scope: string, token: string): boolean {
  const dot = token.indexOf('.')
  if (dot === -1) return false
  const exp = Number(token.slice(0, dot))
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expected = sign(secret, `${scope}:${exp}`)
  const actual = token.slice(dot + 1)
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

function mintSignedToken (secret: Buffer, scope: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs
  return `${exp}.${sign(secret, `${scope}:${exp}`)}`
}

export function createAuthService (db: AuthDb): AuthService {
  const secret = db.transferSecret()

  const startSession = (user: User): Session => ({
    user,
    accessId: db.createSession(user.id, ACCESS_TTL_MS),
    refreshId: db.createRefreshToken(user.id, REFRESH_TTL_MS)
  })

  return {
    needsSetup: () => db.userCount() === 0,

    setup (username, password) {
      return startSession(db.setupFirstUser(username, password))
    },

    authenticate (req) {
      const authz = req.headers.authorization
      if (authz?.startsWith('Bearer ')) {
        const user = db.getTokenUser(authz.slice('Bearer '.length).trim())
        return user ? { user, viaCookie: false } : null
      }
      const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      if (sessionId) {
        // Access sessions are a hard 48 h cap — no sliding renewal; the
        // refresh cookie is what extends a login past that.
        const user = db.getSessionUser(sessionId)
        return user ? { user, viaCookie: true } : null
      }
      return null
    },

    login (username, password) {
      const user = db.verifyCredentials(username, password)
      if (!user) return null
      return startSession(user)
    },

    refresh (refreshId) {
      const user = db.consumeRefreshToken(refreshId)
      if (!user) return null
      return startSession(user)
    },

    logout (accessId, refreshId) {
      if (accessId) db.deleteSession(accessId)
      if (refreshId) db.deleteRefreshToken(refreshId)
    },

    logoutAll (userId) {
      db.deleteAllUserSessions(userId)
    },

    mintRawToken: relPath =>
      mintSignedToken(secret, `raw:${relPath}`, TRANSFER_TOKEN_TTL_MS),
    verifyRawToken: (relPath, token) =>
      verifySignedToken(secret, `raw:${relPath}`, token),
    mintTrackerToken: (infoHash, ttlMs = TRANSFER_TOKEN_TTL_MS) =>
      mintSignedToken(secret, `tracker:${infoHash}`, ttlMs),
    verifyTrackerToken: (infoHash, token) =>
      verifySignedToken(secret, `tracker:${infoHash}`, token)
  }
}

import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AuthDb, User } from './db.ts'

export const SESSION_COOKIE = 'p2f_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, sliding
export const TRANSFER_TOKEN_TTL_MS = 48 * 60 * 60 * 1000 // outlives long downloads

/**
 * Three credential kinds, one trust decision:
 *
 *  - Session cookies (HttpOnly, SameSite=Lax) for the web client.
 *  - API tokens (`Authorization: Bearer p2f_...`) for scripts/cross-origin.
 *  - Stateless HMAC "transfer tokens" embedded in the webseed and tracker
 *    URLs handed out by /api/torrent. WebTorrent's fetch/WebSocket calls
 *    can't carry cookies reliably (cross-origin, or Node-internal seeder),
 *    so the URLs themselves must prove authorization. Raw-file tokens are
 *    bound to one path; tracker tokens only open the signaling channel.
 */
export interface AuthService {
  enabled: boolean
  /** Resolve the requesting user from a session cookie or Bearer token. */
  authenticate (req: IncomingMessage): User | null
  login (username: string, password: string): { user: User, sessionId: string } | null
  logout (sessionId: string): void
  mintRawToken (relPath: string): string
  verifyRawToken (relPath: string, token: string): boolean
  mintTrackerToken (ttlMs?: number): string
  verifyTrackerToken (token: string): boolean
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

const disabledAuth: AuthService = {
  enabled: false,
  authenticate: () => null,
  login: () => null,
  logout: () => {},
  mintRawToken: () => '',
  verifyRawToken: () => true,
  mintTrackerToken: () => '',
  verifyTrackerToken: () => true
}

export function createAuthService (db: AuthDb | null): AuthService {
  if (!db) return disabledAuth
  const secret = db.transferSecret()

  return {
    enabled: true,

    authenticate (req) {
      const authz = req.headers.authorization
      if (authz?.startsWith('Bearer ')) {
        return db.getTokenUser(authz.slice('Bearer '.length).trim())
      }
      const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      if (sessionId) return db.getSessionUser(sessionId, SESSION_TTL_MS)
      return null
    },

    login (username, password) {
      const user = db.verifyCredentials(username, password)
      if (!user) return null
      return { user, sessionId: db.createSession(user.id, SESSION_TTL_MS) }
    },

    logout (sessionId) {
      db.deleteSession(sessionId)
    },

    mintRawToken: relPath =>
      mintSignedToken(secret, `raw:${relPath}`, TRANSFER_TOKEN_TTL_MS),
    verifyRawToken: (relPath, token) =>
      verifySignedToken(secret, `raw:${relPath}`, token),
    mintTrackerToken: (ttlMs = TRANSFER_TOKEN_TTL_MS) =>
      mintSignedToken(secret, 'tracker', ttlMs),
    verifyTrackerToken: token =>
      verifySignedToken(secret, 'tracker', token)
  }
}

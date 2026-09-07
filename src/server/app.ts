import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import {
  BrowseError, createFolder, deleteEntry, listDir, moveEntry, resolveInsideRoot, resolveUploadTarget,
  throwIfPermissionError
} from './browse.ts'
import { clampSearchLimit, searchTree, type SearchHit } from './search.ts'
import { renderTorrent, type TorrentStore } from './torrents.ts'
import {
  SESSION_COOKIE, REFRESH_COOKIE, REFRESH_PATH, ACCESS_TTL_MS, REFRESH_TTL_MS,
  parseCookies, type AuthService, type Session
} from './auth.ts'
import { createDebouncer, type ActivityLog } from './activity.ts'
import { createFixedWindowLimiter, createTokenBucketLimiter } from './rateLimit.ts'
import { resolveDirectory, type Config } from './config.ts'
import type { Seeder } from './seeder.ts'
import type { AuthDb, Mount, Role, User } from './db.ts'
import type { CipherKeys } from './cipherKeys.ts'
import { KeyExchangeError, type KeyExchange } from './keyExchange.ts'
import type { Logger } from './log.ts'

export interface AppDeps {
  config: Config
  store: TorrentStore
  seeder: Seeder
  auth: AuthService
  activity: ActivityLog
  db: AuthDb
  cipherKeys: CipherKeys
  keyExchange: KeyExchange
  version: string
  log: Logger
  /** One-time first-run setup token (F1a); null once an admin account exists. */
  setupToken: string | null
}

/**
 * Parse a single-range HTTP `Range: bytes=…` header against a known size.
 * Returns null when there's no range (serve the whole thing), 'unsatisfiable'
 * for a syntactically fine but out-of-bounds range (→ 416), and a clamped
 * inclusive {start,end} otherwise. Only single ranges are supported — that's
 * all WebTorrent's webseed client and browsers' media fetches ever ask for.
 */
export function parseSingleRange (header: string | undefined, size: number): null | 'unsatisfiable' | { start: number, end: number } {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null // ignore multi-range / malformed: fall back to full body
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    // suffix range: last N bytes
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url))
const webtorrentBundle = fileURLToPath(
  new URL('../../node_modules/webtorrent/dist/webtorrent.min.js', import.meta.url)
)
// WebTorrent's own service worker: streams a torrent's file data straight to
// the browser's native download mechanism (Content-Disposition: attachment)
// without ever materializing the whole file as an in-memory Blob — the fix
// for large-file OOM and Safari's Blob size limits. Served at the root path
// (not under /vendor/) so its default scope covers the whole origin, which
// is what the /webtorrent/<infoHash>/<file> stream URLs need. Requires a
// secure context (HTTPS or localhost) — see README.
const webtorrentSw = fileURLToPath(
  new URL('../../node_modules/webtorrent/dist/sw.min.js', import.meta.url)
)

/** Strip the port from a Host header value, keeping IPv6 brackets. */
export function hostWithoutPort (hostHeader: string): string {
  const bracketed = hostHeader.match(/^(\[[^\]]+\])(?::\d+)?$/)
  if (bracketed) return bracketed[1]!
  return hostHeader.replace(/:\d+$/, '')
}

/** Wrap a bare IPv6 address in brackets for use inside a URL. */
export function bracketHost (host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

type AsyncHandler = (req: Request, res: Response) => Promise<void>

const wrap = (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }

/** The authenticated user set by the auth gate below — every route past it can rely on this being present. */
const authedUser = (res: Response): User => (res.locals as { user: User }).user

/**
 * Resolves a `mount` request parameter (an id, a name, or absent) to a Mount
 * row. Accepts either query (`?mount=`) or JSON body (`{ mount }`) —
 * different routes carry it differently (GETs vs. JSON POSTs vs. the
 * query-only upload/raw endpoints). Absent means "the default mount", so
 * every pre-multi-mount client and script keeps working unchanged.
 */
function mountParamFromReq (req: Request): string | undefined {
  if (typeof req.query.mount === 'string') return req.query.mount
  const body = req.body as { mount?: unknown } | undefined
  if (typeof body?.mount === 'string') return body.mount
  return undefined
}

function findMount (db: AuthDb, mountParam: string | undefined): Mount {
  if (mountParam === undefined || mountParam === '') {
    const mount = db.getDefaultMount()
    if (!mount) throw new BrowseError(500, 'no default mount configured')
    return mount
  }
  const mount = (/^\d+$/.test(mountParam) ? db.getMountById(Number(mountParam)) : null) ?? db.getMountByName(mountParam)
  if (!mount) throw new BrowseError(404, 'no such mount')
  return mount
}

/** Resolves the mount a request targets and enforces the requester's access to it. */
function resolveMountForRequest (db: AuthDb, req: Request, res: Response): Mount {
  const user = authedUser(res)
  const mount = findMount(db, mountParamFromReq(req))
  if (!db.hasMountAccess(mount, user.id, user.role === 'admin')) {
    throw new BrowseError(403, 'no access to this mount')
  }
  return mount
}

export function createApp ({ config, store, seeder, auth, activity, db, cipherKeys, keyExchange, version, log, setupToken }: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  // F12: honor X-Forwarded-* only when explicitly told there's a trusted proxy.
  if (config.trustProxy) app.set('trust proxy', true)
  const webseedLogOnce = createDebouncer(30_000)
  // F1a setup token is single-use in spirit: null it once setup completes so a
  // logged token from first boot can't be replayed after an admin exists.
  let pendingSetupToken = setupToken

  // F1: throttle online password guessing per client IP.
  const loginLimiter = createFixedWindowLimiter(10, 5 * 60 * 1000)
  // F2: smooth bursts against the expensive hash+encrypt / disk-write endpoints.
  const heavyLimiter = createTokenBucketLimiter(30, 60 * 1000)

  const wrapOrBadRequest = (clientKey: string, plaintext: Buffer): string => {
    try {
      return keyExchange.wrap(clientKey, plaintext)
    } catch (err) {
      if (err instanceof KeyExchangeError) throw new BrowseError(400, err.message)
      throw err
    }
  }
  const unwrapOrBadRequest = (clientKey: string, wrapped: string): Buffer => {
    try {
      return keyExchange.unwrap(clientKey, wrapped)
    } catch (err) {
      if (err instanceof KeyExchangeError) throw new BrowseError(400, err.message)
      throw err
    }
  }

  // F6: decide the Secure flag. 'on'/'off' force it; 'auto' derives it from the
  // effective external scheme — https public origin, or (with trust proxy on) a
  // request that arrived over https per X-Forwarded-Proto.
  const cookieSecure = (req: Request): boolean => {
    if (config.secureCookies === 'on') return true
    if (config.secureCookies === 'off') return false
    if (config.publicUrl?.startsWith('https:')) return true
    return req.protocol === 'https'
  }
  const buildCookie = (name: string, value: string, maxAgeSec: number, cookiePath: string, secure: boolean): string => {
    const attrs = [`${name}=${value}`, 'HttpOnly', `Path=${cookiePath}`, 'SameSite=Lax', `Max-Age=${maxAgeSec}`]
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }
  // F9: an access cookie (short) plus a refresh cookie scoped to /api/refresh.
  const setSessionCookies = (req: Request, res: Response, session: Session): void => {
    const secure = cookieSecure(req)
    res.append('Set-Cookie', buildCookie(SESSION_COOKIE, session.accessId, ACCESS_TTL_MS / 1000, '/', secure))
    res.append('Set-Cookie', buildCookie(REFRESH_COOKIE, session.refreshId, REFRESH_TTL_MS / 1000, REFRESH_PATH, secure))
  }
  const clearSessionCookies = (req: Request, res: Response): void => {
    const secure = cookieSecure(req)
    res.append('Set-Cookie', buildCookie(SESSION_COOKIE, '', 0, '/', secure))
    res.append('Set-Cookie', buildCookie(REFRESH_COOKIE, '', 0, REFRESH_PATH, secure))
  }

  // The client page is normally served by this same process, but CORS is kept
  // open so a separately hosted static client works too (FR-C5). Cross-origin
  // clients authenticate with Bearer tokens (cookies are SameSite=Lax).
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
    // Reflect back whatever headers the preflight actually asked for, rather
    // than a fixed list — WebTorrent's own webseed HTTP client (used by
    // cross-origin native clients; same-origin browser clients never hit
    // preflight at all) adds headers like Cache-Control that a static list
    // would need to be kept in lockstep with by hand.
    const requestedHeaders = req.headers['access-control-request-headers']
    res.set('Access-Control-Allow-Headers', requestedHeaders ?? 'Range, Authorization, Content-Type')
    res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })
  // Scoped per-route (not mounted globally on /api): a global json() would
  // greedily parse — and drain the raw body of — any request whose
  // Content-Type happens to be application/json, including /api/upload
  // requests for a .json file (browsers set that Content-Type from the
  // file's extension), silently turning the upload into an empty file.
  const jsonBody = express.json()

  // --- public endpoints ------------------------------------------------------

  app.get('/api/info', (req, res) => {
    res.json({
      name: 'peer-to-file',
      version,
      webrtcSeeding: seeder.enabled,
      // Public by design — an ECDH public key, not a secret. Clients use it
      // to wrap/unwrap transfer-encryption keys (see keyExchange.ts) so the
      // key never crosses the wire in the clear.
      ecdhPublicKey: keyExchange.publicKeyBase64,
      auth: {
        required: true,
        needsSetup: auth.needsSetup(),
        authenticated: auth.authenticate(req) !== null
      }
    })
  })

  // First-run setup: creates the one and only admin account. Only reachable
  // until that account exists — afterwards it 409s, so there is no standing
  // "create a user" endpoint an attacker could hit. F1a: while open, it also
  // requires the one-time setup token logged at first boot.
  app.post('/api/setup', jsonBody, wrap(async (req, res) => {
    if (!auth.needsSetup()) throw new BrowseError(409, 'setup already completed')
    const { username, password, setupToken: providedToken } = (req.body ?? {}) as {
      username?: unknown, password?: unknown, setupToken?: unknown
    }
    const headerToken = req.get('X-P2F-Setup-Token')
    const token = typeof providedToken === 'string' ? providedToken : headerToken
    if (pendingSetupToken && (typeof token !== 'string' ||
        token.length !== pendingSetupToken.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(pendingSetupToken)))) {
      activity.add('auth', 'setup rejected: bad or missing setup token', { ip: req.ip })
      throw new BrowseError(403, 'invalid or missing setup token')
    }
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new BrowseError(400, 'username and password are required')
    }
    let result
    try {
      result = auth.setup(username, password)
    } catch (err) {
      throw new BrowseError(400, err instanceof Error ? err.message : 'setup failed')
    }
    pendingSetupToken = null // consumed — no replay after the admin exists
    activity.add('auth', `admin account "${result.user.username}" created`, { ip: req.ip })
    setSessionCookies(req, res, result)
    res.json({ username: result.user.username })
  }))

  app.post('/api/login', jsonBody, wrap(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown, password?: unknown }
    // F1: per-IP lockout on repeated failures.
    const ipKey = req.ip ?? 'unknown'
    if (loginLimiter.isLimited(ipKey)) {
      res.set('Retry-After', String(Math.ceil(loginLimiter.retryAfterMs(ipKey) / 1000)))
      throw new BrowseError(429, 'too many login attempts — try again later')
    }
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new BrowseError(400, 'username and password are required')
    }
    const result = auth.login(username, password)
    if (!result) {
      loginLimiter.hit(ipKey)
      activity.add('auth', `failed login for "${username}"`, { ip: req.ip })
      // Single structured line for log-based intrusion tooling (e.g. fail2ban).
      log.warn(`auth-fail ip=${req.ip ?? 'unknown'} user="${String(username).replace(/["\r\n]/g, '')}"`)
      // blunt the brute-force edge a little
      await new Promise(resolve => setTimeout(resolve, 300))
      throw new BrowseError(401, 'invalid credentials')
    }
    loginLimiter.reset(ipKey)
    activity.add('auth', `"${result.user.username}" signed in`, { ip: req.ip })
    setSessionCookies(req, res, result)
    res.json({ username: result.user.username })
  }))

  // F9: rotate the refresh cookie into a fresh access+refresh pair. Pre-auth
  // (the access session may already be expired); the refresh cookie is scoped
  // to this path and SameSite=Lax, so a cross-site page can't drive it.
  app.post('/api/refresh', wrap(async (req, res) => {
    const refreshId = parseCookies(req.headers.cookie)[REFRESH_COOKIE]
    const result = refreshId ? auth.refresh(refreshId) : null
    if (!result) {
      clearSessionCookies(req, res)
      throw new BrowseError(401, 'refresh failed')
    }
    setSessionCookies(req, res, result)
    res.json({ username: result.user.username })
  }))

  // Webseed endpoint: WebTorrent fetches it without cookies/headers, so it
  // accepts the path-bound transfer token minted by /api/torrent (a normal
  // authenticated call works too). Declared before the auth gate.
  app.get('/api/raw', wrap(async (req, res) => {
    const relQuery = typeof req.query.path === 'string' ? req.query.path : ''
    const token = typeof req.query.t === 'string' ? req.query.t : ''
    const mount = findMount(db, mountParamFromReq(req))
    if (!auth.verifyRawToken(mount.id, relQuery, token)) {
      // No valid mount-bound token — fall back to a normal authenticated
      // session/bearer token, but that alone only proves *who*, not access
      // to *this* mount, so check it explicitly.
      const authResult = auth.authenticate(req)
      if (!authResult) throw new BrowseError(401, 'authentication required')
      if (!db.hasMountAccess(mount, authResult.user.id, authResult.user.role === 'admin')) {
        throw new BrowseError(403, 'no access to this mount')
      }
    }
    const abs = await resolveInsideRoot(mount.path, relQuery)
    const st = await fs.stat(abs)
    if (!st.isFile()) throw new BrowseError(400, 'not a file')
    if (webseedLogOnce(`${req.ip}:${relQuery}`)) {
      activity.add('webseed', `serving "${relQuery}" to ${req.ip}`, { path: relQuery, ip: req.ip })
    }
    // Serve ciphertext, not the plaintext file — the same encrypted bytes the
    // torrent's piece hashes were computed against — but encrypt the requested
    // byte range on the fly (cipherKeys) rather than from a cached copy, so
    // nothing but a small rolling buffer is ever held. CTR is length-preserving,
    // so the ciphertext size equals the plaintext size and Range math is exact.
    const { key, iv, size } = await cipherKeys.getKeys(abs)
    const range = parseSingleRange(req.headers.range, size)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${size}`)
      res.status(416).end()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : Math.max(0, size - 1)
    const length = size === 0 ? 0 : end - start + 1
    if (range) {
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    res.setHeader('Content-Length', String(length))
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }
    const stream = cipherKeys.encryptedRange(abs, key, iv, start, end)
    try {
      await pipeline(stream, res)
    } catch (err) {
      // Client hang-ups (aborted download, seek) surface as premature-close /
      // EPIPE — expected for a webseed, not an error worth logging.
      stream.destroy()
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'EPIPE' && !res.writableEnded) throw err
    }
  }))

  // --- everything below requires a session cookie or Bearer token -------------

  app.use('/api', (req, res, next) => {
    const result = auth.authenticate(req)
    if (!result) {
      res.status(401).json({ error: 'authentication required' })
      return
    }
    const locals = res.locals as { user?: unknown, viaCookie?: boolean }
    locals.user = result.user
    locals.viaCookie = result.viaCookie
    next()
  })

  // F5: CSRF defence-in-depth. A cross-site page can't set a custom header on a
  // credentialed request (that requires a preflight the wildcard CORS won't pass
  // for cookies) nor on a simple form POST, so requiring one on cookie-
  // authenticated state-changing requests blocks CSRF without narrowing CORS
  // (which the WebTorrent webseed at /api/raw depends on). Bearer-token clients
  // don't ride ambient cookies, so they're exempt.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
    const viaCookie = (res.locals as { viaCookie?: boolean }).viaCookie
    if (viaCookie && req.get('X-P2F-Csrf') == null) {
      res.status(403).json({ error: 'missing CSRF header' })
      return
    }
    next()
  })

  // Gate for the /api/admin/* routes below: the CSRF/auth middleware above
  // has already run, so res.locals.user is set — just check its role.
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (authedUser(res).role !== 'admin') {
      res.status(403).json({ error: 'admin role required' })
      return
    }
    next()
  }

  app.post('/api/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie)
    auth.logout(cookies[SESSION_COOKIE] ?? '', cookies[REFRESH_COOKIE] ?? '')
    const user = (res.locals as { user?: { username: string } }).user
    if (user) activity.add('auth', `"${user.username}" signed out`, { ip: req.ip })
    clearSessionCookies(req, res)
    res.json({ ok: true })
  })

  // F9: revoke every session + refresh token for the signed-in user.
  app.post('/api/logout-all', (req, res) => {
    const user = (res.locals as { user?: { id: number, username: string } }).user
    if (user) {
      auth.logoutAll(user.id)
      activity.add('auth', `"${user.username}" revoked all sessions`, { ip: req.ip })
    }
    clearSessionCookies(req, res)
    res.json({ ok: true })
  })

  app.get('/api/me', (req, res) => {
    const user = (res.locals as { user?: User }).user
    res.json({ username: user?.username ?? null, role: user?.role ?? null })
  })

  app.get('/api/logs', (req, res) => {
    const limit = Number(req.query.limit)
    const sinceId = req.query.sinceId !== undefined ? Number(req.query.sinceId) : undefined
    res.json({
      entries: activity.list({
        limit: Number.isFinite(limit) ? limit : undefined,
        sinceId
      })
    })
  })

  // Download history: a record of files this browser has actually finished
  // saving (posted by the client itself once a save completes — there's no
  // reliable server-side "this peer finished" signal, since transfers can
  // come entirely over WebRTC with no webseed hit at all). Scoped to the
  // signed-in user (auth is always on, so there is always a user id).
  const historyUserId = (res: Response): number =>
    (res.locals as { user: { id: number } }).user.id

  app.get('/api/downloads/history', (req, res) => {
    res.json({ entries: db.listDownloadHistory(historyUserId(res)) })
  })

  app.post('/api/downloads/history', jsonBody, (req, res) => {
    const { path: relPath, name, length, infoHash, durationMs } = (req.body ?? {}) as {
      path?: unknown, name?: unknown, length?: unknown, infoHash?: unknown, durationMs?: unknown
    }
    if (typeof relPath !== 'string' || typeof name !== 'string' || typeof length !== 'number') {
      throw new BrowseError(400, 'path, name and length are required')
    }
    db.recordDownload(
      historyUserId(res), relPath, name, length,
      typeof infoHash === 'string' ? infoHash : null,
      typeof durationMs === 'number' ? durationMs : null
    )
    res.status(201).json({ ok: true })
  })

  app.post('/api/downloads/history/clear', (req, res) => {
    db.clearDownloadHistory(historyUserId(res))
    res.json({ ok: true })
  })

  app.get('/api/uploads/history', (req, res) => {
    res.json({ entries: db.listUploadHistory(historyUserId(res)) })
  })

  app.post('/api/uploads/history', jsonBody, (req, res) => {
    const { path: relPath, name, length, durationMs } = (req.body ?? {}) as {
      path?: unknown, name?: unknown, length?: unknown, durationMs?: unknown
    }
    if (typeof relPath !== 'string' || typeof name !== 'string' || typeof length !== 'number') {
      throw new BrowseError(400, 'path, name and length are required')
    }
    db.recordUpload(
      historyUserId(res), relPath, name, length,
      typeof durationMs === 'number' ? durationMs : null
    )
    res.status(201).json({ ok: true })
  })

  app.post('/api/uploads/history/clear', (req, res) => {
    db.clearUploadHistory(historyUserId(res))
    res.json({ ok: true })
  })

  // Mounts the caller may browse — the default mount plus any explicitly
  // granted, or every mount for an admin. Listed first so clients can build a
  // mount switcher / know what to pass as `mount` on the routes below.
  app.get('/api/mounts', (req, res) => {
    const user = authedUser(res)
    const isAdmin = user.role === 'admin'
    const mounts = db.listMountsForUser(user.id, isAdmin)
    res.json({
      mounts: mounts.map(m => ({
        id: m.id, name: m.name, isDefault: m.is_default,
        // The path itself is only useful (and only ever needed) for the
        // admin UI that manages mounts — regular browsing only needs id/name.
        ...(isAdmin ? { path: m.path } : {})
      }))
    })
  })

  app.get('/api/list', wrap(async (req, res) => {
    const mount = resolveMountForRequest(db, req, res)
    res.json(await listDir(mount.path, req.query.path ?? ''))
  }))

  app.post('/api/delete', jsonBody, wrap(async (req, res) => {
    const mount = resolveMountForRequest(db, req, res)
    const { path: relPath } = (req.body ?? {}) as { path?: unknown }
    const { rel, wasDir } = await deleteEntry(mount.path, relPath)
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `deleted ${wasDir ? 'folder' : 'file'} "${rel}" on mount "${mount.name}"${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, mount: mount.name, user: requester?.username, ip: req.ip
    })
    res.json({ ok: true })
  }))

  // Moves within the same mount only — `from`/`to` both resolve against it,
  // there's no cross-mount move.
  app.post('/api/move', jsonBody, wrap(async (req, res) => {
    const mount = resolveMountForRequest(db, req, res)
    const { from, to } = (req.body ?? {}) as { from?: unknown, to?: unknown }
    const { fromRel, toRel } = await moveEntry(mount.path, from, to)
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `moved "${fromRel}" to "${toRel}" on mount "${mount.name}"${requester ? ` by ${requester.username}` : ''}`, {
      from: fromRel, to: toRel, mount: mount.name, user: requester?.username, ip: req.ip
    })
    res.json({ ok: true, path: toRel })
  }))

  app.post('/api/mkdir', jsonBody, wrap(async (req, res) => {
    const mount = resolveMountForRequest(db, req, res)
    const { path: relPath } = (req.body ?? {}) as { path?: unknown }
    const { rel } = await createFolder(mount.path, relPath)
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `created folder "${rel}" on mount "${mount.name}"${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, mount: mount.name, user: requester?.username, ip: req.ip
    })
    res.json({ ok: true, path: rel })
  }))

  // Recursive name search across one mount's tree, or every mount the caller
  // can reach when `mount` is omitted. Read-only, so no extra CSRF or write
  // rate-limiting beyond the standard auth gate.
  app.get('/api/search', wrap(async (req, res) => {
    const user = authedUser(res)
    const isAdmin = user.role === 'admin'
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q === '') throw new BrowseError(400, 'q is required')
    if (q.length > 200) throw new BrowseError(400, 'q is too long')
    const typeParam = req.query.type
    const type = typeParam === 'dir' || typeParam === 'file' ? typeParam : undefined
    const scopePath = typeof req.query.path === 'string' ? req.query.path : ''
    const mountParam = mountParamFromReq(req)
    const limit = clampSearchLimit(Number(req.query.limit))

    let mounts: Mount[]
    if (mountParam !== undefined) {
      const mount = findMount(db, mountParam)
      if (!db.hasMountAccess(mount, user.id, isAdmin)) throw new BrowseError(403, 'no access to this mount')
      mounts = [mount]
    } else {
      mounts = db.listMountsForUser(user.id, isAdmin)
    }

    const results: Array<SearchHit & { mount: { id: number, name: string } }> = []
    let truncated = false
    let remaining = limit
    for (const mount of mounts) {
      if (remaining <= 0) { truncated = true; break }
      let scopeAbs: string
      try {
        scopeAbs = await resolveInsideRoot(mount.path, scopePath)
      } catch (err) {
        if (mountParam !== undefined) throw err // an explicitly requested mount's scope error should surface, not be swallowed
        continue // searching every mount: just skip ones without this subpath
      }
      const outcome = await searchTree(mount.path, scopeAbs, { query: q, type, limit: remaining })
      for (const hit of outcome.hits) results.push({ ...hit, mount: { id: mount.id, name: mount.name } })
      remaining -= outcome.hits.length
      if (outcome.truncated) truncated = true
    }

    res.json({ query: q, results, truncated })
  }))

  // --- admin: users + mount access -------------------------------------------

  app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json({
      users: db.listUsers().map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.created_at }))
    })
  })

  app.post('/api/admin/users/:username/role', jsonBody, requireAdmin, wrap(async (req, res) => {
    const username = String(req.params.username)
    const { role } = (req.body ?? {}) as { role?: unknown }
    if (role !== 'user' && role !== 'admin') throw new BrowseError(400, "role must be 'user' or 'admin'")
    const target = db.getUserByUsername(username)
    if (!target) throw new BrowseError(404, 'no such user')
    if (target.role === 'admin' && role === 'user' && db.countAdmins() <= 1) {
      throw new BrowseError(400, 'cannot demote the last remaining admin')
    }
    db.setUserRole(target.id, role)
    const requester = authedUser(res)
    activity.add('admin', `"${username}" role changed to ${role} by ${requester.username}`, {
      targetUser: username, role, user: requester.username, ip: req.ip
    })
    res.json({ ok: true })
  }))

  app.get('/api/admin/mounts', requireAdmin, (req, res) => {
    res.json({
      mounts: db.listMounts().map(m => ({
        id: m.id, name: m.name, path: m.path, isDefault: m.is_default, createdAt: m.created_at,
        access: db.listMountAccess(m.id)
      }))
    })
  })

  app.post('/api/admin/mounts', jsonBody, requireAdmin, wrap(async (req, res) => {
    const { name, path: pathInput } = (req.body ?? {}) as { name?: unknown, path?: unknown }
    if (typeof name !== 'string' || !/^[a-zA-Z0-9._ -]{1,64}$/.test(name)) {
      throw new BrowseError(400, 'mount name must be 1-64 chars of letters, digits, spaces, . _ -')
    }
    if (typeof pathInput !== 'string' || pathInput.trim() === '') throw new BrowseError(400, 'path is required')
    if (db.getMountByName(name)) throw new BrowseError(409, 'a mount with that name already exists')
    let resolved: string
    try {
      resolved = resolveDirectory(pathInput)
    } catch (err) {
      throw new BrowseError(400, err instanceof Error ? err.message : 'invalid path')
    }
    const requester = authedUser(res)
    const mount: Mount = db.createMount(name, resolved, requester.id)
    activity.add('admin', `mount "${name}" (${resolved}) created by ${requester.username}`, {
      mount: name, path: resolved, user: requester.username, ip: req.ip
    })
    res.status(201).json({ id: mount.id, name: mount.name, path: mount.path, isDefault: mount.is_default })
  }))

  app.post('/api/admin/mounts/:id/access', jsonBody, requireAdmin, wrap(async (req, res) => {
    const mount = db.getMountById(Number(req.params.id))
    if (!mount) throw new BrowseError(404, 'no such mount')
    const { username } = (req.body ?? {}) as { username?: unknown }
    if (typeof username !== 'string') throw new BrowseError(400, 'username is required')
    const target = db.getUserByUsername(username)
    if (!target) throw new BrowseError(404, 'no such user')
    db.grantMountAccess(mount.id, target.id)
    const requester = authedUser(res)
    activity.add('admin', `granted "${username}" access to mount "${mount.name}" by ${requester.username}`, {
      mount: mount.name, targetUser: username, user: requester.username, ip: req.ip
    })
    res.status(201).json({ ok: true })
  }))

  app.delete('/api/admin/mounts/:id/access/:userId', requireAdmin, wrap(async (req, res) => {
    const mount = db.getMountById(Number(req.params.id))
    if (!mount) throw new BrowseError(404, 'no such mount')
    const target = db.getUserById(Number(req.params.userId))
    db.revokeMountAccess(mount.id, Number(req.params.userId))
    const requester = authedUser(res)
    activity.add('admin', `revoked "${target?.username ?? req.params.userId}" access to mount "${mount.name}" by ${requester.username}`, {
      mount: mount.name, targetUser: target?.username, user: requester.username, ip: req.ip
    })
    res.json({ ok: true })
  }))

  app.delete('/api/admin/mounts/:id', requireAdmin, wrap(async (req, res) => {
    const mount = db.getMountById(Number(req.params.id))
    if (!mount) throw new BrowseError(404, 'no such mount')
    if (mount.is_default) throw new BrowseError(400, 'cannot remove the default mount')
    db.deleteMount(mount.id)
    const requester = authedUser(res)
    activity.add('admin', `mount "${mount.name}" removed by ${requester.username}`, {
      mount: mount.name, user: requester.username, ip: req.ip
    })
    res.json({ ok: true })
  }))

  // Streamed to disk (never buffered in memory) via a temp file, then
  // published with fs.link — which fails with EEXIST if the destination
  // already exists — instead of a plain rename, so two uploads racing for
  // the same name can't silently overwrite one another (fs.rename would
  // just replace the destination). NOT behind the jsonBody parser above:
  // this route's body is the raw file, and a browser sets the upload's
  // Content-Type from the file's own type (e.g. application/json for a
  // .json file), which express.json() would otherwise try to parse.
  //
  // The request body is AES-256-CTR ciphertext, encrypted client-side so the
  // wire never carries plaintext — see packages/shared/src/browserCrypto.ts.
  // The client generates the key/IV itself (uploads are one-shot, no
  // cross-session reuse the way downloads need), but doesn't send it in the
  // clear: it's ECDH-wrapped (keyExchange.ts) under the client's own
  // per-request ephemeral keypair, so an observer of the wire can't recover
  // it just by watching. The plaintext SHA-256 the server verifies against is
  // carried *inside* that wrapped blob (F7: key(32)||iv(16)||sha256(32)), so it
  // too is only readable after decrypting — closing the integrity gap CTR alone
  // leaves without exposing the expected hash to a wire observer.
  app.post('/api/upload', wrap(async (req, res) => {
    if (!heavyLimiter.take(req.ip ?? 'unknown')) {
      throw new BrowseError(429, 'too many requests — slow down')
    }
    const mount = resolveMountForRequest(db, req, res)
    const destDirRel = typeof req.query.path === 'string' ? req.query.path : ''
    const name = typeof req.query.name === 'string' ? req.query.name : ''
    const destAbs = await resolveUploadTarget(mount.path, destDirRel, name)

    const clientKey = req.get('X-P2F-Enc-Client-Pubkey')
    const wrappedKey = req.get('X-P2F-Enc-Key-Wrapped')
    if (!clientKey || !wrappedKey) {
      throw new BrowseError(400, 'missing encryption headers')
    }
    const keyMaterial = unwrapOrBadRequest(clientKey, wrappedKey)
    if (keyMaterial.length !== 80) {
      throw new BrowseError(400, 'invalid encryption headers')
    }
    const encKey = keyMaterial.subarray(0, 32)
    const encIv = keyMaterial.subarray(32, 48)
    const expectedSha = keyMaterial.subarray(48, 80).toString('hex')

    const tmpAbs = `${destAbs}.p2f-upload-${crypto.randomUUID()}`
    const out = fsSync.createWriteStream(tmpAbs, { flags: 'wx' })
    const decipher = crypto.createDecipheriv('aes-256-ctr', encKey, encIv)
    const plainHash = crypto.createHash('sha256')
    decipher.on('data', chunk => plainHash.update(chunk))
    try {
      await new Promise<void>((resolve, reject) => {
        req.on('aborted', () => reject(new Error('upload aborted')))
        req.on('error', reject)
        decipher.on('error', reject)
        out.on('error', reject)
        out.on('finish', resolve)
        req.pipe(decipher).pipe(out)
      })
      if (plainHash.digest('hex') !== expectedSha) {
        throw new BrowseError(400, 'upload failed integrity check')
      }
      try {
        await fs.link(tmpAbs, destAbs)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new BrowseError(409, 'a file with that name already exists')
        }
        throwIfPermissionError(err)
      }
    } catch (err) {
      out.destroy()
      await fs.rm(tmpAbs, { force: true })
      throw err
    }
    await fs.rm(tmpAbs, { force: true })

    const rel = path.relative(mount.path, destAbs)
    const size = out.bytesWritten
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `uploaded "${rel}" (${size} bytes) to mount "${mount.name}"${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, size, mount: mount.name, user: requester?.username, ip: req.ip
    })
    res.status(201).json({ name, path: rel, size })
  }))

  // Torrent metadata for one file: full .torrent (base64) + magnet URI.
  // Announce points at the embedded tracker, urlList at /api/raw as an HTTP
  // webseed fallback. Requesting metadata also starts the WebRTC seeder.
  app.get('/api/torrent', wrap(async (req, res) => {
    if (!heavyLimiter.take(req.ip ?? 'unknown')) {
      throw new BrowseError(429, 'too many requests — slow down')
    }
    // The client's ephemeral ECDH public key for this request — required so
    // the transfer key below can be wrapped under a key an eavesdropper
    // can't derive just by watching the wire (see keyExchange.ts).
    const clientKey = typeof req.query.ck === 'string' ? req.query.ck : ''
    if (!clientKey) throw new BrowseError(400, 'missing ck (client ECDH public key)')

    const mount = resolveMountForRequest(db, req, res)
    const abs = await resolveInsideRoot(mount.path, req.query.path ?? '')
    const { meta, plainSha256 } = await store.getMeta(abs)
    const rel = path.relative(mount.path, abs)

    // The webseed carries a path-bound transfer token and the announce an
    // infohash-bound tracker token (F3) — WebTorrent's own requests can't
    // present cookies or headers, so authorization lives in the URLs
    // themselves. The webseed URL also carries the mount id so /api/raw
    // resolves the same root this path was minted against.
    const rawQuery = (p: string): string =>
      `path=${encodeURIComponent(p)}&mount=${mount.id}&t=${encodeURIComponent(auth.mintRawToken(mount.id, p))}`
    const trackerQuery =
      `?ih=${meta.infoHash}&t=${encodeURIComponent(auth.mintTrackerToken(meta.infoHash))}`

    let announce: string[]
    let webseed: string
    if (config.publicUrl) {
      // Reverse-proxy mode: everything goes through the public origin, with
      // the tracker WebSocket on the same port at /tracker (wss when https).
      announce = [`${config.publicUrl.replace(/^http/, 'ws')}/tracker${trackerQuery}`]
      webseed = `${config.publicUrl}/api/raw?${rawQuery(rel)}`
    } else {
      const hostHeader = req.headers.host ?? `${bracketHost(config.host)}:${config.port}`
      const host = config.publicHost ? bracketHost(config.publicHost) : hostWithoutPort(hostHeader)
      const httpHostPort = config.publicHost ? `${host}:${config.port}` : hostHeader

      // The tracker is only reachable through the token-gated /tracker path on
      // the main HTTP port.
      announce = [`ws://${httpHostPort}/tracker${trackerQuery}`]
      webseed = `http://${httpHostPort}/api/raw?${rawQuery(rel)}`
    }

    const { key, iv } = await cipherKeys.getKeys(abs)
    seeder.ensureSeeding(abs, meta, key, iv)

    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('torrent', `metadata requested for "${rel}" on mount "${mount.name}"${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, mount: mount.name, infoHash: meta.infoHash, user: requester?.username, ip: req.ip
    })

    const { torrentFile, magnet } = renderTorrent(meta, { announce, urlList: [webseed] })
    res.json({
      name: meta.name,
      length: meta.length,
      infoHash: meta.infoHash,
      pieceLength: meta.pieceLength,
      announce,
      webseed,
      magnet,
      torrentBase64: Buffer.from(torrentFile).toString('base64'),
      // AES-256-CTR key+IV for the ciphertext this torrent/webseed actually
      // carries, ECDH-wrapped for `clientKey` (keyExchange.ts) — the client
      // unwraps this, then decrypts transparently after WebTorrent's own
      // piece verification passes (see packages/shared/src/browserCrypto.ts).
      encKeyWrapped: wrapOrBadRequest(clientKey, Buffer.concat([key, iv])),
      plainSha256
    })
  }))

  // Static web client + the WebTorrent browser bundle.
  app.use(express.static(clientDist))
  app.get('/vendor/webtorrent.min.js', (req, res) => {
    res.sendFile(webtorrentBundle)
  })
  app.get('/sw.js', (req, res) => {
    res.set('Service-Worker-Allowed', '/')
    res.sendFile(webtorrentSw)
  })

  // WebTorrent's own service worker intercepts requests under
  // /webtorrent/keepalive/ and /webtorrent/cancel/ as part of its streamed-
  // save protocol (feature-detection probes and stream-cancellation
  // signaling — see webtorrent's lib/server.js/sw.js) and normally never
  // lets them reach here. But the very first time a page loads, there's a
  // window before the service worker is actually controlling it (see
  // DownloadManager.registerServiceWorker's wait for 'controllerchange')
  // during which these same requests can fall through to a real network
  // fetch — unauthenticated by design (no session exists to attach yet) and
  // carrying no user data. Answering them the same way the service worker
  // would keeps that harmless race from surfacing as a 404.
  // `{*splat}` is express 5's spelling of express 4's bare trailing `*`: the
  // braces keep the tail optional, so a bare `/webtorrent/keepalive/` (which
  // is exactly what the feature-detection probe requests) still matches.
  app.get('/webtorrent/keepalive/{*splat}', (req, res) => {
    res.status(200).end()
  })
  app.get('/webtorrent/cancel/{*splat}', (req, res) => {
    res.status(200).end()
  })

  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    if (err instanceof BrowseError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'internal error' })
  })

  return app
}

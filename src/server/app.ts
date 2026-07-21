import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import {
  BrowseError, createFolder, deleteEntry, listDir, moveEntry, resolveInsideRoot, resolveUploadTarget,
  throwIfPermissionError
} from './browse.ts'
import { renderTorrent, type TorrentStore } from './torrents.ts'
import {
  SESSION_COOKIE, REFRESH_COOKIE, REFRESH_PATH, ACCESS_TTL_MS, REFRESH_TTL_MS,
  parseCookies, type AuthService, type Session
} from './auth.ts'
import { createDebouncer, type ActivityLog } from './activity.ts'
import { createFixedWindowLimiter, createTokenBucketLimiter } from './rateLimit.ts'
import type { Config } from './config.ts'
import type { Seeder } from './seeder.ts'
import type { AuthDb } from './db.ts'
import type { CipherCache } from './cipherCache.ts'
import { KeyExchangeError, type KeyExchange } from './keyExchange.ts'
import type { Logger } from './log.ts'

export interface AppDeps {
  config: Config
  store: TorrentStore
  seeder: Seeder
  auth: AuthService
  activity: ActivityLog
  db: AuthDb
  cipherCache: CipherCache
  keyExchange: KeyExchange
  version: string
  log: Logger
  /** One-time first-run setup token (F1a); null once an admin account exists. */
  setupToken: string | null
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

export function createApp ({ config, store, seeder, auth, activity, db, cipherCache, keyExchange, version, log, setupToken }: AppDeps): Express {
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
    if (!auth.verifyRawToken(relQuery, token) && auth.authenticate(req) === null) {
      throw new BrowseError(401, 'authentication required')
    }
    const abs = await resolveInsideRoot(config.root, relQuery)
    const st = await fs.stat(abs)
    if (!st.isFile()) throw new BrowseError(400, 'not a file')
    if (webseedLogOnce(`${req.ip}:${relQuery}`)) {
      activity.add('webseed', `serving "${relQuery}" to ${req.ip}`, { path: relQuery, ip: req.ip })
    }
    // Serve the ciphertext cache entry, not the plaintext file — this is the
    // encrypted-at-rest-and-in-transit copy the torrent's piece hashes were
    // computed against (see cipherCache.ts / torrents.ts).
    const { cachePath } = await cipherCache.getEntry(abs)
    await new Promise<void>((resolve, reject) => {
      res.sendFile(cachePath, {
        dotfiles: 'allow',
        cacheControl: false,
        headers: { 'Cache-Control': 'no-store' }
      }, err => err ? reject(err) : resolve())
    })
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
    const user = (res.locals as { user?: { username: string } }).user
    res.json({ username: user?.username ?? null })
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

  app.get('/api/list', wrap(async (req, res) => {
    res.json(await listDir(config.root, req.query.path ?? ''))
  }))

  app.post('/api/delete', jsonBody, wrap(async (req, res) => {
    const { path: relPath } = (req.body ?? {}) as { path?: unknown }
    const { rel, wasDir } = await deleteEntry(config.root, relPath)
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `deleted ${wasDir ? 'folder' : 'file'} "${rel}"${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, user: requester?.username, ip: req.ip
    })
    res.json({ ok: true })
  }))

  app.post('/api/move', jsonBody, wrap(async (req, res) => {
    const { from, to } = (req.body ?? {}) as { from?: unknown, to?: unknown }
    const { fromRel, toRel } = await moveEntry(config.root, from, to)
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `moved "${fromRel}" to "${toRel}"${requester ? ` by ${requester.username}` : ''}`, {
      from: fromRel, to: toRel, user: requester?.username, ip: req.ip
    })
    res.json({ ok: true, path: toRel })
  }))

  app.post('/api/mkdir', jsonBody, wrap(async (req, res) => {
    const { path: relPath } = (req.body ?? {}) as { path?: unknown }
    const { rel } = await createFolder(config.root, relPath)
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `created folder "${rel}"${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, user: requester?.username, ip: req.ip
    })
    res.json({ ok: true, path: rel })
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
    const destDirRel = typeof req.query.path === 'string' ? req.query.path : ''
    const name = typeof req.query.name === 'string' ? req.query.name : ''
    const destAbs = await resolveUploadTarget(config.root, destDirRel, name)

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

    const rel = path.relative(config.root, destAbs)
    const size = out.bytesWritten
    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('browse', `uploaded "${rel}" (${size} bytes)${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, size, user: requester?.username, ip: req.ip
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

    const abs = await resolveInsideRoot(config.root, req.query.path ?? '')
    const meta = await store.getMeta(abs)
    const rel = path.relative(config.root, abs)

    // The webseed carries a path-bound transfer token and the announce an
    // infohash-bound tracker token (F3) — WebTorrent's own requests can't
    // present cookies or headers, so authorization lives in the URLs
    // themselves.
    const rawQuery = (p: string): string =>
      `path=${encodeURIComponent(p)}&t=${encodeURIComponent(auth.mintRawToken(p))}`
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

    const cipherEntry = await cipherCache.getEntry(abs)
    seeder.ensureSeeding(cipherEntry.cachePath, meta)

    const requester = (res.locals as { user?: { username: string } }).user
    activity.add('torrent', `metadata requested for "${rel}"${requester ? ` by ${requester.username}` : ''}`, {
      path: rel, infoHash: meta.infoHash, user: requester?.username, ip: req.ip
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
      encKeyWrapped: wrapOrBadRequest(clientKey, Buffer.concat([cipherEntry.key, cipherEntry.iv])),
      plainSha256: cipherEntry.plainSha256
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
  app.get('/webtorrent/keepalive/*', (req, res) => {
    res.status(200).end()
  })
  app.get('/webtorrent/cancel/*', (req, res) => {
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

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import { BrowseError, listDir, resolveInsideRoot } from './browse.ts'
import { renderTorrent, type TorrentStore } from './torrents.ts'
import { SESSION_COOKIE, SESSION_TTL_MS, parseCookies, type AuthService } from './auth.ts'
import type { Config } from './config.ts'
import type { Seeder } from './seeder.ts'

export interface AppDeps {
  config: Config
  store: TorrentStore
  seeder: Seeder
  auth: AuthService
  version: string
}

const publicDir = fileURLToPath(new URL('../../public', import.meta.url))
const webtorrentBundle = fileURLToPath(
  new URL('../../node_modules/webtorrent/dist/webtorrent.min.js', import.meta.url)
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

export function createApp ({ config, store, seeder, auth, version }: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')

  const secureCookies = config.publicUrl?.startsWith('https:') ?? false
  const sessionCookie = (value: string, maxAgeSec: number): string => {
    const attrs = [
      `${SESSION_COOKIE}=${value}`, 'HttpOnly', 'Path=/', 'SameSite=Lax',
      `Max-Age=${maxAgeSec}`
    ]
    if (secureCookies) attrs.push('Secure')
    return attrs.join('; ')
  }

  // The client page is normally served by this same process, but CORS is kept
  // open so a separately hosted static client works too (FR-C5). Cross-origin
  // clients authenticate with Bearer tokens (cookies are SameSite=Lax).
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Range, Authorization, Content-Type')
    res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })
  app.use('/api', express.json())

  // --- public endpoints ------------------------------------------------------

  app.get('/api/info', (req, res) => {
    res.json({
      name: 'peer-to-file',
      version,
      webrtcSeeding: seeder.enabled,
      auth: {
        required: auth.enabled,
        needsSetup: auth.enabled && auth.needsSetup(),
        authenticated: auth.enabled ? auth.authenticate(req) !== null : true
      }
    })
  })

  // First-run setup: creates the one and only admin account. Only reachable
  // until that account exists — afterwards it behaves like a disabled route,
  // so there is no standing "create a user" endpoint an attacker could hit.
  app.post('/api/setup', wrap(async (req, res) => {
    if (!auth.enabled) throw new BrowseError(400, 'authentication is disabled')
    if (!auth.needsSetup()) throw new BrowseError(409, 'setup already completed')
    const { username, password } = (req.body ?? {}) as { username?: unknown, password?: unknown }
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new BrowseError(400, 'username and password are required')
    }
    let result
    try {
      result = auth.setup(username, password)
    } catch (err) {
      throw new BrowseError(400, err instanceof Error ? err.message : 'setup failed')
    }
    res.append('Set-Cookie', sessionCookie(result.sessionId, SESSION_TTL_MS / 1000))
    res.json({ username: result.user.username })
  }))

  app.post('/api/login', wrap(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown, password?: unknown }
    if (!auth.enabled) throw new BrowseError(400, 'authentication is disabled')
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new BrowseError(400, 'username and password are required')
    }
    const result = auth.login(username, password)
    if (!result) {
      // blunt the brute-force edge a little
      await new Promise(resolve => setTimeout(resolve, 300))
      throw new BrowseError(401, 'invalid credentials')
    }
    res.append('Set-Cookie', sessionCookie(result.sessionId, SESSION_TTL_MS / 1000))
    res.json({ username: result.user.username })
  }))

  // Webseed endpoint: WebTorrent fetches it without cookies/headers, so it
  // accepts the path-bound transfer token minted by /api/torrent (a normal
  // authenticated call works too). Declared before the auth gate.
  app.get('/api/raw', wrap(async (req, res) => {
    const relQuery = typeof req.query.path === 'string' ? req.query.path : ''
    const token = typeof req.query.t === 'string' ? req.query.t : ''
    if (auth.enabled &&
        !auth.verifyRawToken(relQuery, token) &&
        auth.authenticate(req) === null) {
      throw new BrowseError(401, 'authentication required')
    }
    const abs = await resolveInsideRoot(config.root, relQuery)
    const st = await fs.stat(abs)
    if (!st.isFile()) throw new BrowseError(400, 'not a file')
    await new Promise<void>((resolve, reject) => {
      res.sendFile(abs, {
        dotfiles: 'allow',
        cacheControl: false,
        headers: { 'Cache-Control': 'no-store' }
      }, err => err ? reject(err) : resolve())
    })
  }))

  // --- everything below requires a session cookie or Bearer token -------------

  app.use('/api', (req, res, next) => {
    if (!auth.enabled) return next()
    const user = auth.authenticate(req)
    if (!user) {
      res.status(401).json({ error: 'authentication required' })
      return
    }
    ;(res.locals as { user?: unknown }).user = user
    next()
  })

  app.post('/api/logout', (req, res) => {
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (sessionId) auth.logout(sessionId)
    res.append('Set-Cookie', sessionCookie('', 0))
    res.json({ ok: true })
  })

  app.get('/api/me', (req, res) => {
    const user = (res.locals as { user?: { username: string } }).user
    res.json({ username: auth.enabled ? user?.username ?? null : null })
  })

  app.get('/api/list', wrap(async (req, res) => {
    res.json(await listDir(config.root, req.query.path ?? ''))
  }))

  // Torrent metadata for one file: full .torrent (base64) + magnet URI.
  // Announce points at the embedded tracker, urlList at /api/raw as an HTTP
  // webseed fallback. Requesting metadata also starts the WebRTC seeder.
  app.get('/api/torrent', wrap(async (req, res) => {
    const abs = await resolveInsideRoot(config.root, req.query.path ?? '')
    const meta = await store.getMeta(abs)
    const rel = path.relative(config.root, abs)

    // With auth on, the webseed carries a path-bound transfer token and the
    // announce a tracker token — WebTorrent's own requests can't present
    // cookies or headers, so authorization lives in the URLs themselves.
    const rawQuery = (p: string): string =>
      `path=${encodeURIComponent(p)}` +
      (auth.enabled ? `&t=${encodeURIComponent(auth.mintRawToken(p))}` : '')
    const trackerQuery = auth.enabled
      ? `?t=${encodeURIComponent(auth.mintTrackerToken())}`
      : ''

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

      // The standalone tracker port cannot check tokens, so with auth on the
      // tracker is only reachable through /tracker on the main HTTP port.
      announce = auth.enabled
        ? [`ws://${httpHostPort}/tracker${trackerQuery}`]
        : [`ws://${host}:${config.trackerPort}`]
      webseed = `http://${httpHostPort}/api/raw?${rawQuery(rel)}`
    }

    seeder.ensureSeeding(abs, meta)

    const { torrentFile, magnet } = renderTorrent(meta, { announce, urlList: [webseed] })
    res.json({
      name: meta.name,
      length: meta.length,
      infoHash: meta.infoHash,
      pieceLength: meta.pieceLength,
      announce,
      webseed,
      magnet,
      torrentBase64: Buffer.from(torrentFile).toString('base64')
    })
  }))

  // Static web client + the WebTorrent browser bundle.
  app.use(express.static(publicDir))
  app.get('/vendor/webtorrent.min.js', (req, res) => {
    res.sendFile(webtorrentBundle)
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

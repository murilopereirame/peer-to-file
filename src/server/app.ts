import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import { BrowseError, listDir, resolveInsideRoot } from './browse.ts'
import { renderTorrent, type TorrentStore } from './torrents.ts'
import type { Config } from './config.ts'
import type { Seeder } from './seeder.ts'

export interface AppDeps {
  config: Config
  store: TorrentStore
  seeder: Seeder
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

export function createApp ({ config, store, seeder, version }: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')

  // The client page is normally served by this same process, but CORS is kept
  // open so a separately hosted static client works too (FR-C5).
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Range')
    res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  app.get('/api/info', (req, res) => {
    res.json({ name: 'peer-to-file', version, webrtcSeeding: seeder.enabled })
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

    const hostHeader = req.headers.host ?? `${bracketHost(config.host)}:${config.port}`
    const host = config.publicHost ? bracketHost(config.publicHost) : hostWithoutPort(hostHeader)
    const httpHostPort = config.publicHost ? `${host}:${config.port}` : hostHeader

    const announce = [`ws://${host}:${config.trackerPort}`]
    const webseed = `http://${httpHostPort}/api/raw?path=${encodeURIComponent(rel)}`

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

  // Plain HTTP file endpoint with Range support — the BEP-19 webseed source.
  app.get('/api/raw', wrap(async (req, res) => {
    const abs = await resolveInsideRoot(config.root, req.query.path ?? '')
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

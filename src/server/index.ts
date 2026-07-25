import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import TrackerServer from 'bittorrent-tracker/server'
import { loadConfig, type Config } from './config.ts'
import { createTorrentStore } from './torrents.ts'
import { createCipherCache } from './cipherCache.ts'
import { startCacheCleanup } from './cacheCleanup.ts'
import { createKeyExchange } from './keyExchange.ts'
import { createSeeder } from './seeder.ts'
import { createApp, bracketHost } from './app.ts'
import { createAuthService } from './auth.ts'
import { AuthDb } from './db.ts'
import { createActivityLog, type ActivityLog } from './activity.ts'
import { consoleLogger, type Logger } from './log.ts'

/**
 * Bounds a shutdown step so one misbehaving subsystem can't hang the whole
 * process forever — log and move on instead. A close()/shutdown path should
 * always have a predictable worst-case duration (docker stop, k8s SIGTERM,
 * a CI teardown hook all expect that).
 */
function withTimeout (promise: Promise<void>, ms: number, label: string, log: Logger): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      log.warn(`${label} did not finish within ${ms}ms — continuing shutdown`)
      resolve()
    }, ms)
    timer.unref?.()
    promise.then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } },
      (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        log.warn(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
        resolve()
      }
    )
  })
}

export interface RunningServer {
  config: Config
  server: http.Server
  tracker: TrackerServer
  db: AuthDb
  activity: ActivityLog
  /** One-time first-run setup token, or null if an admin account already exists. */
  setupToken: string | null
  close (): Promise<void>
}

const version: string = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version

export async function startServer (
  config: Config,
  log: Logger = consoleLogger
): Promise<RunningServer> {
  const db = new AuthDb(config.dbPath)
  db.pruneExpiredSessions()
  const auth = createAuthService(db)
  const activity = createActivityLog()

  // First-run setup gate (F1a): while no account exists, /api/setup is only
  // usable by a caller who presents this one-time token, logged below. Once an
  // admin account exists the endpoint 409s regardless, so the token is moot.
  const setupToken = db.userCount() === 0 ? crypto.randomBytes(24).toString('base64url') : null

  // The Node seeder announces to its own tracker over loopback (or the bind
  // address when it isn't a wildcard). Peer matching only needs both sides to
  // hit the same tracker instance — URLs don't have to be identical. Lazy:
  // it goes through the token-gated /tracker on the main port, whose final
  // number is only known after listen (tests use port 0). The tracker token
  // is bound to the specific infohash being announced (F3).
  const internalHost = (config.host === '0.0.0.0' || config.host === '::')
    ? '127.0.0.1'
    : config.host
  const seeder = await createSeeder({
    announce: infoHash =>
      [`ws://${bracketHost(internalHost)}:${config.port}/tracker?ih=${infoHash}&t=${encodeURIComponent(auth.mintTrackerToken(infoHash))}`],
    log
  })

  // The tracker is only ever exposed via the token-gated /tracker path on the
  // main HTTP server — never as a standalone, unauthenticated port.
  const tracker = new TrackerServer({
    udp: false,
    http: false,
    ws: false,
    stats: false
  })
  tracker.on('error', (err: Error) => log.error(`tracker: ${err.message}`))
  tracker.on('warning', (err: Error) => log.warn(`tracker: ${err.message}`))
  // Peer lifecycle from the swarm — fires the same way whichever path (the
  // standalone tracker port or /tracker on the main port) a peer connected
  // through, since both feed the same onWebSocketConnection() entry point.
  for (const event of ['start', 'complete', 'stop'] as const) {
    tracker.on(event, (peerId: string, params: { info_hash?: string }) => {
      activity.add('tracker', `peer ${peerId.slice(0, 12)} ${event === 'start' ? 'started' : event === 'complete' ? 'completed' : 'stopped'} torrent ${params.info_hash?.slice(0, 12) ?? '?'}`, {
        peerId, infoHash: params.info_hash, event
      })
    })
  }
  const cipherCache = createCipherCache(config.cacheDir, db.cipherMasterSecret(), {
    maxBytes: config.cacheMaxBytes,
    isPinned: cachePath => seeder.isSeeding(cachePath)
  })
  const keyExchange = createKeyExchange(db.ecdhPrivateKey())

  // Hourly reaper: stop seeding files no one is transferring and delete their
  // ciphertext cache entries, so a busy server doesn't accumulate encrypted
  // copies until it hits the byte cap (or fills the disk). See cacheCleanup.ts.
  const cacheCleanup = startCacheCleanup({
    seeder,
    cipherCache,
    activity,
    log,
    idleMs: config.cacheIdleMs,
    intervalMs: config.cacheCleanupIntervalMs
  })

  const store = createTorrentStore(cipherCache)
  const app = createApp({ config, store, seeder, auth, activity, db, cipherCache, keyExchange, version, log, setupToken })
  const server = http.createServer(app)

  // Serve the tracker WebSocket on the main HTTP port too (at /tracker), so
  // a reverse proxy only needs a single upstream. Same swarm state as the
  // standalone tracker port.
  const trackerWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    clientTracking: false,
    // Accept our token-carrying subprotocol (p2f.<token>) so a client that
    // sends Sec-WebSocket-Protocol gets it echoed back per RFC 6455; clients
    // that send none (the browser bundle) are unaffected.
    handleProtocols: (protocols: Set<string>) => {
      for (const p of protocols) if (p.startsWith('p2f.')) return p
      return false
    }
  })
  // Upgraded sockets leave the http server's connection tracking, so
  // closeAllConnections() won't reach them — track them for shutdown.
  const trackerSockets = new Set<import('node:stream').Duplex>()
  server.on('upgrade', (req, socket, head) => {
    const [pathname, query] = (req.url ?? '').split('?') as [string, string?]
    if (pathname === '/tracker') {
      const params = new URLSearchParams(query ?? '')
      const infoHash = params.get('ih') ?? ''
      // Prefer a token carried in Sec-WebSocket-Protocol (keeps it out of proxy
      // access logs); fall back to the ?t= query for clients that can't set a
      // subprotocol (the browser WebTorrent bundle opens a bare WebSocket).
      const subprotocols = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',').map(s => s.trim()).filter(Boolean)
      const protoToken = subprotocols.find(p => p.startsWith('p2f.'))?.slice('p2f.'.length)
      const token = protoToken ?? params.get('t') ?? ''
      if (!auth.verifyTrackerToken(infoHash, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      trackerWss.handleUpgrade(req, socket, head, ws => {
        trackerSockets.add(socket)
        socket.on('close', () => trackerSockets.delete(socket))
        activity.add('connection', `tracker connection from ${req.socket.remoteAddress ?? 'unknown'}`, {
          ip: req.socket.remoteAddress
        })
        // bittorrent-tracker reads the request off the socket (ws >= 3
        // removed upgradeReq); mirror what its own ws server does.
        ;(ws as unknown as { upgradeReq: unknown }).upgradeReq = req
        tracker.onWebSocketConnection(ws)
      })
    } else {
      socket.destroy()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  if (config.port === 0 && addr && typeof addr === 'object') config.port = addr.port

  activity.add('server', `server started, serving ${config.root}`)

  log.info(`serving ${config.root}`)
  log.info(`web client + API on http://${bracketHost(config.host)}:${config.port}`)
  log.info(`tracker on ws://${bracketHost(config.host)}:${config.port}/tracker (token-gated)`)
  log.info(`auth: enabled, database ${config.dbPath}`)
  if (setupToken) {
    log.warn('no users exist yet — open the web client to create the admin account, or run: node src/server/cli.ts add-user <name>')
    log.warn(`first-run setup token (needed by the setup screen): ${setupToken}`)
  }
  log.info(`WebRTC seeding: ${seeder.enabled ? 'enabled' : 'DISABLED (webseed fallback only)'}`)

  async function close (): Promise<void> {
    cacheCleanup.stop()
    await withTimeout(
      new Promise<void>(resolve => tracker.close(() => resolve())),
      3000, 'tracker.close()', log
    )
    await withTimeout(seeder.destroy(), 3000, 'seeder.destroy()', log)
    for (const socket of trackerSockets) socket.destroy()
    trackerSockets.clear()
    await withTimeout(
      new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
      3000, 'server.close()', log
    )
    db.close()
  }

  return { config, server, tracker, db, activity, setupToken, close }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
if (isMain) {
  const running = await startServer(loadConfig())
  const shutdown = () => {
    consoleLogger.info('shutting down')
    running.close().then(() => process.exit(0))
    // close() itself now bounds each step to 3s (worst case ~9s across the
    // three steps), so give it enough room to actually finish gracefully
    // before this hard fallback kicks in.
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

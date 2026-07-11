import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import TrackerServer from 'bittorrent-tracker/server'
import { loadConfig, type Config } from './config.ts'
import { createTorrentStore } from './torrents.ts'
import { createSeeder } from './seeder.ts'
import { createApp, bracketHost } from './app.ts'
import { createAuthService } from './auth.ts'
import { AuthDb } from './db.ts'
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
  db: AuthDb | null
  close (): Promise<void>
}

const version: string = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version

export async function startServer (
  config: Config,
  log: Logger = consoleLogger
): Promise<RunningServer> {
  const db = config.authEnabled ? new AuthDb(config.dbPath) : null
  db?.pruneExpiredSessions()
  const auth = createAuthService(db)

  // The Node seeder announces to its own tracker over loopback (or the bind
  // address when it isn't a wildcard). Peer matching only needs both sides to
  // hit the same tracker instance — URLs don't have to be identical. Lazy:
  // with auth on it goes through /tracker on the main port, whose final
  // number is only known after listen (tests use port 0).
  const internalHost = (config.host === '0.0.0.0' || config.host === '::')
    ? '127.0.0.1'
    : config.host
  const seeder = await createSeeder({
    announce: () => auth.enabled
      ? [`ws://${bracketHost(internalHost)}:${config.port}/tracker?t=${encodeURIComponent(auth.mintTrackerToken())}`]
      : [`ws://${bracketHost(internalHost)}:${config.trackerPort}`],
    log
  })

  // With auth on, the standalone tracker port would be unauthenticated, so
  // the tracker is only exposed via /tracker on the main HTTP server.
  const tracker = new TrackerServer({
    udp: false,
    http: !config.authEnabled,
    ws: !config.authEnabled,
    stats: false
  })
  tracker.on('error', (err: Error) => log.error(`tracker: ${err.message}`))
  tracker.on('warning', (err: Error) => log.warn(`tracker: ${err.message}`))
  if (!config.authEnabled) {
    await new Promise<void>(resolve => {
      tracker.listen(config.trackerPort, config.host, resolve)
    })
    if (config.trackerPort === 0 && tracker.http) {
      const addr = tracker.http.address()
      if (addr && typeof addr === 'object') config.trackerPort = addr.port
    }
  }

  const store = createTorrentStore()
  const app = createApp({ config, store, seeder, auth, version })
  const server = http.createServer(app)

  // Serve the tracker WebSocket on the main HTTP port too (at /tracker), so
  // a reverse proxy only needs a single upstream. Same swarm state as the
  // standalone tracker port.
  const trackerWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    clientTracking: false
  })
  // Upgraded sockets leave the http server's connection tracking, so
  // closeAllConnections() won't reach them — track them for shutdown.
  const trackerSockets = new Set<import('node:stream').Duplex>()
  server.on('upgrade', (req, socket, head) => {
    const [pathname, query] = (req.url ?? '').split('?') as [string, string?]
    if (pathname === '/tracker') {
      if (auth.enabled) {
        const token = new URLSearchParams(query ?? '').get('t') ?? ''
        if (!auth.verifyTrackerToken(token)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
      }
      trackerWss.handleUpgrade(req, socket, head, ws => {
        trackerSockets.add(socket)
        socket.on('close', () => trackerSockets.delete(socket))
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

  log.info(`serving ${config.root}`)
  log.info(`web client + API on http://${bracketHost(config.host)}:${config.port}`)
  if (config.authEnabled) {
    log.info(`tracker on ws://${bracketHost(config.host)}:${config.port}/tracker (token-gated)`)
    log.info(`auth: enabled, database ${config.dbPath}`)
    if (db && db.userCount() === 0) {
      log.warn('no users exist yet — create one with: node src/server/cli.ts add-user <name>')
    }
  } else {
    log.info(`tracker on ws://${bracketHost(config.host)}:${config.trackerPort}`)
    log.warn('auth: DISABLED (P2F_AUTH=off) — anyone who can reach these ports has full access')
  }
  log.info(`WebRTC seeding: ${seeder.enabled ? 'enabled' : 'DISABLED (webseed fallback only)'}`)
  if (!config.authEnabled && (config.host === '0.0.0.0' || config.host === '::')) {
    log.warn('bound to a wildcard address with auth off — make sure only your VPN can reach these ports')
  }

  async function close (): Promise<void> {
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
    db?.close()
  }

  return { config, server, tracker, db, close }
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

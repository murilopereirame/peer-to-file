import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import TrackerServer from 'bittorrent-tracker/server'
import { loadConfig, type Config } from './config.ts'
import { createTorrentStore } from './torrents.ts'
import { createSeeder } from './seeder.ts'
import { createApp, bracketHost } from './app.ts'
import { consoleLogger, type Logger } from './log.ts'

export interface RunningServer {
  config: Config
  server: http.Server
  tracker: TrackerServer
  close (): Promise<void>
}

const version: string = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version

export async function startServer (
  config: Config,
  log: Logger = consoleLogger
): Promise<RunningServer> {
  // The Node seeder announces to its own tracker over loopback (or the bind
  // address when it isn't a wildcard). Peer matching only needs both sides to
  // hit the same tracker instance — URLs don't have to be identical.
  const internalHost = (config.host === '0.0.0.0' || config.host === '::')
    ? '127.0.0.1'
    : config.host
  const seeder = await createSeeder({
    announce: [`ws://${bracketHost(internalHost)}:${config.trackerPort}`],
    log
  })

  const tracker = new TrackerServer({ udp: false, http: true, ws: true, stats: true })
  tracker.on('error', (err: Error) => log.error(`tracker: ${err.message}`))
  tracker.on('warning', (err: Error) => log.warn(`tracker: ${err.message}`))
  await new Promise<void>(resolve => {
    tracker.listen(config.trackerPort, config.host, resolve)
  })
  if (config.trackerPort === 0 && tracker.http) {
    const addr = tracker.http.address()
    if (addr && typeof addr === 'object') config.trackerPort = addr.port
  }

  const store = createTorrentStore()
  const app = createApp({ config, store, seeder, version })
  const server = http.createServer(app)

  // Serve the tracker WebSocket on the main HTTP port too (at /tracker), so
  // a reverse proxy only needs a single upstream. Same swarm state as the
  // standalone tracker port.
  const trackerWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    clientTracking: false
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] === '/tracker') {
      trackerWss.handleUpgrade(req, socket, head, ws => {
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
  log.info(`tracker on ws://${bracketHost(config.host)}:${config.trackerPort}`)
  log.info(`WebRTC seeding: ${seeder.enabled ? 'enabled' : 'DISABLED (webseed fallback only)'}`)
  if (config.host === '0.0.0.0' || config.host === '::') {
    log.warn('bound to a wildcard address — peer-to-file has NO authentication;')
    log.warn('make sure only your VPN can reach these ports (see README)')
  }

  async function close (): Promise<void> {
    await new Promise<void>(resolve => tracker.close(() => resolve()))
    await seeder.destroy()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }

  return { config, server, tracker, close }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
if (isMain) {
  const running = await startServer(loadConfig())
  const shutdown = () => {
    consoleLogger.info('shutting down')
    running.close().then(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

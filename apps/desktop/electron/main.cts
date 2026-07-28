import { app, BrowserWindow, dialog, ipcMain, net, powerSaveBlocker, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { clearCredentials, loadCredentials, saveCredentials } from './credentials.cjs'
import { clearCookiesForOrigin, getCookie, setCookie, performFetch, type FetchRequest } from './netFetch.cjs'
import { JsonStore } from './store.cjs'

const APP_SCHEME = 'p2file'
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL
const RENDERER_DIST = join(__dirname, '..', 'dist')

// Registered before `app.whenReady()` (required) as `standard` + `secure` +
// `supportFetchAPI` + `allowServiceWorkers` — the production equivalent of
// dev's `http://localhost`: a real origin the renderer can register a
// service worker against (WebTorrent's streamed-save path needs one, same
// as the browser web client) and that qualifies as a secure context for the
// File System Access API (`showSaveFilePicker`). A `file://` window can do
// neither reliably.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: true }
  }
])

const settingsStore = new JsonStore('settings.json')

/** Mirrors the Settings screen's chosen folder — read by the `will-download`
 * handler below, updated once at startup and again whenever the user
 * changes it. Same role as the Tauri build's `DownloadDirState`. */
const downloadDir = { current: null as string | null }

interface DownloadCompletedInfo {
  filename: string
  path: string
  state: 'completed' | 'cancelled' | 'interrupted'
}

/**
 * Lets the renderer await its *own* download finishing (the click that
 * starts one is a one-way navigation with no other completion signal) —
 * matched by arrival order (a ticket per `registerPendingDownload` call,
 * consumed FIFO by `will-download`'s `done` events below), not by filename.
 * Filename matching was tried first and is exactly what broke: retrying the
 * same file (a very normal thing to do) reuses the same name, and an old,
 * already-finished download's broadcast could satisfy a brand new listener
 * waiting on that same name — resolving with the wrong path (and, via the
 * checksum feature, hashing the wrong file entirely).
 */
let nextDownloadTicket = 0
const pendingDownloadQueue: number[] = []
const downloadTickets = new Map<number, { info?: DownloadCompletedInfo, resolve?: (info: DownloadCompletedInfo) => void }>()

/** Appends "-1", "-2", ... before the extension until an unused name is
 * found, rather than silently overwriting an existing file — `setSavePath`
 * (unlike leaving Electron to pick the path itself) writes to exactly the
 * path given, no built-in collision handling. */
function uniqueSavePath (dir: string, filename: string): string {
  const ext = extname(filename)
  const base = filename.slice(0, filename.length - ext.length)
  let candidate = join(dir, filename)
  for (let n = 1; existsSync(candidate); n++) {
    candidate = join(dir, `${base}-${n}${ext}`)
  }
  return candidate
}

// Backs the "keep the machine awake during transfers" setting (off by
// default) — the renderer decides *when* to hold this (an active
// download/upload) and calls power:setKeepAwake accordingly; this only
// tracks the single blocker so repeated `true` calls don't leak blockers.
let keepAwakeBlockerId: number | null = null

function stopKeepAwake (): void {
  if (keepAwakeBlockerId !== null) {
    if (powerSaveBlocker.isStarted(keepAwakeBlockerId)) powerSaveBlocker.stop(keepAwakeBlockerId)
    keepAwakeBlockerId = null
  }
}

let mainWindow: BrowserWindow | null = null

async function createWindow (): Promise<void> {
  mainWindow = new BrowserWindow({
    title: 'P2File',
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Real WebTorrent P2P transfers run in this window (see
  // src/lib/torrentDownloads.ts) exactly like the browser client; finished
  // downloads surface as a normal "download" (via WebTorrent's own service
  // worker, or a File System Access / Blob fallback) — this redirects that
  // into the user's configured default download folder instead of Electron's
  // own default Downloads dir / a native Save As prompt.
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const dir = downloadDir.current
    if (dir) item.setSavePath(uniqueSavePath(dir, item.getFilename()))
    item.once('done', (_evt, state) => {
      const info: DownloadCompletedInfo = { filename: item.getFilename(), path: item.getSavePath(), state }
      const ticketId = pendingDownloadQueue.shift()
      if (ticketId === undefined) return
      const ticket = downloadTickets.get(ticketId)
      if (!ticket) return
      if (ticket.resolve) { ticket.resolve(info); downloadTickets.delete(ticketId) } else { ticket.info = info }
    })
  })

  if (RENDERER_DEV_URL) {
    await mainWindow.loadURL(RENDERER_DEV_URL)
  } else {
    await mainWindow.loadURL(`${APP_SCHEME}://app/index.html`)
  }
}

app.whenReady().then(() => {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const pathname = decodeURIComponent(url.pathname === '/' || url.pathname === '' ? '/index.html' : url.pathname)
    return net.fetch(pathToFileURL(join(RENDERER_DIST, pathname)).toString())
  })
  void createWindow()
}).catch((err: unknown) => {
  console.error('failed to start P2File:', err)
  app.quit()
})

app.on('window-all-closed', () => {
  stopKeepAwake()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})

// --- IPC surface, exposed to the renderer via electron/preload.cts --------

ipcMain.handle('credentials:save', (_e, server: string, username: string, refreshToken: string) => {
  saveCredentials(server, username, refreshToken)
})
ipcMain.handle('credentials:load', (_e, server: string) => loadCredentials(server))
ipcMain.handle('credentials:clear', (_e, server: string) => {
  clearCredentials(server)
  clearCookiesForOrigin(new URL(server).origin)
})

// Read/seed the main-process cookie jar — used to persist and restore the
// refresh token (p2f_refresh) across app restarts (F9).
ipcMain.handle('net:getCookie', (_e, origin: string, name: string) => getCookie(origin, name) ?? null)
ipcMain.handle('net:setCookie', (_e, origin: string, name: string, value: string) => { setCookie(origin, name, value) })

ipcMain.handle('downloads:defaultDir', () => app.getPath('downloads'))
ipcMain.handle('downloads:pickFolder', async () => {
  if (!mainWindow) return null
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Choose a default download folder' })
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
})
ipcMain.handle('downloads:setDir', (_e, path: string | null) => { downloadDir.current = path })

ipcMain.handle('settings:get', (_e, key: string) => settingsStore.get(key))
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => { settingsStore.set(key, value) })
ipcMain.handle('settings:delete', (_e, key: string) => { settingsStore.delete(key) })

ipcMain.handle('net:fetch', (_e, req: FetchRequest) => performFetch(req))

// 'prevent-app-suspension' keeps the system from sleeping while transfers
// are active without also forcing the display to stay on — starting an
// already-started blocker is avoided so this stays idempotent under the
// renderer's polling.
ipcMain.handle('power:setKeepAwake', (_e, enabled: boolean) => {
  if (enabled) {
    if (keepAwakeBlockerId === null || !powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
      keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
  } else {
    stopKeepAwake()
  }
})

// See the DownloadCompletedInfo/pendingDownloadQueue doc comment above —
// call registerPendingDownload() and only *then* trigger the download, so
// this ticket is queued before its `will-download` can possibly fire.
ipcMain.handle('downloads:registerPending', () => {
  const id = nextDownloadTicket++
  downloadTickets.set(id, {})
  pendingDownloadQueue.push(id)
  return id
})
ipcMain.handle('downloads:awaitCompletion', async (_e, ticketId: number) => {
  const ticket = downloadTickets.get(ticketId)
  if (!ticket) throw new Error('unknown download ticket')
  if (ticket.info) { downloadTickets.delete(ticketId); return ticket.info }
  return await new Promise<DownloadCompletedInfo>((resolve) => { ticket.resolve = resolve })
})

// Streamed (constant-memory) SHA-256 of a saved download, for the renderer
// to compare against the server's plaintext hash — the renderer itself has
// no way to re-read an auto-saved file (only the main process has real
// filesystem access), and a streamed hash here scales to arbitrarily large
// files the same way the download/decrypt path already does.
ipcMain.handle('downloads:hashFile', async (_e, filePath: string) => {
  try {
    const hash = createHash('sha256')
    await pipeline(createReadStream(filePath), hash)
    return hash.digest('hex')
  } catch {
    return null
  }
})

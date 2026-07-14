import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { clearCredentials, loadCredentials, saveCredentials } from './credentials.cjs'
import { clearCookiesForOrigin, performFetch, type FetchRequest } from './netFetch.cjs'
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
    if (dir) item.setSavePath(join(dir, item.getFilename()))
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})

// --- IPC surface, exposed to the renderer via electron/preload.cts --------

ipcMain.handle('credentials:save', (_e, server: string, username: string, password: string) => {
  saveCredentials(server, username, password)
})
ipcMain.handle('credentials:load', (_e, server: string) => loadCredentials(server))
ipcMain.handle('credentials:clear', (_e, server: string) => {
  clearCredentials(server)
  clearCookiesForOrigin(new URL(server).origin)
})

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

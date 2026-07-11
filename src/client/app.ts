// Browser client for peer-to-file. Compiled with tsc to public/app.js.
// Uses the WebTorrent browser bundle loaded globally from /vendor/.

interface WTFile {
  name: string
  length: number
  blob (): Promise<Blob>
}

interface WTWire {
  destroy (): void
}

interface WTTorrent {
  infoHash: string
  name: string
  progress: number
  downloaded: number
  length: number
  downloadSpeed: number
  timeRemaining: number
  numPeers: number
  done: boolean
  paused: boolean
  destroyed: boolean
  files: WTFile[]
  wires: WTWire[]
  on (event: string, fn: (...args: unknown[]) => void): void
  addWebSeed (url: string): void
  removePeer (peerOrId: string): void
  pause (): void
  resume (): void
  destroy (opts?: { destroyStore?: boolean }, cb?: () => void): void
}

declare class WebTorrent {
  constructor (opts?: object)
  add (
    torrent: Uint8Array,
    opts: object,
    ontorrent: (torrent: WTTorrent) => void
  ): WTTorrent
  on (event: string, fn: (...args: unknown[]) => void): void
}

// ---------------------------------------------------------------------------
// OPFS chunk store: persists verified pieces in the browser's origin-private
// file system so a refreshed tab can resume a download instead of restarting.
// Implements the abstract-chunk-store interface WebTorrent expects; one file
// per piece under p2f-downloads/<infohash>/.

type StoreCb<T = void> = (err: Error | null, value?: T) => void

class OpfsChunkStore {
  chunkLength: number
  length: number
  private readonly lastChunkIndex: number
  private readonly lastChunkLength: number
  private readonly key: string
  private readonly dirPromise: Promise<FileSystemDirectoryHandle>

  constructor (
    chunkLength: number,
    opts: { torrent?: { infoHash?: string }, length?: number, name?: string }
  ) {
    this.chunkLength = chunkLength
    this.length = opts.length ?? 0
    this.lastChunkIndex = Math.max(0, Math.ceil(this.length / chunkLength) - 1)
    this.lastChunkLength = this.length - this.lastChunkIndex * chunkLength
    this.key = opts.torrent?.infoHash ?? opts.name ?? 'unknown'
    this.dirPromise = OpfsChunkStore.dirFor(this.key)
  }

  static async dirFor (key: string): Promise<FileSystemDirectoryHandle> {
    const rootDir = await navigator.storage.getDirectory()
    const parent = await rootDir.getDirectoryHandle('p2f-downloads', { create: true })
    return parent.getDirectoryHandle(key, { create: true })
  }

  static async remove (key: string): Promise<void> {
    try {
      const rootDir = await navigator.storage.getDirectory()
      const parent = await rootDir.getDirectoryHandle('p2f-downloads')
      await parent.removeEntry(key, { recursive: true })
    } catch { /* nothing stored */ }
  }

  private expectedLength (index: number): number {
    return index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength
  }

  put (index: number, buf: Uint8Array, cb: StoreCb): void {
    this.dirPromise.then(async dir => {
      const handle = await dir.getFileHandle(String(index), { create: true })
      const writable = await handle.createWritable()
      // cast: TS's DOM lib insists on non-shared ArrayBuffer backing
      await writable.write(buf as Uint8Array<ArrayBuffer>)
      await writable.close()
    }).then(() => cb(null), (err: Error) => cb(err))
  }

  get (index: number, opts: { offset?: number, length?: number } | StoreCb<Uint8Array>, cb?: StoreCb<Uint8Array>): void {
    let options: { offset?: number, length?: number } = {}
    if (typeof opts === 'function') {
      cb = opts
    } else if (opts) {
      options = opts
    }
    const done = cb as StoreCb<Uint8Array>
    this.dirPromise.then(async dir => {
      const handle = await dir.getFileHandle(String(index)) // throws if absent
      const file = await handle.getFile()
      if (file.size !== this.expectedLength(index)) {
        throw new Error(`chunk ${index} is incomplete`)
      }
      const offset = options.offset ?? 0
      const end = options.length !== undefined ? offset + options.length : file.size
      const buf = await file.slice(offset, end).arrayBuffer()
      return new Uint8Array(buf)
    }).then(data => done(null, data), (err: Error) => done(err))
  }

  close (cb: StoreCb): void { cb(null) }

  destroy (cb: StoreCb): void {
    OpfsChunkStore.remove(this.key).then(() => cb(null), (err: Error) => cb(err))
  }
}

// ---------------------------------------------------------------------------
// DOM handles

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`missing element ${sel}`)
  return el
}

const connectForm = $<HTMLFormElement>('#connect-form')
const serverInput = $<HTMLInputElement>('#server-input')
const connStatus = $('#conn-status')
const loginSection = $('#login')
const loginForm = $<HTMLFormElement>('#login-form')
const loginUser = $<HTMLInputElement>('#login-user')
const loginPass = $<HTMLInputElement>('#login-pass')
const loginStatus = $('#login-status')
const logoutBtn = $<HTMLButtonElement>('#logout')
const browserSection = $('#browser')
const breadcrumbEl = $('#breadcrumb')
const listingEl = $('#listing')
const downloadsPanel = $('#downloads-panel')
const downloadsEl = $('#downloads')

let apiBase: string | null = null
let currentPath = ''
let downloadsRestored = false

// No STUN/TURN: both peers sit on the same VPN, host candidates are enough.
const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
client.on('error', (err: unknown) => {
  setStatus(`WebTorrent error: ${errMessage(err)}`, 'error')
})

function errMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function setStatus (msg: string, kind: '' | 'ok' | 'error' = ''): void {
  connStatus.textContent = msg
  connStatus.className = `status ${kind}`
}

function normalizeServer (input: string): string {
  let addr = input.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(addr)) {
    // Default to the page's own scheme: on an https page (e.g. behind an
    // nginx TLS proxy) a http:// API call would be blocked as mixed content.
    const scheme = location.protocol === 'https:' ? 'https' : 'http'
    addr = `${scheme}://${addr}`
  }
  return addr
}

class HttpError extends Error {
  readonly status: number
  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function apiFetch (pathname: string, init?: RequestInit): Promise<Response> {
  if (!apiBase) throw new Error('not connected')
  const res = await fetch(`${apiBase}${pathname}`, { credentials: 'include', ...init })
  if (res.status === 401) {
    showLogin()
    throw new HttpError(401, 'authentication required')
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json() as { error?: string }
      if (body.error) detail = body.error
    } catch { /* non-JSON error body */ }
    throw new HttpError(res.status, detail)
  }
  return res
}

// ---------------------------------------------------------------------------
// Connect + login

async function connect (address: string, quiet = false): Promise<void> {
  const base = normalizeServer(address)
  if (!quiet) setStatus('connecting…')
  try {
    const res = await fetch(`${base}/api/info`, { credentials: 'include' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const info = await res.json() as {
      name?: string
      version?: string
      auth?: { required: boolean, authenticated: boolean }
    }
    if (info.name !== 'peer-to-file') throw new Error('not a peer-to-file server')
    apiBase = base
    localStorage.setItem('p2f-server', address.trim())
    setStatus(`connected to ${base} (v${info.version ?? '?'})`, 'ok')

    if (info.auth?.required && !info.auth.authenticated) {
      showLogin()
    } else {
      await showBrowser(info.auth?.required ?? false)
    }
  } catch (err) {
    if (!quiet) setStatus(`connection failed: ${errMessage(err)}`, 'error')
    throw err
  }
}

function showLogin (): void {
  loginSection.hidden = false
  browserSection.hidden = true
  logoutBtn.hidden = true
  loginUser.focus()
}

async function showBrowser (authed: boolean): Promise<void> {
  loginSection.hidden = true
  browserSection.hidden = false
  logoutBtn.hidden = !authed
  await loadListing('')
  if (!downloadsRestored) {
    downloadsRestored = true
    restoreDownloads()
  }
}

loginForm.addEventListener('submit', event => {
  event.preventDefault()
  void (async () => {
    loginStatus.textContent = 'signing in…'
    loginStatus.className = 'status'
    try {
      await apiFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser.value, password: loginPass.value })
      })
      loginPass.value = ''
      loginStatus.textContent = ''
      await showBrowser(true)
    } catch (err) {
      loginStatus.textContent = err instanceof HttpError && err.status === 401
        ? 'invalid credentials'
        : `login failed: ${errMessage(err)}`
      loginStatus.className = 'status error'
    }
  })()
})

logoutBtn.addEventListener('click', () => {
  void (async () => {
    try { await apiFetch('/api/logout', { method: 'POST' }) } catch { /* session gone anyway */ }
    showLogin()
  })()
})

// ---------------------------------------------------------------------------
// Browsing (navigate first, load after — the UI reacts immediately)

interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
}

async function loadListing (path: string): Promise<void> {
  // optimistic: show the target location and a loading state right away
  currentPath = path
  renderBreadcrumb()
  listingEl.replaceChildren(loadingRow())

  try {
    const res = await apiFetch(`/api/list?path=${encodeURIComponent(path)}`)
    const listing = await res.json() as { path: string, entries: DirEntry[] }
    if (currentPath !== path) return // user already navigated elsewhere
    currentPath = listing.path
    renderBreadcrumb()
    renderListing(listing.entries)
  } catch (err) {
    if (currentPath !== path) return
    const li = document.createElement('li')
    li.className = 'empty error'
    li.textContent = `failed to load folder: ${errMessage(err)} `
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'retry'
    retry.addEventListener('click', () => { void loadListing(path) })
    li.append(retry)
    listingEl.replaceChildren(li)
  }
}

function loadingRow (): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'empty loading'
  li.textContent = 'loading…'
  return li
}

function renderBreadcrumb (): void {
  breadcrumbEl.replaceChildren()
  const segments = currentPath === '' ? [] : currentPath.split('/')

  const rootBtn = document.createElement('button')
  rootBtn.type = 'button'
  rootBtn.textContent = '⌂ root'
  rootBtn.addEventListener('click', () => { void loadListing('') })
  breadcrumbEl.append(rootBtn)

  segments.forEach((segment, i) => {
    const sep = document.createElement('span')
    sep.className = 'sep'
    sep.textContent = '/'
    breadcrumbEl.append(sep)

    if (i === segments.length - 1) {
      const current = document.createElement('span')
      current.className = 'current'
      current.textContent = segment
      breadcrumbEl.append(current)
    } else {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = segment
      const target = segments.slice(0, i + 1).join('/')
      btn.addEventListener('click', () => { void loadListing(target) })
      breadcrumbEl.append(btn)
    }
  })
}

function renderListing (entries: DirEntry[]): void {
  listingEl.replaceChildren()
  if (entries.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'empty folder'
    listingEl.append(li)
    return
  }

  for (const entry of entries) {
    const li = document.createElement('li')
    li.className = entry.type
    const entryPath = currentPath === '' ? entry.name : `${currentPath}/${entry.name}`

    const icon = document.createElement('span')
    icon.className = 'entry-icon'
    icon.textContent = entry.type === 'dir' ? '📁' : '📄'

    const name = document.createElement('span')
    name.className = 'entry-name'
    name.textContent = entry.name

    const meta = document.createElement('span')
    meta.className = 'entry-meta'
    meta.textContent = entry.type === 'file'
      ? `${formatBytes(entry.size ?? 0)} · ${new Date(entry.mtime).toLocaleDateString()}`
      : new Date(entry.mtime).toLocaleDateString()

    li.append(icon, name, meta)

    if (entry.type === 'dir') {
      li.addEventListener('click', () => { void loadListing(entryPath) })
    } else {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'primary'
      btn.textContent = 'Download'
      btn.addEventListener('click', () => { void startDownload(entryPath, entry.name) })
      li.append(btn)
    }
    listingEl.append(li)
  }
}

// ---------------------------------------------------------------------------
// Downloads

interface SavedDownload {
  path: string
  name: string
  paused?: boolean
}

function savedDownloads (): SavedDownload[] {
  try {
    return JSON.parse(localStorage.getItem('p2f-downloads') ?? '[]') as SavedDownload[]
  } catch {
    return []
  }
}

function persistDownload (entry: SavedDownload): void {
  const list = savedDownloads().filter(d => d.path !== entry.path)
  list.push(entry)
  localStorage.setItem('p2f-downloads', JSON.stringify(list))
}

function forgetDownload (path: string): void {
  localStorage.setItem(
    'p2f-downloads',
    JSON.stringify(savedDownloads().filter(d => d.path !== path))
  )
}

function restoreDownloads (): void {
  for (const saved of savedDownloads()) {
    void startDownload(saved.path, saved.name, { startPaused: saved.paused ?? false })
  }
}

interface DownloadRow {
  li: HTMLLIElement
  bar: HTMLDivElement
  stats: HTMLSpanElement
  state: HTMLSpanElement
  pauseBtn: HTMLButtonElement
  cancelBtn: HTMLButtonElement
}

const activeDownloads = new Set<string>() // entry paths with a live download

function createDownloadRow (name: string): DownloadRow {
  downloadsPanel.hidden = false
  const li = document.createElement('li')

  const title = document.createElement('span')
  title.className = 'dl-name'
  title.textContent = name

  const bar = document.createElement('div')
  bar.className = 'dl-bar'
  const fill = document.createElement('div')
  bar.append(fill)

  const stats = document.createElement('span')
  stats.className = 'dl-stats'

  const state = document.createElement('span')
  state.className = 'dl-state'
  state.textContent = 'preparing…'

  const pauseBtn = document.createElement('button')
  pauseBtn.type = 'button'
  pauseBtn.textContent = 'Pause'
  pauseBtn.hidden = true

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = 'Cancel'

  li.append(title, bar, stats, state, pauseBtn, cancelBtn)
  downloadsEl.prepend(li)
  return { li, bar: fill, stats, state, pauseBtn, cancelBtn }
}

function setRowState (row: DownloadRow, state: string, cssClass = ''): void {
  row.state.textContent = state
  row.state.className = `dl-state ${cssClass}`
  row.li.dataset.state = cssClass || state
}

async function startDownload (
  entryPath: string,
  name: string,
  { startPaused = false } = {}
): Promise<void> {
  if (activeDownloads.has(entryPath)) return
  activeDownloads.add(entryPath)
  const row = createDownloadRow(name)
  row.li.dataset.path = entryPath
  row.li.dataset.state = 'preparing'

  try {
    // The server hashes the file on first request — may take a while for
    // large files, hence the "preparing" state. Re-fetched on every start so
    // restored downloads get fresh transfer tokens (the infohash — and with
    // it the OPFS piece store — stays the same for unchanged files).
    const res = await apiFetch(`/api/torrent?path=${encodeURIComponent(entryPath)}`)
    const meta = await res.json() as {
      infoHash: string
      length: number
      magnet: string
      webseed: string
      torrentBase64: string
    }
    const torrentFile = Uint8Array.from(atob(meta.torrentBase64), c => c.charCodeAt(0))
    row.li.dataset.infohash = meta.infoHash
    persistDownload({ path: entryPath, name, paused: startPaused })

    const opfsAvailable = typeof navigator.storage?.getDirectory === 'function'
    client.add(torrentFile, {
      // more parallel webseed connections: smoother, higher throughput
      maxWebConns: 8,
      // persist verified pieces so a refreshed tab resumes, not restarts
      // (browsers without OPFS fall back to WebTorrent's in-memory store)
      ...(opfsAvailable ? { store: OpfsChunkStore } : {})
    }, torrent => {
      trackTorrent(torrent, meta.webseed, row, entryPath, name, startPaused)
    })
  } catch (err) {
    setRowState(row, `failed: ${errMessage(err)}`, 'error')
    activeDownloads.delete(entryPath)
  }
}

function pauseTorrent (torrent: WTTorrent): void {
  torrent.pause() // stop new peer connections
  // ...and drop live ones, so paused really means zero bandwidth
  for (const wire of [...torrent.wires]) {
    try { wire.destroy() } catch { /* already gone */ }
  }
}

function trackTorrent (
  torrent: WTTorrent,
  webseed: string,
  row: DownloadRow,
  entryPath: string,
  name: string,
  startPaused: boolean
): void {
  let finished = false
  let lastWebseedRetry = 0
  let smoothedSpeed = 0

  if (startPaused) {
    pauseTorrent(torrent)
    setRowState(row, 'paused', 'paused')
  } else {
    setRowState(row, 'downloading')
  }

  row.pauseBtn.hidden = false
  row.pauseBtn.textContent = torrent.paused ? 'Resume' : 'Pause'
  row.pauseBtn.addEventListener('click', () => {
    if (finished || torrent.destroyed) return
    if (torrent.paused) {
      torrent.resume()
      lastWebseedRetry = 0 // let the watchdog re-attach the webseed right away
      row.pauseBtn.textContent = 'Pause'
      setRowState(row, 'downloading')
      persistDownload({ path: entryPath, name, paused: false })
    } else {
      pauseTorrent(torrent)
      row.pauseBtn.textContent = 'Resume'
      setRowState(row, 'paused', 'paused')
      persistDownload({ path: entryPath, name, paused: true })
    }
  })

  row.cancelBtn.addEventListener('click', () => {
    if (finished || torrent.destroyed) return
    finished = true
    torrent.destroy({ destroyStore: true }) // free bandwidth AND stored pieces
    forgetDownload(entryPath)
    activeDownloads.delete(entryPath)
    row.li.remove()
    if (downloadsEl.childElementCount === 0) downloadsPanel.hidden = true
  })

  const tick = setInterval(() => {
    if (finished || torrent.destroyed) { clearInterval(tick); return }

    row.bar.style.width = `${(torrent.progress * 100).toFixed(1)}%`
    row.li.dataset.downloaded = String(torrent.downloaded)
    row.li.dataset.progress = String(torrent.progress)

    if (torrent.paused) {
      row.stats.textContent =
        `${(torrent.progress * 100).toFixed(1)}% · ` +
        `${formatBytes(torrent.downloaded)} / ${formatBytes(torrent.length)}`
      smoothedSpeed = 0
      return
    }

    // exponential smoothing keeps the displayed speed from jumping around
    smoothedSpeed = smoothedSpeed === 0
      ? torrent.downloadSpeed
      : smoothedSpeed * 0.7 + torrent.downloadSpeed * 0.3
    const eta = smoothedSpeed > 0
      ? (torrent.length - torrent.downloaded) / smoothedSpeed * 1000
      : Infinity

    row.stats.textContent =
      `${(torrent.progress * 100).toFixed(1)}% · ` +
      `${formatBytes(torrent.downloaded)} / ${formatBytes(torrent.length)} · ` +
      `${formatBytes(smoothedSpeed)}/s · ` +
      `ETA ${formatEta(eta)} · ` +
      `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`
    setRowState(row, torrent.numPeers === 0 ? 'waiting for server…' : 'downloading')

    // Resume watchdog. The WebRTC path re-establishes itself via tracker
    // re-announce; the webseed connection is not re-added by WebTorrent after
    // it dies, so when all sources are gone, re-attach it. Only the missing
    // pieces are requested — progress is kept.
    if (torrent.numPeers === 0 && Date.now() - lastWebseedRetry > 5000) {
      lastWebseedRetry = Date.now()
      // a dead webconn can linger in the peer table and make addWebSeed a
      // silent no-op — clear it first
      try { torrent.removePeer(webseed) } catch { /* not present */ }
      try { torrent.addWebSeed(webseed) } catch { /* already attached */ }
    }
  }, 500)

  torrent.on('done', () => {
    if (finished) return
    finished = true
    clearInterval(tick)
    row.pauseBtn.hidden = true
    void saveFile(torrent, row, entryPath)
  })

  torrent.on('error', (err: unknown) => {
    clearInterval(tick)
    setRowState(row, `failed: ${errMessage(err)}`, 'error')
    activeDownloads.delete(entryPath)
  })
}

async function saveFile (torrent: WTTorrent, row: DownloadRow, entryPath: string): Promise<void> {
  setRowState(row, 'saving…')
  row.bar.style.width = '100%'
  try {
    const file = torrent.files[0]
    if (!file) throw new Error('torrent has no files')
    const blob = await file.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)

    setRowState(row, 'done', 'done')
    row.stats.textContent = formatBytes(torrent.length)
    row.cancelBtn.textContent = 'Clear'
    forgetDownload(entryPath)
    torrent.destroy({ destroyStore: true }) // free the stored pieces
  } catch (err) {
    setRowState(row, `save failed: ${errMessage(err)}`, 'error')
  }
  activeDownloads.delete(entryPath)
}

// ---------------------------------------------------------------------------
// Formatting helpers

function formatBytes (n: number): string {
  if (!Number.isFinite(n)) return '?'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = n
  let u = 0
  while (value >= 1024 && u < units.length - 1) { value /= 1024; u++ }
  return `${u === 0 ? value : value.toFixed(1)} ${units[u]}`
}

function formatEta (ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// ---------------------------------------------------------------------------
// Boot

connectForm.addEventListener('submit', event => {
  event.preventDefault()
  connect(serverInput.value).catch(() => {})
})

const saved = localStorage.getItem('p2f-server')
if (saved) {
  serverInput.value = saved
} else if (location.protocol.startsWith('http')) {
  serverInput.value = location.host
}
// When the page is served by the server itself, connect right away.
if (serverInput.value) {
  connect(serverInput.value, true).catch(() => {
    setStatus('enter the server address and press Connect')
  })
}

// Browser client for peer-to-file. Compiled with tsc to public/app.js.
// Uses the WebTorrent browser bundle loaded globally from /vendor/.

interface WTFile {
  name: string
  length: number
  type?: string
  /** Only valid once a WTServer has been created on the client (streamed downloads). */
  streamURL: string
  stream (): ReadableStream<Uint8Array>
  [Symbol.asyncIterator] (): AsyncIterableIterator<Uint8Array>
}

interface WTWire {
  type: string // 'webrtc' | 'webSeed' | 'tcpIncoming' | ...
  remoteAddress?: string
  remotePort?: number
  peerId?: string
  destroy (): void
  downloadSpeed (): number
  uploadSpeed (): number
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

interface WTServer {
  listen (port: number, cb: () => void): void
}

declare class WebTorrent {
  constructor (opts?: object)
  add (
    torrent: Uint8Array,
    opts: object,
    ontorrent: (torrent: WTTorrent) => void
  ): WTTorrent
  on (event: string, fn: (...args: unknown[]) => void): void
  createServer (opts: { controller: ServiceWorkerRegistration }, force: 'browser' | 'node'): WTServer
}

// File System Access API — not yet in TS's bundled DOM lib.
interface FileSystemWritableFileStream extends WritableStream {
  write (data: BufferSource | Blob | string): Promise<void>
  close (): Promise<void>
}
interface FileSystemFileHandle {
  createWritable (): Promise<FileSystemWritableFileStream>
}
// This file has no top-level import/export, so TS treats it as a global
// script — top-level interfaces here already merge with the real `Window`,
// no `declare global` wrapper needed (that only applies inside modules).
interface Window {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>
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

  /** All infoHash keys currently holding pieces on disk — used to reap orphans on startup. */
  static async listKeys (): Promise<string[]> {
    try {
      const rootDir = await navigator.storage.getDirectory()
      const parent = await rootDir.getDirectoryHandle('p2f-downloads')
      const keys: string[] = []
      // FileSystemDirectoryHandle is async-iterable in browsers that support
      // OPFS, but TS's DOM lib doesn't declare that yet — cast to iterate.
      const iter = parent as unknown as AsyncIterable<[string, FileSystemHandle]>
      for await (const [name, handle] of iter) {
        if (handle.kind === 'directory') keys.push(name)
      }
      return keys
    } catch {
      return []
    }
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
const setupSection = $('#setup')
const setupForm = $<HTMLFormElement>('#setup-form')
const setupUser = $<HTMLInputElement>('#setup-user')
const setupPass = $<HTMLInputElement>('#setup-pass')
const setupPass2 = $<HTMLInputElement>('#setup-pass2')
const setupStatus = $('#setup-status')
const loginSection = $('#login')
const loginForm = $<HTMLFormElement>('#login-form')
const loginUser = $<HTMLInputElement>('#login-user')
const loginPass = $<HTMLInputElement>('#login-pass')
const loginStatus = $('#login-status')
const logoutBtn = $<HTMLButtonElement>('#logout')
const logsLink = $<HTMLAnchorElement>('#logs-link')
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

// Streamed saving: WebTorrent's own service worker pipes a file's data
// straight from its chunk store to the browser's native download mechanism
// (Content-Disposition: attachment), so a completed download never has to
// be materialized as one in-memory Blob first — the fix for OOM on huge
// files and for Safari's much smaller Blob size limit. This needs a secure
// context (HTTPS or localhost); on plain HTTP (e.g. an un-proxied VPN
// deployment) Service Workers aren't available at all, so we fall back to
// building the Blob from individual chunks (still avoids the extra full-size
// copy `file.arrayBuffer()` does, just not the memory footprint itself).
let streamServer: WTServer | null = null
if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(async registration => {
      // .ready only means *a* worker is active for this scope — on this
      // page's first-ever visit (nothing registered before), that worker
      // still needs a moment to actually take control of the open page via
      // clients.claim(). Fetching a stream URL before that finishes bypasses
      // the service worker entirely and hits the real server, which 404s on
      // /webtorrent/* — so wait for control before trusting streamed saves.
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>(resolve => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
        })
      }
      streamServer = client.createServer({ controller: registration }, 'browser')
      streamServer.listen(0, () => {})
    })
    .catch((err: unknown) => {
      console.warn('streamed downloads unavailable, falling back to in-memory saves:', err)
    })
}

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
      auth?: { required: boolean, needsSetup: boolean, authenticated: boolean }
    }
    if (info.name !== 'peer-to-file') throw new Error('not a peer-to-file server')
    apiBase = base
    localStorage.setItem('p2f-server', address.trim())
    setStatus(`connected to ${base} (v${info.version ?? '?'})`, 'ok')

    if (info.auth?.required && info.auth.needsSetup) {
      showSetup()
    } else if (info.auth?.required && !info.auth.authenticated) {
      showLogin()
    } else {
      await showBrowser(info.auth?.required ?? false)
    }
  } catch (err) {
    if (!quiet) setStatus(`connection failed: ${errMessage(err)}`, 'error')
    throw err
  }
}

function showSetup (): void {
  setupSection.hidden = false
  loginSection.hidden = true
  browserSection.hidden = true
  logoutBtn.hidden = true
  logsLink.hidden = true
  setupUser.focus()
}

function showLogin (): void {
  setupSection.hidden = true
  loginSection.hidden = false
  browserSection.hidden = true
  logoutBtn.hidden = true
  logsLink.hidden = true
  loginUser.focus()
}

async function showBrowser (authed: boolean): Promise<void> {
  setupSection.hidden = true
  loginSection.hidden = true
  browserSection.hidden = false
  logoutBtn.hidden = !authed
  logsLink.hidden = false
  await loadListing('')
  if (!downloadsRestored) {
    downloadsRestored = true
    await reconcileDownloads()
    restoreDownloads()
  }
}

setupForm.addEventListener('submit', event => {
  event.preventDefault()
  void (async () => {
    if (setupPass.value !== setupPass2.value) {
      setupStatus.textContent = 'passwords do not match'
      setupStatus.className = 'status error'
      return
    }
    setupStatus.textContent = 'creating account…'
    setupStatus.className = 'status'
    try {
      await apiFetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: setupUser.value, password: setupPass.value })
      })
      setupPass.value = ''
      setupPass2.value = ''
      setupStatus.textContent = ''
      await showBrowser(true)
    } catch (err) {
      setupStatus.textContent = `could not create account: ${errMessage(err)}`
      setupStatus.className = 'status error'
    }
  })()
})

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

// A download untouched this long is treated as abandoned (tab closed and
// never reopened) and reaped on the next visit — both the localStorage entry
// and, more importantly, its OPFS piece store, which otherwise has no owner
// and would sit there forever.
const STALE_DOWNLOAD_MS = 14 * 24 * 60 * 60 * 1000
// How often an in-progress download's lastActiveAt gets refreshed on disk —
// no need to write localStorage on every 500ms progress tick.
const TOUCH_INTERVAL_MS = 30_000
// Grace period before reclaiming a completed download's OPFS store when we
// have no direct signal that the browser's own save/download finished (the
// service-worker + <a download> path) — long enough for any real transfer
// speed to finish streaming, short enough not to waste much disk space.
const PENDING_CLEANUP_DELAY_MS = 2 * 60_000

interface SavedDownload {
  path: string
  name: string
  paused?: boolean
  infoHash?: string
  lastActiveAt: number
  /**
   * Set once a download finished saving through a path with no completion
   * signal (the service-worker + <a download> trick — see saveFile). The
   * OPFS store still needs reaping, but only once we're done using it, which
   * for that path we can't observe directly, so it's deferred to the next
   * reconciliation pass instead of done inline.
   */
  pendingCleanup?: boolean
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

function touchDownload (path: string, patch: Partial<SavedDownload> = {}): void {
  const existing = savedDownloads().find(d => d.path === path)
  if (!existing) return
  persistDownload({ ...existing, ...patch, lastActiveAt: Date.now() })
}

function forgetDownload (path: string): void {
  localStorage.setItem(
    'p2f-downloads',
    JSON.stringify(savedDownloads().filter(d => d.path !== path))
  )
}

/**
 * Runs once at startup, before downloads are restored: drops (and reclaims
 * the OPFS storage for) entries that finished saving via a no-completion-
 * signal path, entries abandoned for longer than STALE_DOWNLOAD_MS, and any
 * OPFS piece store left with no tracked download at all.
 */
async function reconcileDownloads (): Promise<void> {
  const list = savedDownloads()
  const now = Date.now()
  const keep: SavedDownload[] = []
  const reap = new Set<string>()

  for (const entry of list) {
    const abandoned = now - entry.lastActiveAt > STALE_DOWNLOAD_MS
    if (entry.pendingCleanup || abandoned) {
      if (entry.infoHash) reap.add(entry.infoHash)
      continue
    }
    keep.push(entry)
  }
  if (keep.length !== list.length) {
    localStorage.setItem('p2f-downloads', JSON.stringify(keep))
  }

  const tracked = new Set(keep.map(e => e.infoHash).filter((h): h is string => Boolean(h)))
  for (const key of await OpfsChunkStore.listKeys()) {
    if (!tracked.has(key)) reap.add(key)
  }
  await Promise.all([...reap].map(key => OpfsChunkStore.remove(key)))
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
  detailsBtn: HTMLButtonElement
  details: HTMLDivElement
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

  const detailsBtn = document.createElement('button')
  detailsBtn.type = 'button'
  detailsBtn.textContent = 'Details'

  const pauseBtn = document.createElement('button')
  pauseBtn.type = 'button'
  pauseBtn.textContent = 'Pause'
  pauseBtn.hidden = true

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = 'Cancel'

  const details = document.createElement('div')
  details.className = 'dl-details'
  details.hidden = true

  li.append(title, bar, stats, state, detailsBtn, pauseBtn, cancelBtn, details)
  downloadsEl.prepend(li)
  return { li, bar: fill, stats, state, pauseBtn, cancelBtn, detailsBtn, details }
}

function setRowState (row: DownloadRow, state: string, cssClass = ''): void {
  row.state.textContent = state
  row.state.className = `dl-state ${cssClass}`
  row.li.dataset.state = cssClass || state
}

function renderDetails (torrent: WTTorrent, row: DownloadRow, startedAt: number): void {
  row.details.replaceChildren()

  const dl = document.createElement('dl')
  const addField = (term: string, value: string): void => {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    dl.append(dt, dd)
  }
  addField('Info hash', torrent.infoHash)
  addField('Elapsed', formatDuration(Date.now() - startedAt))
  addField('Size', formatBytes(torrent.length))
  row.details.append(dl)

  const peersTitle = document.createElement('div')
  peersTitle.textContent = `Peers (${torrent.wires.length})`
  row.details.append(peersTitle)

  if (torrent.wires.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'no-peers'
    empty.textContent = 'no active peers'
    row.details.append(empty)
    return
  }

  const ul = document.createElement('ul')
  ul.className = 'peers'
  for (const wire of torrent.wires) {
    const li = document.createElement('li')

    const type = document.createElement('span')
    type.className = 'peer-type'
    type.textContent = wire.type === 'webSeed' ? 'webseed' : wire.type

    const addr = document.createElement('span')
    addr.className = 'peer-addr'
    // WebRTC peer addresses are best-effort (from getStats()) and not
    // always available; the webseed "peer" is the server itself.
    addr.textContent = wire.remoteAddress
      ? `${wire.remoteAddress}${wire.remotePort ? ':' + wire.remotePort : ''}`
      : wire.type === 'webSeed' ? 'server' : 'address unavailable'

    const speed = document.createElement('span')
    speed.className = 'peer-speed'
    speed.textContent = `${formatBytes(wire.downloadSpeed())}/s`

    li.append(type, addr, speed)
    ul.append(li)
  }
  row.details.append(ul)
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
    persistDownload({
      path: entryPath, name, paused: startPaused,
      infoHash: meta.infoHash, lastActiveAt: Date.now()
    })

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
  let lastTouch = 0
  let smoothedSpeed = 0
  const startedAt = Date.now()
  row.li.dataset.startedAt = String(startedAt)

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
      touchDownload(entryPath, { paused: false })
    } else {
      pauseTorrent(torrent)
      row.pauseBtn.textContent = 'Resume'
      setRowState(row, 'paused', 'paused')
      touchDownload(entryPath, { paused: true })
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

  row.detailsBtn.addEventListener('click', () => {
    row.details.hidden = !row.details.hidden
    row.detailsBtn.textContent = row.details.hidden ? 'Details' : 'Hide details'
    if (!row.details.hidden) renderDetails(torrent, row, startedAt)
  })

  const tick = setInterval(() => {
    if (finished || torrent.destroyed) { clearInterval(tick); return }

    row.bar.style.width = `${(torrent.progress * 100).toFixed(1)}%`
    row.li.dataset.downloaded = String(torrent.downloaded)
    row.li.dataset.progress = String(torrent.progress)

    if (!row.details.hidden) renderDetails(torrent, row, startedAt)

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
      `ETA ${formatDuration(eta)} · ` +
      `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`
    setRowState(row, torrent.numPeers === 0 ? 'waiting for server…' : 'downloading')

    if (Date.now() - lastTouch > TOUCH_INTERVAL_MS) {
      lastTouch = Date.now()
      touchDownload(entryPath)
    }

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

/**
 * Three ways to get a completed download onto disk, tried in order of how
 * little memory they use — none of them build a single in-memory Blob sized
 * to the whole file, except the last-resort fallback:
 *
 *  1. File System Access API (`showSaveFilePicker`): streams straight from
 *     the OPFS piece store to the chosen file with a small, bounded memory
 *     footprint, and gives a real completion promise — safe to reclaim the
 *     piece store the instant it resolves.
 *  2. WebTorrent's own service worker + an `<a download>` click: streams to
 *     the browser's native download with no Blob ever created (this is what
 *     actually fixes Safari, whose Blob size limit is the reason a whole
 *     download can OOM there). There is no JS-visible "finished" signal for
 *     an anchor-triggered download, so the piece store is reclaimed after a
 *     grace period instead of immediately (see completeSave / PENDING_
 *     CLEANUP_DELAY_MS) — reconcileDownloads() finishes the job if the tab
 *     closes before the timer fires.
 *  3. Both of the above need a secure context (HTTPS or localhost); on plain
 *     HTTP a Blob is the only remaining option. Building it from the file's
 *     individual chunks — rather than calling file.blob(), which internally
 *     calls arrayBuffer() and copies everything into one contiguous buffer
 *     first — skips that extra full-size copy, though the total memory
 *     footprint is still proportional to the file size; there's no way
 *     around that without a secure context (see the README).
 */
async function saveFile (torrent: WTTorrent, row: DownloadRow, entryPath: string): Promise<void> {
  setRowState(row, 'saving…')
  row.bar.style.width = '100%'
  try {
    const file = torrent.files[0]
    if (!file) throw new Error('torrent has no files')

    if (window.showSaveFilePicker) {
      console.debug('[p2f] save tier 1: File System Access API')
      const handle = await window.showSaveFilePicker({ suggestedName: file.name })
      const writable = await handle.createWritable()
      await file.stream().pipeTo(writable)
      completeSave(torrent, row, entryPath, true)
    } else if (streamServer) {
      console.debug('[p2f] save tier 2: service worker stream, url =', file.streamURL)
      // No `download` attribute here: the service worker's response already
      // carries Content-Disposition: attachment (server.js forces it for
      // "document"-destination requests) to trigger the save. Setting the
      // HTML attribute *as well* makes Chromium cancel the download outright
      // — two competing "force download" signals on the same navigation.
      // WebTorrent's own example UI does the same (a plain <a href>).
      clickDownloadLink(file.streamURL)
      completeSave(torrent, row, entryPath, false)
    } else {
      console.debug('[p2f] save tier 3: chunked blob fallback')
      const chunks: Uint8Array<ArrayBuffer>[] = []
      for await (const chunk of file) chunks.push(chunk as Uint8Array<ArrayBuffer>)
      const url = URL.createObjectURL(new Blob(chunks, { type: file.type }))
      // blob: URLs carry no headers at all, so this one does need `download`.
      clickDownloadLink(url, file.name)
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      completeSave(torrent, row, entryPath, true)
    }
  } catch (err) {
    // The torrent (and its OPFS pieces) is left intact on failure — e.g. the
    // user cancelled a save-as dialog — so reloading the page picks the
    // already-complete download back up and offers to save it again.
    setRowState(row, `save failed: ${errMessage(err)}`, 'error')
  }
  activeDownloads.delete(entryPath)
}

function clickDownloadLink (href: string, filename?: string): void {
  const a = document.createElement('a')
  a.href = href
  if (filename) a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
}

function completeSave (
  torrent: WTTorrent,
  row: DownloadRow,
  entryPath: string,
  immediateCleanup: boolean
): void {
  setRowState(row, 'done', 'done')
  row.stats.textContent = formatBytes(torrent.length)
  row.cancelBtn.textContent = 'Clear'

  if (immediateCleanup) {
    forgetDownload(entryPath)
    torrent.destroy({ destroyStore: true })
    return
  }
  touchDownload(entryPath, { pendingCleanup: true })
  setTimeout(() => {
    if (!torrent.destroyed) torrent.destroy({ destroyStore: true })
    forgetDownload(entryPath)
  }, PENDING_CLEANUP_DELAY_MS)
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

function formatDuration (ms: number): string {
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

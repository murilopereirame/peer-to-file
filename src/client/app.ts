// Browser client for peer-to-file. Compiled with tsc to public/app.js.
// Uses the WebTorrent browser bundle loaded globally from /vendor/.

interface WTFile {
  name: string
  length: number
  blob (): Promise<Blob>
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
  destroyed: boolean
  files: WTFile[]
  on (event: string, fn: (...args: unknown[]) => void): void
  addWebSeed (url: string): void
  destroy (): void
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

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`missing element ${sel}`)
  return el
}

const connectForm = $<HTMLFormElement>('#connect-form')
const serverInput = $<HTMLInputElement>('#server-input')
const connStatus = $('#conn-status')
const browserSection = $('#browser')
const breadcrumbEl = $('#breadcrumb')
const listingEl = $('#listing')
const downloadsPanel = $('#downloads-panel')
const downloadsEl = $('#downloads')

let apiBase: string | null = null
let currentPath = ''

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

async function apiFetch (pathname: string): Promise<Response> {
  if (!apiBase) throw new Error('not connected')
  const res = await fetch(`${apiBase}${pathname}`)
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json() as { error?: string }
      if (body.error) detail = body.error
    } catch { /* non-JSON error body */ }
    throw new Error(detail)
  }
  return res
}

async function connect (address: string, quiet = false): Promise<void> {
  const base = normalizeServer(address)
  if (!quiet) setStatus('connecting…')
  try {
    const res = await fetch(`${base}/api/info`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const info = await res.json() as { name?: string, version?: string }
    if (info.name !== 'peer-to-file') throw new Error('not a peer-to-file server')
    apiBase = base
    localStorage.setItem('p2f-server', address.trim())
    setStatus(`connected to ${base} (v${info.version ?? '?'})`, 'ok')
    browserSection.hidden = false
    await loadListing('')
  } catch (err) {
    if (!quiet) setStatus(`connection failed: ${errMessage(err)}`, 'error')
    throw err
  }
}

interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
}

async function loadListing (path: string): Promise<void> {
  const res = await apiFetch(`/api/list?path=${encodeURIComponent(path)}`)
  const listing = await res.json() as { path: string, entries: DirEntry[] }
  currentPath = listing.path
  renderBreadcrumb()
  renderListing(listing.entries)
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

interface DownloadRow {
  li: HTMLLIElement
  bar: HTMLDivElement
  stats: HTMLSpanElement
  state: HTMLSpanElement
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

  li.append(title, bar, stats, state)
  downloadsEl.prepend(li)
  return { li, bar: fill, stats, state }
}

async function startDownload (entryPath: string, name: string): Promise<void> {
  if (activeDownloads.has(entryPath)) return
  activeDownloads.add(entryPath)
  const row = createDownloadRow(name)
  row.li.dataset.path = entryPath
  row.li.dataset.state = 'preparing'

  try {
    // The server hashes the file on first request — may take a while for
    // large files, hence the "preparing" state.
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

    client.add(torrentFile, {}, torrent => {
      trackTorrent(torrent, meta.webseed, row, entryPath)
    })
  } catch (err) {
    row.state.textContent = `failed: ${errMessage(err)}`
    row.state.className = 'dl-state error'
    row.li.dataset.state = 'error'
    activeDownloads.delete(entryPath)
  }
}

function trackTorrent (
  torrent: WTTorrent,
  webseed: string,
  row: DownloadRow,
  entryPath: string
): void {
  row.li.dataset.state = 'downloading'
  let finished = false
  let lastWebseedRetry = 0

  const tick = setInterval(() => {
    if (finished || torrent.destroyed) { clearInterval(tick); return }

    row.bar.style.width = `${(torrent.progress * 100).toFixed(1)}%`
    row.stats.textContent =
      `${(torrent.progress * 100).toFixed(1)}% · ` +
      `${formatBytes(torrent.downloaded)} / ${formatBytes(torrent.length)} · ` +
      `${formatBytes(torrent.downloadSpeed)}/s · ` +
      `ETA ${formatEta(torrent.timeRemaining)} · ` +
      `${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'}`
    row.state.textContent = torrent.numPeers === 0 ? 'waiting for server…' : 'downloading'
    row.li.dataset.downloaded = String(torrent.downloaded)
    row.li.dataset.progress = String(torrent.progress)

    // Resume watchdog. The WebRTC path re-establishes itself via tracker
    // re-announce; the webseed connection is not re-added by WebTorrent after
    // it dies, so when all sources are gone, re-attach it. Only the missing
    // pieces are requested — progress is kept.
    if (torrent.numPeers === 0 && Date.now() - lastWebseedRetry > 5000) {
      lastWebseedRetry = Date.now()
      try { torrent.addWebSeed(webseed) } catch { /* already attached */ }
    }
  }, 500)

  torrent.on('done', () => {
    if (finished) return
    finished = true
    clearInterval(tick)
    void saveFile(torrent, row, entryPath)
  })

  torrent.on('error', (err: unknown) => {
    clearInterval(tick)
    row.state.textContent = `failed: ${errMessage(err)}`
    row.state.className = 'dl-state error'
    row.li.dataset.state = 'error'
    activeDownloads.delete(entryPath)
  })
}

async function saveFile (torrent: WTTorrent, row: DownloadRow, entryPath: string): Promise<void> {
  row.state.textContent = 'saving…'
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

    row.state.textContent = 'done'
    row.state.className = 'dl-state done'
    row.stats.textContent = formatBytes(torrent.length)
    row.li.dataset.state = 'done'
    torrent.destroy() // free the in-memory piece store
  } catch (err) {
    row.state.textContent = `save failed: ${errMessage(err)}`
    row.state.className = 'dl-state error'
    row.li.dataset.state = 'error'
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

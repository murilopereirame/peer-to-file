// Standalone logs page for peer-to-file. Compiled with tsc to public/logs.js.
// Opened in its own tab (see the "View logs" link in the main app); shares
// the main app's session cookie (same origin), so no separate login here —
// if the session is gone, this page just says so and points back.
//
// Wrapped in an IIFE: this file has no import/export, so without it every
// top-level name here would live in the same global scope TypeScript gives
// app.ts (both are loaded as plain classic scripts, not modules), colliding
// with app.ts's own $/connStatus/apiBase/etc.
(function () {
  interface LogEntry {
    id: number
    ts: number
    kind: string
    message: string
  }

  const $ = <T extends HTMLElement>(sel: string): T => {
    const el = document.querySelector<T>(sel)
    if (!el) throw new Error(`missing element ${sel}`)
    return el
  }

  const connStatus = $('#conn-status')
  const kindFilter = $<HTMLSelectElement>('#kind-filter')
  const autoRefresh = $<HTMLInputElement>('#auto-refresh')
  const clearViewBtn = $<HTMLButtonElement>('#clear-view')
  const logList = $<HTMLUListElement>('#log-list')

  const MAX_ENTRIES = 500
  const POLL_INTERVAL_MS = 4000

  let apiBase: string | null = null
  let sinceId: number | undefined
  let entries: LogEntry[] = []

  function setStatus (msg: string, kind: '' | 'ok' | 'error' = ''): void {
    connStatus.textContent = msg
    connStatus.className = `status ${kind}`
  }

  function normalizeServer (input: string): string {
    let addr = input.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(addr)) {
      const scheme = location.protocol === 'https:' ? 'https' : 'http'
      addr = `${scheme}://${addr}`
    }
    return addr
  }

  function render (): void {
    const filter = kindFilter.value
    logList.replaceChildren()

    const visible = filter ? entries.filter(e => e.kind === filter) : entries
    if (visible.length === 0) {
      const li = document.createElement('li')
      li.className = 'empty'
      li.textContent = entries.length === 0 ? 'no activity yet' : 'no entries match this filter'
      logList.append(li)
      return
    }

    for (const entry of visible) {
      const li = document.createElement('li')

      const time = document.createElement('span')
      time.className = 'log-time'
      time.textContent = new Date(entry.ts).toLocaleTimeString()

      const kind = document.createElement('span')
      kind.className = 'log-kind'
      kind.textContent = entry.kind

      const msg = document.createElement('span')
      msg.className = 'log-msg'
      msg.textContent = entry.message

      li.append(time, kind, msg)
      logList.append(li)
    }
  }

  async function poll (): Promise<void> {
    if (!apiBase) return
    try {
      const url = new URL('/api/logs', apiBase)
      url.searchParams.set('limit', '200')
      if (sinceId !== undefined) url.searchParams.set('sinceId', String(sinceId))
      const res = await fetch(url, { credentials: 'include' })
      if (res.status === 401) {
        setStatus('signed out — sign in on the main tab, then reload this page', 'error')
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { entries: LogEntry[] }
      if (body.entries.length > 0) {
        // Both the initial and incremental fetches come back newest-first, and
        // sinceId guarantees every entry in this batch is newer than anything
        // already held, so prepending preserves overall newest-first order.
        entries = [...body.entries, ...entries].slice(0, MAX_ENTRIES)
        sinceId = Math.max(sinceId ?? 0, ...body.entries.map(e => e.id))
        render()
      }
      setStatus(`connected to ${apiBase}`, 'ok')
    } catch (err) {
      setStatus(`connection failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  kindFilter.addEventListener('change', render)
  clearViewBtn.addEventListener('click', () => {
    entries = []
    render()
  })

  const saved = localStorage.getItem('p2f-server')
  if (saved) {
    apiBase = normalizeServer(saved)
  } else if (location.protocol.startsWith('http')) {
    apiBase = normalizeServer(location.host)
  }

  if (apiBase) {
    setStatus('connecting…')
    void poll()
    setInterval(() => {
      if (autoRefresh.checked) void poll()
    }, POLL_INTERVAL_MS)
  } else {
    setStatus('no server known — open the main app first', 'error')
  }
})()

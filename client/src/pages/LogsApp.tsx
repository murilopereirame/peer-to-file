import { useEffect, useRef, useState } from 'react'

interface LogEntry {
  id: number
  ts: number
  kind: string
  message: string
}

const MAX_ENTRIES = 500
const POLL_INTERVAL_MS = 4000
// Same origin as the main app — see App.tsx.
const API_BASE = `${location.protocol}//${location.host}`

export function LogsApp (): React.JSX.Element {
  const [status, setStatus] = useState<{ msg: string, kind: '' | 'ok' | 'error' }>({ msg: '', kind: '' })
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [kindFilter, setKindFilter] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const sinceIdRef = useRef<number | undefined>(undefined)
  const entriesRef = useRef<LogEntry[]>([])
  entriesRef.current = entries
  const autoRefreshRef = useRef(autoRefresh)
  autoRefreshRef.current = autoRefresh

  const poll = async (): Promise<void> => {
    try {
      const url = new URL('/api/logs', API_BASE)
      url.searchParams.set('limit', '200')
      if (sinceIdRef.current !== undefined) url.searchParams.set('sinceId', String(sinceIdRef.current))
      const res = await fetch(url, { credentials: 'include' })
      if (res.status === 401) {
        setStatus({ msg: 'signed out — sign in on the main tab, then reload this page', kind: 'error' })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { entries: LogEntry[] }
      if (body.entries.length > 0) {
        // Both the initial and incremental fetches come back newest-first, and
        // sinceId guarantees every entry in this batch is newer than anything
        // already held, so prepending preserves overall newest-first order.
        const merged = [...body.entries, ...entriesRef.current].slice(0, MAX_ENTRIES)
        entriesRef.current = merged
        setEntries(merged)
        sinceIdRef.current = Math.max(sinceIdRef.current ?? 0, ...body.entries.map(e => e.id))
      }
      setStatus({ msg: 'connected', kind: 'ok' })
    } catch (err) {
      setStatus({ msg: `connection failed: ${err instanceof Error ? err.message : String(err)}`, kind: 'error' })
    }
  }

  useEffect(() => {
    setStatus({ msg: 'connecting…', kind: '' })
    void poll()
    const interval = setInterval(() => {
      if (autoRefreshRef.current) void poll()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
    // runs once on mount
  }, [])

  const visible = kindFilter ? entries.filter(e => e.kind === kindFilter) : entries

  const downloadLogs = (): void => {
    const lines = visible.map(e => `[${new Date(e.ts).toISOString()}] ${e.kind.toUpperCase()}: ${e.message}`)
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `p2file-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-row logs-header">
          <div className="brand">
            <span className="logo">🧲</span>
            <div>
              <h1>P2File — Logs</h1>
              <span className="tagline">server activity</span>
            </div>
          </div>
          <a href="/">&larr; back to browser</a>
        </div>
        <div id="conn-status" className={`status ${status.kind}`}>{status.msg}</div>
      </header>

      <main>
        <section className="card">
          <section id="logs-controls">
            <label>
              kind
              <select id="kind-filter" value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
                <option value="">all</option>
                <option value="connection">connections</option>
                <option value="tracker">tracker</option>
                <option value="torrent">torrent requests</option>
                <option value="webseed">webseed</option>
                <option value="auth">auth</option>
                <option value="server">server</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox" id="auto-refresh" checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
              />
              auto-refresh
            </label>
            <button id="clear-view" type="button" onClick={() => setEntries([])}>Clear view</button>
            <button id="download-logs" type="button" disabled={visible.length === 0} onClick={downloadLogs}>
              Download logs
            </button>
          </section>

          <ul id="log-list">
            {visible.length === 0 && (
              <li className="empty">{entries.length === 0 ? 'no activity yet' : 'no entries match this filter'}</li>
            )}
            {visible.map(entry => (
              <li key={entry.id}>
                <span className="log-time">{new Date(entry.ts).toLocaleTimeString()}</span>
                <span className="log-kind">{entry.kind}</span>
                <span className="log-msg">{entry.message}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}

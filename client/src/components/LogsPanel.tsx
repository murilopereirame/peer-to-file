import { useEffect, useRef, useState } from 'react'
import { useToast } from '../context/ToastContext'

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

const KIND_OPTIONS: Array<{ value: string, label: string }> = [
  { value: '', label: 'all' },
  { value: 'connection', label: 'connections' },
  { value: 'tracker', label: 'tracker' },
  { value: 'torrent', label: 'torrent requests' },
  { value: 'webseed', label: 'webseed' },
  { value: 'browse', label: 'browse' },
  { value: 'auth', label: 'auth' },
  { value: 'server', label: 'server' }
]

export function LogsPanel (): React.JSX.Element {
  const notify = useToast()
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
        setStatus({ msg: 'signed out — sign in again to keep viewing logs', kind: 'error' })
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

  const onExport = (): void => {
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
    notify('Logs exported to your downloads folder')
  }

  return (
    <section className="card">
      {status.msg && <div id="conn-status" className={`status ${status.kind}`}>{status.msg}</div>}
      <section id="logs-controls">
        <label>
          kind
          <select id="kind-filter" value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
            {KIND_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
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
        <button id="export-logs" type="button" disabled={visible.length === 0} onClick={onExport}>
          Export logs
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
  )
}

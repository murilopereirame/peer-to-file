import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, formatDateTime, type LogEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { Button, ErrorText } from '../components/Primitives'
import { DownloadIcon, RefreshIcon, SearchIcon, TerminalIcon } from '../components/icons'

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

export function LogsScreen (): React.JSX.Element {
  const app = useApp()
  const notify = useToast()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [error, setError] = useState('')
  const [kindFilter, setKindFilter] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!app.client) return
    setError('')
    try {
      const res = await withUnauthorizedRetry(app, () => app.client!.logs({ limit: 200 }))
      setEntries(res.entries)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [app])

  useEffect(() => { void load() }, [load])

  const visible = kindFilter ? entries.filter(e => e.kind === kindFilter) : entries

  const onExport = (): void => {
    const text = visible.map(e => `[${formatDateTime(e.ts)}] ${e.kind}: ${e.message}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `p2f-logs-${Date.now()}.txt`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    notify('Logs exported to your downloads folder')
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">
          <TerminalIcon size={15} />
          Server activity
          {visible.length > 0 && <span className="muted-count">{visible.length}</span>}
        </span>
      </div>

      <div className="log-controls">
        <label htmlFor="kind-filter">
          kind
          <select
            id="kind-filter" className="input" value={kindFilter}
            onChange={e => setKindFilter(e.target.value)}
          >
            {KIND_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>
        <div className="spacer" />
        <Button variant="secondary" className="sm" onClick={() => { void load() }}>
          <RefreshIcon size={13} />Refresh
        </Button>
        <Button variant="secondary" className="sm" disabled={visible.length === 0} onClick={onExport}>
          <DownloadIcon size={13} />Export logs
        </Button>
      </div>

      {error !== '' && <div className="card-body"><ErrorText>{error}</ErrorText></div>}

      {visible.length === 0 && (
        <div className="empty">
          <SearchIcon className="empty-icon" size={26} />
          {entries.length === 0 ? 'No activity recorded yet.' : 'No entries match this filter.'}
        </div>
      )}
      {visible.map(e => (
        <div key={e.id} className="log-row">
          <span className="log-time">{formatDateTime(e.ts)}</span>
          <span className="log-kind">{e.kind}</span>
          <span className="log-msg">{e.message}</span>
        </div>
      ))}
    </div>
  )
}

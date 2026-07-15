import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, formatDateTime, type LogEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { Button, Card, ErrorText, Muted, Title } from '../components/Primitives'

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
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <Title>Activity logs</Title>
        <Button variant="secondary" onClick={() => { void load() }}>Refresh</Button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
        <label htmlFor="kind-filter" className="muted">kind</label>
        <select id="kind-filter" className="input" style={{ width: 'auto' }} value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
          {KIND_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      </div>
      <ErrorText>{error}</ErrorText>
      {visible.length === 0 && (
        <Muted>{entries.length === 0 ? 'No activity recorded yet.' : 'No entries match this filter.'}</Muted>
      )}
      {visible.map(e => (
        <Card key={e.id} style={{ marginBottom: 6, padding: 10 }}>
          <div className="muted" style={{ fontSize: 11 }}>{formatDateTime(e.ts)} · {e.kind}</div>
          <div style={{ fontSize: 13 }}>{e.message}</div>
        </Card>
      ))}
      {visible.length > 0 && <Button variant="secondary" onClick={onExport}>Export logs</Button>}
    </div>
  )
}

import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, formatDateTime, type LogEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { Button, Card, ErrorText, Muted, Title } from '../components/Primitives'

export function LogsScreen (): React.JSX.Element {
  const app = useApp()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [error, setError] = useState('')

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

  const onExport = (): void => {
    const text = entries.map(e => `[${formatDateTime(e.ts)}] ${e.kind}: ${e.message}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `p2f-logs-${Date.now()}.txt`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>Activity logs</Title>
        <Button variant="secondary" onClick={() => { void load() }}>Refresh</Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {entries.length === 0 && <Muted>No activity recorded yet.</Muted>}
      {entries.map(e => (
        <Card key={e.id} style={{ marginBottom: 6, padding: 10 }}>
          <div className="muted" style={{ fontSize: 11 }}>{formatDateTime(e.ts)} · {e.kind}</div>
          <div style={{ fontSize: 13 }}>{e.message}</div>
        </Card>
      ))}
      {entries.length > 0 && <Button variant="secondary" onClick={onExport}>Export logs</Button>}
    </div>
  )
}

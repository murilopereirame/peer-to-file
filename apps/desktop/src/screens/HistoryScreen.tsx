import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, formatBytes, formatDateTime, formatDuration, type HistoryEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useDownloads } from '../context/DownloadsContext'
import { useToast } from '../context/ToastContext'
import { Button, Card, ErrorText, Muted, Title } from '../components/Primitives'

function averageSpeed (length: number, durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null
  return `${formatBytes(length / (durationMs / 1000))}/s`
}

export function HistoryScreen (): React.JSX.Element {
  const app = useApp()
  const { downloads } = useDownloads()
  const notify = useToast()
  const doneCount = downloads.filter(d => d.status === 'done').length
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!app.client) return
    setError('')
    try {
      const res = await withUnauthorizedRetry(app, () => app.client!.historyList())
      setEntries(res.entries)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [app])

  useEffect(() => { void load() }, [load, doneCount])

  const onClear = async (): Promise<void> => {
    if (!app.client) return
    await withUnauthorizedRetry(app, () => app.client!.historyClear())
    await load()
    notify('Download history cleared')
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <Title>Download history</Title>
        {entries.length > 0 && <Button variant="secondary" onClick={() => { void onClear() }}>Clear history</Button>}
      </div>
      <ErrorText>{error}</ErrorText>
      {entries.length === 0 && <Muted>No finished downloads yet.</Muted>}
      {entries.map(e => {
        const avgSpeed = averageSpeed(e.length, e.duration_ms)
        return (
          <Card key={e.id} style={{ marginBottom: 8 }}>
            <strong>{e.name}</strong>
            <Muted>
              {formatBytes(e.length)} · {formatDateTime(e.completed_at)}
              {e.duration_ms ? ` · took ${formatDuration(e.duration_ms)}` : ''}
              {avgSpeed ? ` · ${avgSpeed} avg` : ''}
            </Muted>
            {e.info_hash && <Muted style={{ wordBreak: 'break-all', fontSize: 11 }}>Info hash: {e.info_hash}</Muted>}
          </Card>
        )
      })}
    </div>
  )
}

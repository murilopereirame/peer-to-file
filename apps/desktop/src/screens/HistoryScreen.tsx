import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, formatBytes, formatDateTime, type HistoryEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useDownloads } from '../context/DownloadsContext'
import { Button, Card, ErrorText, Muted, Title } from '../components/Primitives'

export function HistoryScreen (): React.JSX.Element {
  const app = useApp()
  const { downloads } = useDownloads()
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
  }

  return (
    <div>
      <Title>Download history</Title>
      <ErrorText>{error}</ErrorText>
      {entries.length === 0 && <Muted>No finished downloads yet.</Muted>}
      {entries.map((e, i) => (
        <Card key={`${e.path}-${e.finishedAt}-${i}`} style={{ marginBottom: 8 }}>
          <strong>{e.name}</strong>
          <Muted>{formatBytes(e.length)} · {formatDateTime(e.finishedAt)}</Muted>
        </Card>
      ))}
      {entries.length > 0 && <Button variant="secondary" onClick={() => { void onClear() }}>Clear history</Button>}
    </div>
  )
}

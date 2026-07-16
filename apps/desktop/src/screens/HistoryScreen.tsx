import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, formatBytes, formatDateTime, formatDuration, type HistoryEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useDownloads } from '../context/DownloadsContext'
import { useUploads } from '../context/UploadsContext'
import { useToast } from '../context/ToastContext'
import { Button, Card, ErrorText, Muted, Title } from '../components/Primitives'

function averageSpeed (length: number, durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null
  return `${formatBytes(length / (durationMs / 1000))}/s`
}

function TransferHistoryList ({
  title, kind, refreshSignal, showInfoHash
}: {
  title: string
  kind: 'download' | 'upload'
  refreshSignal: number
  showInfoHash: boolean
}): React.JSX.Element {
  const app = useApp()
  const notify = useToast()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!app.client) return
    setError('')
    try {
      const res = kind === 'download'
        ? await withUnauthorizedRetry(app, () => app.client!.historyList())
        : await withUnauthorizedRetry(app, () => app.client!.uploadHistoryList())
      setEntries(res.entries)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [app, kind])

  useEffect(() => { void load() }, [load, refreshSignal])

  const onClear = async (): Promise<void> => {
    if (!app.client) return
    if (kind === 'download') await withUnauthorizedRetry(app, () => app.client!.historyClear())
    else await withUnauthorizedRetry(app, () => app.client!.uploadHistoryClear())
    await load()
    notify(`${title} cleared`)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {entries.length > 0 && <Button variant="secondary" onClick={() => { void onClear() }}>Clear</Button>}
      </div>
      <ErrorText>{error}</ErrorText>
      {entries.length === 0 && <Muted>Nothing here yet.</Muted>}
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
            {showInfoHash && e.info_hash && <Muted style={{ wordBreak: 'break-all', fontSize: 11 }}>Info hash: {e.info_hash}</Muted>}
          </Card>
        )
      })}
    </div>
  )
}

export function HistoryScreen (): React.JSX.Element {
  const { downloads } = useDownloads()
  const { uploads } = useUploads()
  const doneDownloads = downloads.filter(d => d.status === 'done').length
  const doneUploads = uploads.filter(u => u.status === 'done').length

  return (
    <div>
      <Title>History</Title>
      <TransferHistoryList title="Downloads" kind="download" refreshSignal={doneDownloads} showInfoHash />
      <div style={{ marginTop: 24 }}>
        <TransferHistoryList title="Uploads" kind="upload" refreshSignal={doneUploads} showInfoHash={false} />
      </div>
    </div>
  )
}

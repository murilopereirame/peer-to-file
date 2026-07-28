import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, formatBytes, formatDateTime, formatDuration, type HistoryEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useDownloads } from '../context/DownloadsContext'
import { useUploads } from '../context/UploadsContext'
import { useToast } from '../context/ToastContext'
import { Button, ErrorText } from '../components/Primitives'
import { ClockIcon, DownloadIcon, GaugeIcon, HistoryIcon, TrashIcon, UploadIcon } from '../components/icons'

function averageSpeed (length: number, durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null
  return `${formatBytes(length / (durationMs / 1000))}/s`
}

function TransferHistoryList ({
  title, icon, kind, refreshSignal, showInfoHash
}: {
  title: string
  icon: React.ReactNode
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
    <div className="card">
      <div className="card-head">
        <span className="card-title">
          {icon}
          {title}
          {entries.length > 0 && <span className="muted-count">{entries.length}</span>}
        </span>
        {entries.length > 0 && (
          <Button variant="secondary" className="sm" onClick={() => { void onClear() }}>
            <TrashIcon size={13} />Clear
          </Button>
        )}
      </div>
      {error !== '' && <div className="card-body"><ErrorText>{error}</ErrorText></div>}
      {entries.length === 0 && (
        <div className="empty">
          <HistoryIcon className="empty-icon" size={26} />
          Nothing here yet.
        </div>
      )}
      {entries.map(e => {
        const avgSpeed = averageSpeed(e.length, e.duration_ms)
        return (
          <div key={e.id} className="history-row">
            <div className="history-main">
              <div className="history-name">{e.name}</div>
              <div className="history-meta">
                <span>{formatDateTime(e.completed_at)}</span>
                {e.duration_ms ? <span><ClockIcon size={12} /> took {formatDuration(e.duration_ms)}</span> : null}
                {avgSpeed !== null ? <span><GaugeIcon size={12} /> {avgSpeed} avg</span> : null}
              </div>
              {showInfoHash && e.info_hash && <div className="history-hash">{e.info_hash}</div>}
            </div>
            <span className="history-size">{formatBytes(e.length)}</span>
          </div>
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
    <>
      <TransferHistoryList
        title="Download history" icon={<DownloadIcon size={15} />}
        kind="download" refreshSignal={doneDownloads} showInfoHash
      />
      <TransferHistoryList
        title="Upload history" icon={<UploadIcon size={15} />}
        kind="upload" refreshSignal={doneUploads} showInfoHash={false}
      />
    </>
  )
}

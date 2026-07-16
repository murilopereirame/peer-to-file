import { useEffect, useRef, useState } from 'react'
import { notifyOS } from '@p2f/shared'
import type { DownloadEntry, DownloadManager } from '../lib/downloadManager'
import { useUploads } from '../context/UploadsContext'
import { useToast } from '../context/ToastContext'
import { FileBrowser } from './FileBrowser'
import { DownloadsPanel } from './DownloadsPanel'
import { UploadPanel } from './UploadPanel'
import { HistoryPanel } from './HistoryPanel'
import { UploadHistoryPanel } from './UploadHistoryPanel'
import { LogsPanel } from './LogsPanel'

type Tab = 'browse' | 'transfers' | 'history' | 'logs'

const TABS: Array<{ key: Tab, label: string }> = [
  { key: 'browse', label: 'Browse' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'history', label: 'History' },
  { key: 'logs', label: 'Logs' }
]

/** Fires a toast + OS notification exactly once per download the moment it finishes, regardless of which tab is active. */
function useDownloadCompletionNotifier (downloads: DownloadEntry[]): void {
  const notify = useToast()
  const notifiedRef = useRef(new Set<string>())

  useEffect(() => {
    const current = new Set(downloads.map(d => d.path))
    for (const seen of notifiedRef.current) {
      if (!current.has(seen)) notifiedRef.current.delete(seen)
    }
    for (const d of downloads) {
      if (d.status === 'done' && !notifiedRef.current.has(d.path)) {
        notifiedRef.current.add(d.path)
        notify(`"${d.name}" finished downloading`)
        notifyOS('Download complete', d.name)
      }
    }
  }, [downloads, notify])
}

export function BrowserApp ({
  manager, downloads, doneCount
}: { manager: DownloadManager, downloads: DownloadEntry[], doneCount: number }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('browse')
  const { uploads, dismiss } = useUploads()
  useDownloadCompletionNotifier(downloads)

  const uploadsDoneCount = uploads.filter(u => u.status === 'done').length
  const busyCount = downloads.filter(d => d.status !== 'done' && d.status !== 'error').length +
    uploads.filter(u => u.status === 'uploading').length

  return (
    <>
      <nav className="tab-bar">
        {TABS.map(t => (
          <button key={t.key} type="button" className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}{t.key === 'transfers' && busyCount > 0 ? ` (${busyCount})` : ''}
          </button>
        ))}
      </nav>

      {tab === 'browse' && <FileBrowser manager={manager} />}
      {tab === 'transfers' && (
        <>
          <UploadPanel uploads={uploads} onDismiss={dismiss} />
          <DownloadsPanel entries={downloads} manager={manager} />
        </>
      )}
      {tab === 'history' && (
        <>
          <HistoryPanel refreshSignal={doneCount} />
          <UploadHistoryPanel refreshSignal={uploadsDoneCount} />
        </>
      )}
      {tab === 'logs' && <LogsPanel />}
    </>
  )
}

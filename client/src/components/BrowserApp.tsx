import { useEffect, useMemo, useRef, useState } from 'react'
import { notifyOS } from '@p2f/shared'
import type { DownloadEntry, DownloadManager } from '../lib/downloadManager'
import { useUploads } from '../context/UploadsContext'
import { useToast } from '../context/ToastContext'
import { SPEED_HISTORY_SIZE, useSpeedHistory } from '../hooks/useSpeedHistory'
import { FileBrowser } from './FileBrowser'
import { DownloadsPanel } from './DownloadsPanel'
import { UploadPanel } from './UploadPanel'
import { HistoryPanel } from './HistoryPanel'
import { UploadHistoryPanel } from './UploadHistoryPanel'
import { LogsPanel } from './LogsPanel'
import { Sidebar, type View } from './Sidebar'
import { TopBar } from './TopBar'
import { SpeedChart } from './SpeedChart'
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, RefreshIcon } from './icons'

const VIEW_META: Record<View, { title: string, searchPlaceholder: string }> = {
  browse: { title: 'Files', searchPlaceholder: 'Search this folder…' },
  transfers: { title: 'Transfers', searchPlaceholder: 'Search transfers…' },
  history: { title: 'History', searchPlaceholder: 'Search history…' },
  logs: { title: 'Logs', searchPlaceholder: 'Search log messages…' }
}

/** Fires a toast + OS notification exactly once per download the moment it finishes, regardless of which view is active. */
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
  manager, downloads, doneCount, authed, onLogout, status, onRetry
}: {
  manager: DownloadManager
  downloads: DownloadEntry[]
  doneCount: number
  authed: boolean
  onLogout: () => void
  /** App-level connection status; an error keeps the banner and the sidebar's
   *  offline pill up until a retry succeeds. */
  status: { msg: string, kind: '' | 'ok' | 'error' }
  onRetry: () => void
}): React.JSX.Element {
  const [view, setView] = useState<View>('browse')
  const [search, setSearch] = useState('')
  const { uploads, dismiss } = useUploads()
  useDownloadCompletionNotifier(downloads)

  const uploadsDoneCount = uploads.filter(u => u.status === 'done').length
  const busyCount = downloads.filter(d => d.status !== 'done' && d.status !== 'error').length +
    uploads.filter(u => u.status === 'uploading').length

  // Live totals: WebTorrent's per-download rate for the inbound side, the
  // XHR-derived rate for files being pushed up to the server.
  const downSpeed = useMemo(
    () => downloads.reduce((sum, d) => sum + (d.status === 'downloading' ? d.speedBytesPerSec : 0), 0),
    [downloads]
  )
  const upSpeed = useMemo(
    () => uploads.reduce((sum, u) => sum + (u.status === 'uploading' ? u.speedBytesPerSec : 0), 0),
    [uploads]
  )
  // Sampled app-wide (not per view) so switching views doesn't reset the graph.
  const history = useSpeedHistory('all-transfers', downSpeed, upSpeed)

  const selectView = (next: View): void => {
    setView(next)
    setSearch('')
  }

  const subtitle: Record<View, string> = {
    browse: 'Browse and transfer the server\'s shared folder',
    transfers: busyCount > 0 ? `${busyCount} transfer${busyCount === 1 ? '' : 's'} in flight` : 'Nothing in flight',
    history: 'Transfers this server has finished',
    logs: 'Live server activity'
  }

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onSelect={selectView}
        counts={{ transfers: busyCount }}
        connected={status.kind !== 'error'}
        onReconnect={onRetry}
        authed={authed}
        onLogout={onLogout}
      />

      <div className="app-body">
        <TopBar
          title={VIEW_META[view].title}
          subtitle={subtitle[view]}
          search={search}
          onSearch={setSearch}
          searchPlaceholder={VIEW_META[view].searchPlaceholder}
          downSpeed={downSpeed}
          upSpeed={upSpeed}
        />

        {status.msg !== '' && (
          <div id="conn-status" className={`app-banner status ${status.kind}`}>
            <AlertIcon size={15} />
            {status.msg}
            {status.kind === 'error' && (
              <button type="button" className="btn sm outline" onClick={onRetry}>
                <RefreshIcon size={14} />
                Retry
              </button>
            )}
          </div>
        )}

        <main className="app-main">
          {view === 'browse' && <FileBrowser manager={manager} search={search} />}

          {view === 'transfers' && (
            <>
              <div className="speed-charts">
                <div className="card">
                  <div className="card-body">
                    <SpeedChart
                      label="Download" tone="download" icon={<ArrowDownIcon size={13} />}
                      values={history.map(s => s.down)} capacity={SPEED_HISTORY_SIZE} current={downSpeed}
                    />
                  </div>
                </div>
                <div className="card">
                  <div className="card-body">
                    <SpeedChart
                      label="Upload" tone="upload" icon={<ArrowUpIcon size={13} />}
                      values={history.map(s => s.up)} capacity={SPEED_HISTORY_SIZE} current={upSpeed}
                    />
                  </div>
                </div>
              </div>
              <UploadPanel uploads={uploads} onDismiss={dismiss} search={search} />
              <DownloadsPanel entries={downloads} manager={manager} search={search} />
            </>
          )}

          {view === 'history' && (
            <>
              <HistoryPanel refreshSignal={doneCount} search={search} />
              <UploadHistoryPanel refreshSignal={uploadsDoneCount} search={search} />
            </>
          )}

          {view === 'logs' && <LogsPanel search={search} />}
        </main>
      </div>
    </div>
  )
}

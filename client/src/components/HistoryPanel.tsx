import { useDownloadHistory } from '../hooks/useDownloadHistory'
import { formatBytes, formatDuration } from '../lib/format'
import { useToast } from '../context/ToastContext'

function averageSpeed (length: number, durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null
  return `${formatBytes(length / (durationMs / 1000))}/s`
}

export function HistoryPanel ({ refreshSignal }: { refreshSignal: unknown }): React.JSX.Element {
  const { entries, loading, error, clear } = useDownloadHistory(refreshSignal)
  const notify = useToast()

  const onClear = (): void => {
    if (!window.confirm('Clear your download history? This only affects the history list — nothing on disk is touched.')) return
    void clear().then(() => notify('Download history cleared'))
  }

  return (
    <section id="history-panel" className="card">
      <div className="panel-heading">
        <h2>Download history</h2>
        {entries.length > 0 && <button type="button" onClick={onClear}>Clear history</button>}
      </div>
      {loading && entries.length === 0 && <div className="empty loading">loading…</div>}
      {!loading && error && <div className="empty error">failed to load history: {error}</div>}
      {!loading && !error && entries.length === 0 && <div className="empty">no downloads yet</div>}
      {entries.length > 0 && (
        <ul id="history-list">
          {entries.map(entry => {
            const avgSpeed = averageSpeed(entry.length, entry.duration_ms)
            return (
              <li key={entry.id}>
                <div className="history-name">{entry.name}</div>
                <div className="history-meta">
                  {formatBytes(entry.length)} · {new Date(entry.completed_at).toLocaleString()}
                  {entry.duration_ms ? ` · took ${formatDuration(entry.duration_ms)}` : ''}
                  {avgSpeed ? ` · ${avgSpeed} avg` : ''}
                </div>
                {entry.info_hash && <div className="history-hash">{entry.info_hash}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

import type { HistoryEntry } from '../hooks/useDownloadHistory'
import { formatBytes, formatDuration } from '../lib/format'
import { ClockIcon, GaugeIcon, HistoryIcon, SearchIcon, TrashIcon } from './icons'

function averageSpeed (length: number, durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null
  return `${formatBytes(length / (durationMs / 1000))}/s`
}

/**
 * Shared presentation for the two server-persisted history lists — the
 * download and upload panels differ only in their ids, wording and which
 * hook feeds them.
 */
export function HistoryCard ({
  id, listId, title, icon, emptyText, entries, loading, error, search, onClear, showHash
}: {
  id: string
  listId: string
  title: string
  icon: React.ReactNode
  emptyText: string
  entries: HistoryEntry[]
  loading: boolean
  error: string | null
  search: string
  onClear: () => void
  /** Downloads record an info hash; uploads have none to show. */
  showHash?: boolean
}): React.JSX.Element {
  const query = search.trim().toLowerCase()
  const visible = query === '' ? entries : entries.filter(e => e.name.toLowerCase().includes(query))

  return (
    <section id={id} className="card">
      <div className="card-head">
        <h2 className="card-title">
          {icon}
          {title}
          {entries.length > 0 && <span className="muted-count">{entries.length}</span>}
        </h2>
        {entries.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={onClear}>
            <TrashIcon size={13} />
            Clear history
          </button>
        )}
      </div>

      {loading && entries.length === 0 && <div className="empty loading">loading…</div>}
      {!loading && error && <div className="empty error">failed to load history: {error}</div>}
      {!loading && !error && entries.length === 0 && (
        <div className="empty">
          <HistoryIcon className="empty-icon" size={26} />
          {emptyText}
        </div>
      )}
      {entries.length > 0 && visible.length === 0 && (
        <div className="empty">
          <SearchIcon className="empty-icon" size={26} />
          nothing in this history matches &ldquo;{search.trim()}&rdquo;
        </div>
      )}

      {visible.length > 0 && (
        <ul id={listId}>
          {visible.map(entry => {
            const avgSpeed = averageSpeed(entry.length, entry.duration_ms)
            return (
              <li key={entry.id}>
                <div className="history-main">
                  <div className="history-name">{entry.name}</div>
                  <div className="history-meta">
                    <span>{new Date(entry.completed_at).toLocaleString()}</span>
                    {entry.duration_ms
                      ? <span><ClockIcon size={12} /> took {formatDuration(entry.duration_ms)}</span>
                      : null}
                    {avgSpeed ? <span><GaugeIcon size={12} /> {avgSpeed} avg</span> : null}
                  </div>
                  {showHash && entry.info_hash && <div className="history-hash">{entry.info_hash}</div>}
                </div>
                <span className="history-size">{formatBytes(entry.length)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

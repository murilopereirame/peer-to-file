import type { UploadEntry } from '../context/UploadsContext'
import { formatBytes } from '../lib/format'
import { ArrowUpIcon, CloseIcon, SearchIcon, UploadIcon } from './icons'

const STATE_TONE: Record<UploadEntry['status'], string> = {
  uploading: 'accent',
  done: 'positive',
  error: 'negative'
}

export function UploadPanel ({
  uploads, onDismiss, search = ''
}: {
  uploads: UploadEntry[]
  onDismiss: (id: string) => void
  /** Free-text filter from the top bar; matches the file name. */
  search?: string
}): React.JSX.Element {
  const query = search.trim().toLowerCase()
  const visible = query === '' ? uploads : uploads.filter(u => u.name.toLowerCase().includes(query))

  return (
    <section id="uploads-panel" className="card">
      <div className="card-head">
        <h2 className="card-title">
          <UploadIcon size={15} />
          Uploads
          {uploads.length > 0 && <span className="muted-count">{uploads.length}</span>}
        </h2>
      </div>
      {uploads.length === 0 && (
        <div className="empty">
          <UploadIcon className="empty-icon" size={26} />
          no uploads in flight — drop files onto the Browse view to send some
        </div>
      )}
      {uploads.length > 0 && visible.length === 0 && (
        <div className="empty">
          <SearchIcon className="empty-icon" size={26} />
          no upload matches &ldquo;{search.trim()}&rdquo;
        </div>
      )}
      {visible.length > 0 && (
        <ul id="uploads">
          {[...visible].reverse().map(u => (
            <li key={u.id} data-state={u.status} data-progress={u.progress}>
              <div className="dl-head">
                <span className="dl-name">{u.name}</span>
                {u.status === 'uploading' && <span className="dl-percent">{(u.progress * 100).toFixed(0)}%</span>}
                <span
                  className={`dl-state badge ${STATE_TONE[u.status]} ${u.status === 'uploading' ? '' : u.status}`}
                  title={u.status === 'error' ? u.message : undefined}
                >
                  {u.status === 'error' ? u.message : u.status === 'done' ? 'Done' : 'Uploading'}
                </span>
              </div>

              <div className="dl-bar"><div style={{ width: `${(u.progress * 100).toFixed(1)}%` }} /></div>

              <div className="dl-foot">
                <div className="dl-stats">
                  <span className="stat">
                    <UploadIcon size={13} />
                    {formatBytes(u.loaded)} / {formatBytes(u.size)}
                  </span>
                  {u.status === 'uploading' && (
                    <span className="stat"><ArrowUpIcon size={13} />{formatBytes(u.speedBytesPerSec)}/s</span>
                  )}
                </div>
                <div className="dl-actions">
                  {u.status !== 'uploading' && (
                    <button type="button" className="btn outline sm" onClick={() => onDismiss(u.id)}>
                      <CloseIcon size={13} />
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

import type { UploadEntry } from '../hooks/useUploads'

export function UploadPanel ({
  uploads, onDismiss
}: {
  uploads: UploadEntry[]
  onDismiss: (id: string) => void
}): React.JSX.Element | null {
  if (uploads.length === 0) return null
  return (
    <section id="uploads-panel">
      <h2>Uploads</h2>
      <ul id="uploads">
        {[...uploads].reverse().map(u => (
          <li key={u.id} data-state={u.status}>
            <span className="dl-name">{u.name}</span>
            <div className="dl-bar"><div style={{ width: `${(u.progress * 100).toFixed(1)}%` }} /></div>
            <span className={`dl-state ${u.status === 'error' ? 'error' : u.status === 'done' ? 'done' : ''}`}>
              {u.status === 'error' ? u.message : u.status === 'done' ? 'done' : `${(u.progress * 100).toFixed(0)}%`}
            </span>
            {u.status !== 'uploading' && (
              <button type="button" onClick={() => onDismiss(u.id)}>Dismiss</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

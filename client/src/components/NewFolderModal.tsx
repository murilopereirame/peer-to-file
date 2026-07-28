import { useState } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage, HttpError } from '../lib/format'
import { CloseIcon, FolderPlusIcon } from './icons'

export function NewFolderModal ({
  path, onClose, onCreated
}: {
  /** Folder to create the new folder inside. */
  path: string
  onClose: () => void
  onCreated: (name: string) => void
}): React.JSX.Element {
  const { apiFetch } = useApi()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const trimmed = name.trim()
    if (busy || !trimmed) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        await apiFetch('/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path === '' ? trimmed : `${path}/${trimmed}` })
        })
        onCreated(trimmed)
      } catch (err) {
        setError(err instanceof HttpError && err.status === 409
          ? 'a file or folder already exists there'
          : errMessage(err))
        setBusy(false)
      }
    })()
  }

  return (
    <div className="modal-backdrop" onClick={e => { e.stopPropagation(); onClose() }}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New folder">
        <div className="modal-head">
          <h2><FolderPlusIcon size={15} /> New folder</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><CloseIcon size={15} /></button>
        </div>

        <div className="modal-content">
          <div className="modal-dest" style={{ marginTop: 0 }}>
            Inside <strong>{path === '' ? '/ (root)' : `/${path}`}</strong>
          </div>
          <input
            className="rename-input" style={{ width: '100%', marginTop: '.75rem' }} autoFocus value={name} disabled={busy}
            placeholder="folder name"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
          />
          {error && <div className="entry-error" style={{ marginTop: '.5rem' }}>{error}</div>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn outline" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  )
}

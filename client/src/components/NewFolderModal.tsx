import { useState } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage, HttpError } from '../lib/format'

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
        <h2>New folder</h2>
        <input
          className="rename-input" style={{ width: '100%' }} autoFocus value={name} disabled={busy}
          placeholder="folder name"
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
        />
        {error && <div className="entry-error" style={{ marginTop: '.5rem' }}>{error}</div>}
        <div className="modal-actions" style={{ marginTop: '1rem' }}>
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={busy || !name.trim()} onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage, HttpError } from '../lib/format'
import { CloseIcon, FolderIcon, LevelUpIcon, MoveIcon } from './icons'

interface DirEntry {
  name: string
  type: 'dir' | 'file'
}

export function MoveModal ({
  fromPath, entryName, startPath, onClose, onMoved
}: {
  /** Full path of the entry being moved. */
  fromPath: string
  entryName: string
  /** Folder to open the destination browser in — the entry's current folder. */
  startPath: string
  onClose: () => void
  onMoved: () => void
}): React.JSX.Element {
  const { apiFetch } = useApi()
  const [navPath, setNavPath] = useState(startPath)
  const [dirs, setDirs] = useState<DirEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  const load = useCallback((target: string): void => {
    setNavPath(target)
    setLoading(true)
    setLoadError(null)
    void (async () => {
      try {
        const res = await apiFetch(`/api/list?path=${encodeURIComponent(target)}`)
        const body = await res.json() as { entries: DirEntry[] }
        setDirs(body.entries.filter(e => e.type === 'dir'))
      } catch (err) {
        setLoadError(errMessage(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [apiFetch])

  useEffect(() => { load(startPath) }, [load, startPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const destPath = navPath === '' ? entryName : `${navPath}/${entryName}`
  const isNoop = destPath === fromPath

  const submit = (): void => {
    if (busy || isNoop) return
    setBusy(true)
    setMoveError(null)
    void (async () => {
      try {
        await apiFetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: fromPath, to: destPath })
        })
        onMoved()
      } catch (err) {
        setMoveError(err instanceof HttpError && err.status === 409
          ? 'a file or folder already exists there'
          : errMessage(err))
        setBusy(false)
      }
    })()
  }

  const segments = navPath === '' ? [] : navPath.split('/')

  return (
    <div className="modal-backdrop" onClick={e => { e.stopPropagation(); onClose() }}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Move ${entryName}`}>
        <div className="modal-head">
          <h2><MoveIcon size={15} /> Move &ldquo;{entryName}&rdquo;</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><CloseIcon size={15} /></button>
        </div>

        <div className="modal-content">
          <nav className="breadcrumb-nav" aria-label="destination path">
            <button type="button" onClick={() => load('')}>&#8962; root</button>
            {segments.map((segment, i) => {
              const isLast = i === segments.length - 1
              return (
                <span key={i} style={{ display: 'contents' }}>
                  <span className="sep">/</span>
                  {isLast
                    ? <span className="current">{segment}</span>
                    : <button type="button" onClick={() => load(segments.slice(0, i + 1).join('/'))}>{segment}</button>}
                </span>
              )
            })}
          </nav>

          <ul className="modal-listing">
            {navPath !== '' && (
              <li className="dir up" onClick={() => load(segments.slice(0, -1).join('/'))}>
                <span className="entry-icon"><LevelUpIcon /></span>
                <span className="entry-name">../</span>
              </li>
            )}
            {loading && <li className="empty loading">loading…</li>}
            {!loading && loadError && <li className="empty error">failed to load: {loadError}</li>}
            {!loading && !loadError && dirs?.length === 0 && <li className="empty">no subfolders here</li>}
            {!loading && !loadError && dirs?.map(d => (
              <li key={d.name} className="dir" onClick={() => load(navPath === '' ? d.name : `${navPath}/${d.name}`)}>
                <span className="entry-icon"><FolderIcon /></span>
                <span className="entry-name">{d.name}</span>
              </li>
            ))}
          </ul>

          <div className="modal-dest">
            Move to: <strong>{navPath === '' ? '/ (root)' : `/${navPath}`}</strong>
            {isNoop && <span className="hint-inline"> — already here</span>}
          </div>
          {moveError && <div className="entry-error">{moveError}</div>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn outline" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || isNoop} onClick={submit}>Move here</button>
        </div>
      </div>
    </div>
  )
}

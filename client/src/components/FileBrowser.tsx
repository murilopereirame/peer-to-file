import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { requestNotificationPermission } from '@p2f/shared'
import { useApi } from '../context/ApiContext'
import { errMessage, formatBytes, HttpError } from '../lib/format'
import type { DownloadManager } from '../lib/downloadManager'
import { useUploads } from '../context/UploadsContext'
import { useToast } from '../context/ToastContext'
import { MoveModal } from './MoveModal'
import { NewFolderModal } from './NewFolderModal'
import {
  DownloadIcon, FileIcon, FolderIcon, FolderPlusIcon, LevelUpIcon, MoreIcon, MoveIcon, PencilIcon,
  RefreshIcon, SearchIcon, TrashIcon, UploadIcon
} from './icons'

interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
}

interface Listing {
  path: string
  entries: DirEntry[]
}

export function FileBrowser ({
  manager, search = ''
}: {
  manager: DownloadManager
  /** Free-text filter from the top bar; matches entry names in this folder. */
  search?: string
}): React.JSX.Element {
  const { apiFetch } = useApi()
  const notify = useToast()
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestedPath = useRef('')
  const pathRef = useRef('')
  pathRef.current = path
  // Per-path listing cache: a revisited folder paints instantly from the
  // last-known listing (stale-while-revalidate) instead of flashing back to
  // "loading…" on every navigation.
  const cacheRef = useRef(new Map<string, Listing>())

  const load = useCallback((target: string): void => {
    requestedPath.current = target
    setPath(target)
    setError(null)
    const cached = cacheRef.current.get(target)
    if (cached) {
      setListing(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    void (async () => {
      try {
        const res = await apiFetch(`/api/list?path=${encodeURIComponent(target)}`)
        const body = await res.json() as Listing
        if (requestedPath.current !== target) return // user already navigated elsewhere
        cacheRef.current.set(body.path, body)
        setListing(body)
        setPath(body.path)
        setLoading(false)
      } catch (err) {
        if (requestedPath.current !== target) return
        if (!cached) setError(errMessage(err))
        setLoading(false)
      }
    })()
  }, [apiFetch])

  useEffect(() => { load('') }, [load])

  // Keeps the currently-viewed folder reasonably fresh without the user
  // having to navigate away and back — cache-first load() never blanks the
  // UI, so this is a silent background refresh, not a visible reload.
  useEffect(() => {
    const id = setInterval(() => { load(path) }, 30_000)
    return () => clearInterval(id)
  }, [path, load])

  // Stable identity that still always refreshes whatever folder is currently
  // showing — reads it from a ref rather than taking `path` as a dependency,
  // which would defeat the stability.
  const refresh = useCallback((): void => { load(pathRef.current) }, [load])
  const { start } = useUploads()

  const uploadFiles = (files: FileList | File[]): void => {
    requestNotificationPermission()
    for (const file of files) {
      notify(`Uploading "${file.name}"…`)
      start(pathRef.current, file, refresh)
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [creatingFolder, setCreatingFolder] = useState(false)

  const onDragEnter = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (e: DragEvent): void => { e.preventDefault() }
  const onDragLeave = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files)
  }

  const segments = path === '' ? [] : path.split('/')
  const query = search.trim().toLowerCase()
  const visible = useMemo(
    () => (query === '' ? listing?.entries : listing?.entries.filter(e => e.name.toLowerCase().includes(query))),
    [listing, query]
  )

  return (
    <>
    <section
      id="browser" className={`card${dragging ? ' drag-active' : ''}`}
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      <div className="browser-toolbar">
        <nav id="breadcrumb" aria-label="path">
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
        <div className="toolbar-actions">
          <button type="button" className="btn ghost sm" onClick={() => setCreatingFolder(true)}>
            <FolderPlusIcon size={14} />
            New folder
          </button>
          <button type="button" className="btn ghost sm" onClick={() => load(path)}>
            <RefreshIcon size={14} />
            Refresh
          </button>
          <button type="button" className="btn primary sm" onClick={() => fileInputRef.current?.click()}>
            <UploadIcon size={14} />
            Upload
          </button>
        </div>
        <input
          ref={fileInputRef} type="file" multiple hidden
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            if (e.target.files) uploadFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {dragging && <div className="drop-hint">drop files to upload to {path === '' ? 'root' : path}</div>}

      <div className="listing-head">
        <span>Name</span>
        <span className="num">Size</span>
        <span className="col-mtime">Modified</span>
        <span />
      </div>

      <ul id="listing">
        {path !== '' && (
          <li className="dir up" onClick={() => load(segments.slice(0, -1).join('/'))}>
            <div className="entry-main">
              <span className="entry-icon"><LevelUpIcon /></span>
              <span className="entry-name">../</span>
            </div>
          </li>
        )}
        {loading && <li className="empty loading">loading…</li>}
        {!loading && error && (
          <li className="empty error">
            failed to load folder: {error}{' '}
            <button type="button" className="btn outline sm" onClick={() => load(path)}>
              <RefreshIcon size={13} />
              retry
            </button>
          </li>
        )}
        {!loading && !error && listing?.entries.length === 0 && (
          <li className="empty">
            <FolderIcon className="empty-icon" size={26} />
            empty folder
          </li>
        )}
        {!loading && !error && (listing?.entries.length ?? 0) > 0 && visible?.length === 0 && (
          <li className="empty">
            <SearchIcon className="empty-icon" size={26} />
            nothing in this folder matches &ldquo;{search.trim()}&rdquo;
          </li>
        )}
        {!loading && !error && visible?.map(entry => (
          <ListingRow
            key={entry.name} entry={entry} path={path}
            onOpenDir={load} onChanged={refresh} manager={manager} apiFetch={apiFetch}
          />
        ))}
      </ul>
    </section>
    {creatingFolder && (
      <NewFolderModal
        path={path}
        onClose={() => setCreatingFolder(false)}
        onCreated={(name) => { setCreatingFolder(false); notify(`Created folder "${name}"`); refresh() }}
      />
    )}
    </>
  )
}

function ListingRow ({
  entry, path, onOpenDir, onChanged, manager, apiFetch
}: {
  entry: DirEntry
  path: string
  onOpenDir: (path: string) => void
  onChanged: () => void
  manager: DownloadManager
  apiFetch: ReturnType<typeof useApi>['apiFetch']
}): React.JSX.Element {
  const notify = useToast()
  const entryPath = path === '' ? entry.name : `${path}/${entry.name}`

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(entry.name)
  const [moveOpen, setMoveOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Both Enter (submitRename disables the input via `busy`) and Escape
  // (cancelRename removes the still-focused input) can make the browser
  // fire a native blur as a side effect of the key handler itself — set
  // right before that happens so the input's onBlur (which submits on a
  // genuine click/tab-away) can tell the difference and skip redundant work.
  const keyHandledRef = useRef(false)

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => { document.removeEventListener('click', onDocClick) }
  }, [menuOpen])

  const startRename = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setMenuOpen(false)
    keyHandledRef.current = false
    setRenameValue(entry.name)
    setRowError(null)
    setRenaming(true)
  }

  const cancelRename = (): void => {
    setRenaming(false)
    setRowError(null)
  }

  const submitRename = (): void => {
    if (busy) return
    const trimmed = renameValue.trim()
    if (trimmed === '' || trimmed === entry.name) {
      cancelRename()
      return
    }
    // a bare name renames in place; a value containing "/" moves it — both
    // resolve relative to the folder currently being browsed
    const to = path === '' ? trimmed : `${path}/${trimmed}`
    setBusy(true)
    void (async () => {
      try {
        await apiFetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: entryPath, to })
        })
        setRenaming(false)
        notify(`Renamed to "${trimmed}"`)
        onChanged()
      } catch (err) {
        setRowError(err instanceof HttpError && err.status === 409
          ? 'a file or folder already exists there'
          : errMessage(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const onRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      keyHandledRef.current = true
      submitRename()
    } else if (e.key === 'Escape') {
      keyHandledRef.current = true
      cancelRename()
    }
  }

  const onRenameBlur = (): void => {
    if (keyHandledRef.current) {
      keyHandledRef.current = false
      return
    }
    submitRename()
  }

  const startMove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setMenuOpen(false)
    setRowError(null)
    setMoveOpen(true)
  }

  const deleteEntry = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setMenuOpen(false)
    const kind = entry.type === 'dir' ? 'folder (and everything inside it)' : 'file'
    if (!window.confirm(`Delete this ${kind}?\n\n${entryPath}`)) return
    setBusy(true)
    setRowError(null)
    void (async () => {
      try {
        await apiFetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: entryPath })
        })
        notify(`Deleted "${entry.name}"`)
        onChanged()
      } catch (err) {
        setRowError(errMessage(err))
        setBusy(false)
      }
    })()
  }

  return (
    <li
      className={entry.type}
      onClick={!renaming && entry.type === 'dir' ? () => onOpenDir(entryPath) : undefined}
    >
      <div className="entry-main">
        <span className="entry-icon">{entry.type === 'dir' ? <FolderIcon /> : <FileIcon />}</span>
        {renaming
          ? (
            <input
              className="rename-input" autoFocus value={renameValue} disabled={busy}
              onClick={e => e.stopPropagation()}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={onRenameKeyDown}
              onBlur={onRenameBlur}
            />
            )
          : (
            <span className="entry-text">
              <span className="entry-name">{entry.name}</span>
              {rowError && <span className="entry-error">{rowError}</span>}
            </span>
            )}
      </div>
      <span className="entry-size">{entry.type === 'file' ? formatBytes(entry.size ?? 0) : '—'}</span>
      <span className="entry-mtime">{new Date(entry.mtime).toLocaleDateString()}</span>
      <div className="entry-actions">
        {entry.type === 'file' && (
          <button
            type="button" className="btn outline sm"
            onClick={(e) => {
              e.stopPropagation()
              void manager.start(entryPath, entry.name, apiFetch)
              notify(`Added "${entry.name}" to the download queue`)
            }}
          >
            <DownloadIcon size={13} />
            Download
          </button>
        )}
        <div className="kebab-wrap" ref={menuRef}>
          <button
            type="button" className="kebab-btn icon-btn" disabled={busy} aria-label="more actions" aria-haspopup="true"
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div className="kebab-menu" onClick={e => e.stopPropagation()}>
              <button type="button" onClick={startRename}><PencilIcon size={14} />Rename</button>
              <button type="button" onClick={startMove}><MoveIcon size={14} />Move</button>
              <button type="button" className="danger" onClick={deleteEntry}><TrashIcon size={14} />Delete</button>
            </div>
          )}
        </div>
      </div>
      {moveOpen && (
        <MoveModal
          fromPath={entryPath}
          entryName={entry.name}
          startPath={path}
          onClose={() => setMoveOpen(false)}
          onMoved={() => { setMoveOpen(false); notify(`Moved "${entry.name}"`); onChanged() }}
        />
      )}
    </li>
  )
}

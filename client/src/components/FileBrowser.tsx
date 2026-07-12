import { useEffect, useRef, useState } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage, formatBytes } from '../lib/format'
import type { DownloadManager } from '../lib/downloadManager'

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

export function FileBrowser ({ manager }: { manager: DownloadManager }): React.JSX.Element {
  const { apiFetch } = useApi()
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestedPath = useRef('')

  const load = (target: string): void => {
    // optimistic: show the target location and a loading state right away
    requestedPath.current = target
    setPath(target)
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await apiFetch(`/api/list?path=${encodeURIComponent(target)}`)
        const body = await res.json() as Listing
        if (requestedPath.current !== target) return // user already navigated elsewhere
        setListing(body)
        setPath(body.path)
        setLoading(false)
      } catch (err) {
        if (requestedPath.current !== target) return
        setError(errMessage(err))
        setLoading(false)
      }
    })()
  }

  useEffect(() => { load('') }, [])

  const segments = path === '' ? [] : path.split('/')

  return (
    <section id="browser" className="card">
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

      <ul id="listing">
        {loading && <li className="empty loading">loading…</li>}
        {!loading && error && (
          <li className="empty error">
            failed to load folder: {error}{' '}
            <button type="button" onClick={() => load(path)}>retry</button>
          </li>
        )}
        {!loading && !error && listing?.entries.length === 0 && (
          <li className="empty">empty folder</li>
        )}
        {!loading && !error && listing?.entries.map(entry => (
          <ListingRow key={entry.name} entry={entry} path={path} onOpenDir={load} manager={manager} apiFetch={apiFetch} />
        ))}
      </ul>
    </section>
  )
}

function ListingRow ({
  entry, path, onOpenDir, manager, apiFetch
}: {
  entry: DirEntry
  path: string
  onOpenDir: (path: string) => void
  manager: DownloadManager
  apiFetch: ReturnType<typeof useApi>['apiFetch']
}): React.JSX.Element {
  const entryPath = path === '' ? entry.name : `${path}/${entry.name}`
  const meta = entry.type === 'file'
    ? `${formatBytes(entry.size ?? 0)} · ${new Date(entry.mtime).toLocaleDateString()}`
    : new Date(entry.mtime).toLocaleDateString()

  return (
    <li className={entry.type} onClick={entry.type === 'dir' ? () => onOpenDir(entryPath) : undefined}>
      <span className="entry-icon">{entry.type === 'dir' ? '📁' : '📄'}</span>
      <span className="entry-name">{entry.name}</span>
      <span className="entry-meta">{meta}</span>
      {entry.type === 'file' && (
        <button
          type="button" className="primary"
          onClick={() => { void manager.start(entryPath, entry.name, apiFetch) }}
        >
          Download
        </button>
      )}
    </li>
  )
}

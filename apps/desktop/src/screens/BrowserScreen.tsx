import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  errMessage, formatBytes, formatDateTime, joinPath, parentPath, requestNotificationPermission,
  type DirEntry, type Listing
} from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useDownloads } from '../context/DownloadsContext'
import { useUploads } from '../context/UploadsContext'
import { useToast } from '../context/ToastContext'
import { Button, Card, ErrorText, Input, Muted, Title } from '../components/Primitives'

function Breadcrumbs ({ path, onNavigate }: { path: string, onNavigate: (p: string) => void }): React.JSX.Element {
  const segs = path.split('/').filter(Boolean)
  return (
    <div className="breadcrumbs">
      <a onClick={() => onNavigate('')}>Root</a>
      {segs.map((seg, i) => {
        const target = segs.slice(0, i + 1).join('/')
        const isLast = i === segs.length - 1
        return (
          <span key={target}>
            <span className="sep"> / </span>
            {isLast ? <strong>{seg}</strong> : <a onClick={() => onNavigate(target)}>{seg}</a>}
          </span>
        )
      })}
    </div>
  )
}

function RenameModal ({ entry, onCancel, onConfirm }: { entry: DirEntry | null, onCancel: () => void, onConfirm: (name: string) => Promise<void> }): React.JSX.Element | null {
  const [value, setValue] = useState(entry?.name ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setValue(entry?.name ?? ''); setError('') }, [entry])
  if (!entry) return null
  const confirm = async (): Promise<void> => {
    if (!value.trim()) return
    setBusy(true)
    try { await onConfirm(value.trim()) } catch (err) { setError(errMessage(err)) } finally { setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <Card style={{ width: 380 }}>
        <div onClick={e => e.stopPropagation()}>
          <Title>Rename "{entry.name}"</Title>
          <Input value={value} onChange={e => setValue(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') void confirm() }} />
          <ErrorText>{error}</ErrorText>
          <div className="btn-row">
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button onClick={() => { void confirm() }} loading={busy}>Save</Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function NewFolderModal ({ open, onCancel, onConfirm }: { open: boolean, onCancel: () => void, onConfirm: (name: string) => Promise<void> }): React.JSX.Element | null {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setValue(''); setError('') } }, [open])
  if (!open) return null
  const confirm = async (): Promise<void> => {
    if (!value.trim()) return
    setBusy(true)
    try { await onConfirm(value.trim()) } catch (err) { setError(errMessage(err)) } finally { setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <Card style={{ width: 380 }}>
        <div onClick={e => e.stopPropagation()}>
          <Title>New folder</Title>
          <Input value={value} onChange={e => setValue(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') void confirm() }} placeholder="folder name" />
          <ErrorText>{error}</ErrorText>
          <div className="btn-row">
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button onClick={() => { void confirm() }} loading={busy}>Create</Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function DeleteModal ({ entry, onCancel, onConfirm }: { entry: DirEntry | null, onCancel: () => void, onConfirm: () => Promise<void> }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!entry) return null
  const confirm = async (): Promise<void> => {
    setBusy(true)
    try { await onConfirm() } catch (err) { setError(errMessage(err)); setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <Card style={{ width: 380 }}>
        <div onClick={e => e.stopPropagation()}>
          <Title>Delete "{entry.name}"?</Title>
          <Muted>This is immediate and permanent. If it's a folder, everything inside it is deleted too.</Muted>
          <ErrorText>{error}</ErrorText>
          <div className="btn-row">
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button variant="danger" onClick={() => { void confirm() }} loading={busy}>Delete</Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function MoveModal ({
  entry, startPath, onCancel, onPick
}: { entry: DirEntry | null, startPath: string, onCancel: () => void, onPick: (destDir: string) => Promise<void> }): React.JSX.Element | null {
  const { client } = useApp()
  const [path, setPath] = useState(startPath)
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (p: string): Promise<void> => {
    if (!client) return
    try { setListing(await client.list(p)); setPath(p) } catch (err) { setError(errMessage(err)) }
  }, [client])

  useEffect(() => { if (entry) void load(startPath) }, [entry, startPath, load])

  if (!entry) return null
  const folders = listing?.entries.filter(e => e.type === 'dir') ?? []

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <Card style={{ width: 460, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Title>Move "{entry.name}"</Title>
          <Breadcrumbs path={path} onNavigate={p => { void load(p) }} />
          <ErrorText>{error}</ErrorText>
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 100 }}>
            {folders.length === 0 && <Muted>No subfolders here.</Muted>}
            {folders.map(f => (
              <div key={f.name} style={{ padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid var(--color-border)' }}
                onClick={() => { void load(joinPath(path, f.name)) }}>
                📁 {f.name}
              </div>
            ))}
          </div>
          <div className="btn-row">
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button
              loading={busy}
              onClick={() => {
                setBusy(true)
                onPick(path).catch(err => setError(errMessage(err))).finally(() => setBusy(false))
              }}
            >
              Move here{path ? ` (/${path})` : ' (root)'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

export function BrowserScreen (): React.JSX.Element {
  const app = useApp()
  const downloads = useDownloads()
  const uploads = useUploads()
  const notify = useToast()
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<DirEntry | null>(null)
  const [moving, setMoving] = useState<DirEntry | null>(null)
  const [deleting, setDeleting] = useState<DirEntry | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Per-path listing cache so revisiting a folder (breadcrumb, "../") paints
  // instantly from the last-known listing while a background refetch keeps
  // it fresh, instead of flashing empty/loading on every navigation.
  const cacheRef = useRef(new Map<string, Listing>())

  const load = useCallback(async (p: string): Promise<void> => {
    if (!app.client) return
    setError('')
    const cached = cacheRef.current.get(p)
    if (cached) {
      setListing(cached)
      setPath(p)
    }
    try {
      const l = await withUnauthorizedRetry(app, () => app.client!.list(p))
      cacheRef.current.set(p, l)
      setListing(l)
      setPath(p)
    } catch (err) {
      if (!cached) setError(errMessage(err))
    }
  }, [app])

  useEffect(() => { void load('') }, [load])

  // Keeps the currently-viewed folder reasonably fresh without the user
  // having to navigate away and back — cache-first load() never blanks the
  // UI, so this is a silent background refresh, not a visible reload.
  useEffect(() => {
    const id = setInterval(() => { void load(path) }, 30_000)
    return () => clearInterval(id)
  }, [path, load])

  const entries = listing?.entries ?? []

  const onFilesPicked = (files: FileList | null): void => {
    if (!files) return
    requestNotificationPermission()
    for (const file of files) {
      notify(`Uploading "${file.name}"…`)
      uploads.start(path, file, () => { void load(path) })
    }
  }

  return (
    <div>
      <Title>Browse</Title>
      <div className="browser-toolbar">
        <Breadcrumbs path={path} onNavigate={p => { void load(p) }} />
        <Button variant="secondary" onClick={() => setCreatingFolder(true)}>New folder</Button>
        <Button variant="secondary" onClick={() => { void load(path) }}>Refresh</Button>
        <Button onClick={() => fileInputRef.current?.click()}>Upload files</Button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={e => { onFilesPicked(e.target.files); e.target.value = '' }} />
      </div>
      <ErrorText>{error}</ErrorText>
      <Card>
        <table className="listing">
          <tbody>
            {path !== '' && (
              <tr className="up" onClick={() => { void load(parentPath(path)) }}>
                <td style={{ width: 24 }}>⬆️</td>
                <td colSpan={3}><Muted>../</Muted></td>
              </tr>
            )}
            {entries.length === 0 && <tr><td><Muted>This folder is empty.</Muted></td></tr>}
            {entries.map(entry => (
              <tr key={entry.name}>
                <td style={{ width: 24 }}>{entry.type === 'dir' ? '📁' : '📄'}</td>
                <td>
                  <a
                    style={{ cursor: entry.type === 'dir' ? 'pointer' : 'default', color: entry.type === 'dir' ? 'var(--color-primary)' : 'var(--color-text)' }}
                    onClick={() => { if (entry.type === 'dir') void load(joinPath(path, entry.name)) }}
                  >
                    {entry.name}
                  </a>
                  <div className="muted">{entry.type === 'file' ? `${formatBytes(entry.size)} · ` : ''}{formatDateTime(entry.mtime)}</div>
                </td>
                <td style={{ width: 90, textAlign: 'right' }}>
                  {entry.type === 'file' && (
                    <button
                      className="link-btn"
                      onClick={() => {
                        requestNotificationPermission()
                        downloads.start(joinPath(path, entry.name), entry.name)
                        notify(`Added "${entry.name}" to the download queue`)
                      }}
                    >
                      Download
                    </button>
                  )}
                </td>
                <td style={{ width: 30, position: 'relative' }}>
                  <button className="link-btn muted" onClick={() => setMenuFor(menuFor === entry.name ? null : entry.name)}>⋮</button>
                  {menuFor === entry.name && (
                    <div style={{
                      position: 'absolute', right: 0, top: 24, background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)', borderRadius: 8, zIndex: 5, minWidth: 120
                    }}>
                      <div style={{ padding: 8, cursor: 'pointer' }} onClick={() => { setMenuFor(null); setRenaming(entry) }}>Rename</div>
                      <div style={{ padding: 8, cursor: 'pointer' }} onClick={() => { setMenuFor(null); setMoving(entry) }}>Move</div>
                      <div style={{ padding: 8, cursor: 'pointer', color: 'var(--color-danger)' }} onClick={() => { setMenuFor(null); setDeleting(entry) }}>Delete</div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <NewFolderModal
        open={creatingFolder}
        onCancel={() => setCreatingFolder(false)}
        onConfirm={async (name) => {
          if (!app.client) return
          await withUnauthorizedRetry(app, () => app.client!.mkdir(joinPath(path, name)))
          setCreatingFolder(false)
          notify(`Created folder "${name}"`)
          await load(path)
        }}
      />
      <RenameModal
        entry={renaming}
        onCancel={() => setRenaming(null)}
        onConfirm={async (name) => {
          if (!renaming || !app.client) return
          await withUnauthorizedRetry(app, () => app.client!.move(joinPath(path, renaming.name), joinPath(path, name)))
          setRenaming(null)
          notify(`Renamed to "${name}"`)
          await load(path)
        }}
      />
      <MoveModal
        entry={moving}
        startPath={path}
        onCancel={() => setMoving(null)}
        onPick={async (destDir) => {
          if (!moving || !app.client) return
          await withUnauthorizedRetry(app, () => app.client!.move(joinPath(path, moving.name), joinPath(destDir, moving.name)))
          setMoving(null)
          notify(`Moved "${moving.name}"`)
          await load(path)
        }}
      />
      <DeleteModal
        entry={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting || !app.client) return
          await withUnauthorizedRetry(app, () => app.client!.deleteEntry(joinPath(path, deleting.name)))
          setDeleting(null)
          notify(`Deleted "${deleting.name}"`)
          await load(path)
        }}
      />
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiContext } from './context/ApiContext'
import { HttpError, errMessage, normalizeServer } from './lib/format'
import { useDownloadManager, useDownloads } from './hooks/useDownloads'
import { SetupScreen } from './components/SetupScreen'
import { LoginScreen } from './components/LoginScreen'
import { FileBrowser } from './components/FileBrowser'
import { DownloadsPanel } from './components/DownloadsPanel'

type View = 'connecting' | 'setup' | 'login' | 'browser'

interface AuthInfo {
  required: boolean
  needsSetup: boolean
  authenticated: boolean
}

export function App (): React.JSX.Element {
  const [serverInput, setServerInput] = useState('')
  const [apiBase, setApiBase] = useState<string | null>(null)
  const [status, setStatusState] = useState<{ msg: string, kind: '' | 'ok' | 'error' }>({ msg: '', kind: '' })
  const [view, setView] = useState<View>('connecting')
  const [authed, setAuthed] = useState(false)

  const apiBaseRef = useRef<string | null>(null)
  apiBaseRef.current = apiBase

  const setStatus = useCallback((msg: string, kind: '' | 'ok' | 'error' = '') => {
    setStatusState({ msg, kind })
  }, [])

  const apiFetch = useCallback(async (pathname: string, init?: RequestInit): Promise<Response> => {
    if (!apiBaseRef.current) throw new Error('not connected')
    const res = await fetch(`${apiBaseRef.current}${pathname}`, { credentials: 'include', ...init })
    if (res.status === 401) {
      setView('login')
      throw new HttpError(401, 'authentication required')
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = await res.json() as { error?: string }
        if (body.error) detail = body.error
      } catch { /* non-JSON error body */ }
      throw new HttpError(res.status, detail)
    }
    return res
  }, [])

  const onClientError = useCallback((msg: string) => {
    setStatus(`WebTorrent error: ${msg}`, 'error')
  }, [setStatus])
  const manager = useDownloadManager(onClientError)
  const downloads = useDownloads(manager)

  const connect = useCallback(async (address: string, quiet = false): Promise<void> => {
    const base = normalizeServer(address)
    if (!quiet) setStatus('connecting…')
    try {
      const res = await fetch(`${base}/api/info`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const info = await res.json() as { name?: string, version?: string, auth?: AuthInfo }
      if (info.name !== 'peer-to-file') throw new Error('not a peer-to-file server')
      setApiBase(base)
      apiBaseRef.current = base
      localStorage.setItem('p2f-server', address.trim())
      setStatus(`connected to ${base} (v${info.version ?? '?'})`, 'ok')

      if (info.auth?.required && info.auth.needsSetup) {
        setView('setup')
      } else if (info.auth?.required && !info.auth.authenticated) {
        setView('login')
      } else {
        setAuthed(info.auth?.required ?? false)
        setView('browser')
      }
    } catch (err) {
      if (!quiet) setStatus(`connection failed: ${errMessage(err)}`, 'error')
      throw err
    }
  }, [setStatus])

  useEffect(() => {
    const saved = localStorage.getItem('p2f-server')
    const initial = saved ?? (location.protocol.startsWith('http') ? location.host : '')
    if (initial) setServerInput(initial)
    if (initial) {
      connect(initial, true).catch(() => {
        setStatus('enter the server address and press Connect')
      })
    }
    // runs once on mount, mirroring the boot sequence of the old app.ts
  }, [])

  useEffect(() => {
    if (view === 'browser') void manager.init(apiFetch)
  }, [view, manager, apiFetch])

  const handleAuthenticated = useCallback(() => {
    setAuthed(true)
    setView('browser')
  }, [])

  const handleLogout = useCallback(() => {
    void (async () => {
      try { await apiFetch('/api/logout', { method: 'POST' }) } catch { /* session gone anyway */ }
      setView('login')
    })()
  }, [apiFetch])

  return (
    <ApiContext.Provider value={{ apiBase, apiFetch }}>
      <div className="app-shell">
        <header className="app-header">
          <div className="header-row">
            <div className="brand">
              <span className="logo">📦</span>
              <div>
                <h1>peer-to-file</h1>
                <span className="tagline">self-hosted P2P file browser</span>
              </div>
            </div>
            {view === 'browser' && (
              <div className="header-actions">
                <a id="logs-link" href="/logs.html" target="_blank" rel="noopener">View logs</a>
                {authed && <button id="logout" type="button" onClick={handleLogout}>Log out</button>}
              </div>
            )}
          </div>
          <form
            id="connect-form"
            onSubmit={e => { e.preventDefault(); connect(serverInput).catch(() => {}) }}
          >
            <input
              id="server-input" type="text" placeholder="server ip:port (e.g. 10.0.0.1:8000)"
              autoComplete="off" spellCheck={false} required
              value={serverInput} onChange={e => setServerInput(e.target.value)}
            />
            <button type="submit">Connect</button>
          </form>
          <div id="conn-status" className={`status ${status.kind}`}>{status.msg}</div>
        </header>

        <main>
          {view === 'setup' && <SetupScreen onDone={handleAuthenticated} />}
          {view === 'login' && <LoginScreen onDone={handleAuthenticated} />}
          {view === 'browser' && (
            <>
              <FileBrowser manager={manager} />
              <DownloadsPanel entries={downloads} manager={manager} />
            </>
          )}
        </main>

        <footer>
          <p>chunked &amp; resumable downloads via <a href="https://webtorrent.io" rel="noopener">WebTorrent</a></p>
        </footer>
      </div>
    </ApiContext.Provider>
  )
}

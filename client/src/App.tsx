import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiContext } from './context/ApiContext'
import { ToastProvider } from './context/ToastContext'
import { HttpError, errMessage } from './lib/format'
import { useDownloadManager, useDownloads } from './hooks/useDownloads'
import { SetupScreen } from './components/SetupScreen'
import { LoginScreen } from './components/LoginScreen'
import { FileBrowser } from './components/FileBrowser'
import { DownloadsPanel } from './components/DownloadsPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { LogsPanel } from './components/LogsPanel'

// The client is always served by the same origin as the API it talks to, so
// there's nothing for a user to type in — see the "Managing files"/CORS
// notes in the README for the one case (a separately hosted client) this
// intentionally no longer supports.
const API_BASE = `${location.protocol}//${location.host}`

type View = 'loading' | 'setup' | 'login' | 'browser'
type Subview = 'browser' | 'logs'

interface AuthInfo {
  required: boolean
  needsSetup: boolean
  authenticated: boolean
}

export function App (): React.JSX.Element {
  const [status, setStatusState] = useState<{ msg: string, kind: '' | 'ok' | 'error' }>({ msg: '', kind: '' })
  const [view, setView] = useState<View>('loading')
  const [subview, setSubview] = useState<Subview>('browser')
  const [authed, setAuthed] = useState(false)

  const setStatus = useCallback((msg: string, kind: '' | 'ok' | 'error' = '') => {
    setStatusState({ msg, kind })
  }, [])

  const apiFetch = useCallback(async (pathname: string, init?: RequestInit): Promise<Response> => {
    const res = await fetch(`${API_BASE}${pathname}`, { credentials: 'include', ...init })
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
  // Bumps only when a download finishes, not on every progress tick — the
  // right granularity to refetch the server-persisted history list on.
  const doneCount = useMemo(() => downloads.filter(d => d.status === 'done').length, [downloads])

  // Replaces the old "connect" step: the server is always this same origin,
  // so there's nothing to fetch but its auth state to decide which screen to
  // show. A visible status only appears if this fails — the view change
  // itself is confirmation enough on success.
  const checkSession = useCallback(async (): Promise<void> => {
    setStatus('')
    try {
      const res = await fetch(`${API_BASE}/api/info`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const info = await res.json() as { name?: string, auth?: AuthInfo }
      if (info.name !== 'peer-to-file') throw new Error('unexpected response from server')

      if (info.auth?.required && info.auth.needsSetup) {
        setView('setup')
      } else if (info.auth?.required && !info.auth.authenticated) {
        setView('login')
      } else {
        setAuthed(info.auth?.required ?? false)
        setView('browser')
      }
    } catch (err) {
      setStatus(`could not reach the server: ${errMessage(err)}`, 'error')
    }
  }, [setStatus])

  useEffect(() => { void checkSession() }, [checkSession])

  useEffect(() => {
    if (view === 'browser') void manager.init(apiFetch)
  }, [view, manager, apiFetch])

  const handleAuthenticated = useCallback(() => {
    setAuthed(true)
    setView('browser')
    setSubview('browser')
  }, [])

  const handleLogout = useCallback(() => {
    void (async () => {
      try { await apiFetch('/api/logout', { method: 'POST' }) } catch { /* session gone anyway */ }
      setView('login')
      setSubview('browser')
    })()
  }, [apiFetch])

  return (
    <ApiContext.Provider value={{ apiBase: API_BASE, apiFetch }}>
      <ToastProvider>
        <div className="app-shell">
          <header className="app-header">
            <div className="header-row">
              <div className="brand">
                <img src="/icon.png" className="logo" alt="P2File" />
                <div>
                  <h1>P2File</h1>
                  <span className="tagline">self-hosted P2P file browser</span>
                </div>
              </div>
              {view === 'browser' && (
                <div className="header-actions">
                  {subview === 'browser'
                    ? <button id="logs-link" type="button" className="link-like" onClick={() => setSubview('logs')}>View logs</button>
                    : <button id="back-link" type="button" className="link-like" onClick={() => setSubview('browser')}>&larr; back to browser</button>}
                  {authed && <button id="logout" type="button" onClick={handleLogout}>Log out</button>}
                </div>
              )}
            </div>
            {status.msg && (
              <div id="conn-status" className={`status ${status.kind}`}>
                {status.msg}
                {status.kind === 'error' && (
                  <button type="button" onClick={() => { void checkSession() }}>retry</button>
                )}
              </div>
            )}
          </header>

          <main>
            {view === 'setup' && <SetupScreen onDone={handleAuthenticated} />}
            {view === 'login' && <LoginScreen onDone={handleAuthenticated} />}
            {view === 'browser' && subview === 'browser' && (
              <>
                <FileBrowser manager={manager} />
                <DownloadsPanel entries={downloads} manager={manager} />
                <HistoryPanel refreshSignal={doneCount} />
              </>
            )}
            {view === 'browser' && subview === 'logs' && <LogsPanel />}
          </main>

          <footer>
            <p>chunked &amp; resumable downloads via <a href="https://webtorrent.io" rel="noopener">WebTorrent</a></p>
          </footer>
        </div>
      </ToastProvider>
    </ApiContext.Provider>
  )
}

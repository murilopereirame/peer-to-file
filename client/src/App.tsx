import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiContext } from './context/ApiContext'
import { ToastProvider } from './context/ToastContext'
import { UploadsProvider } from './context/UploadsContext'
import { HttpError, errMessage } from './lib/format'
import { useDownloadManager, useDownloads } from './hooks/useDownloads'
import { SetupScreen } from './components/SetupScreen'
import { LoginScreen } from './components/LoginScreen'
import { BrowserApp } from './components/BrowserApp'
import { AuthLayout } from './components/AuthLayout'

// The client is always served by the same origin as the API it talks to, so
// there's nothing for a user to type in — see the "Managing files"/CORS
// notes in the README for the one case (a separately hosted client) this
// intentionally no longer supports.
const API_BASE = `${location.protocol}//${location.host}`

// F9: a single in-flight refresh, shared by any requests that 401 at once, so
// a burst of concurrent calls triggers exactly one /api/refresh.
let refreshInFlight: Promise<boolean> | null = null
function tryRefresh (): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/api/refresh`, { method: 'POST', credentials: 'include' })
      .then(r => r.ok, () => false)
      .finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}

type View = 'loading' | 'setup' | 'login' | 'browser'

interface AuthInfo {
  required: boolean
  needsSetup: boolean
  authenticated: boolean
}

export function App (): React.JSX.Element {
  const [status, setStatusState] = useState<{ msg: string, kind: '' | 'ok' | 'error' }>({ msg: '', kind: '' })
  const [view, setView] = useState<View>('loading')
  const [authed, setAuthed] = useState(false)

  const setStatus = useCallback((msg: string, kind: '' | 'ok' | 'error' = '') => {
    setStatusState({ msg, kind })
  }, [])

  const apiFetch = useCallback(async (pathname: string, init?: RequestInit): Promise<Response> => {
    // F5: a custom header on every request; the server requires it on cookie-
    // authenticated mutations, and it's harmless on GETs.
    const doFetch = (): Promise<Response> => fetch(`${API_BASE}${pathname}`, {
      credentials: 'include',
      ...init,
      headers: { 'X-P2F-Csrf': '1', ...(init?.headers as Record<string, string> | undefined) }
    })
    let res = await doFetch()
    // F9: on a 401, try one silent refresh before giving up and showing login.
    if (res.status === 401 && pathname !== '/api/refresh') {
      if (await tryRefresh()) res = await doFetch()
    }
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
  }, [])

  const handleLogout = useCallback(() => {
    void (async () => {
      try { await apiFetch('/api/logout', { method: 'POST' }) } catch { /* session gone anyway */ }
      setView('login')
    })()
  }, [apiFetch])

  const retry = useCallback(() => { void checkSession() }, [checkSession])

  return (
    <ApiContext.Provider value={{ apiBase: API_BASE, apiFetch }}>
      <ToastProvider>
        <UploadsProvider>
          {view === 'browser'
            ? (
              <BrowserApp
                manager={manager} downloads={downloads} doneCount={doneCount}
                authed={authed} onLogout={handleLogout} status={status} onRetry={retry}
              />
              )
            : (
              <AuthLayout status={status} onRetry={retry}>
                {view === 'setup' && <SetupScreen onDone={handleAuthenticated} />}
                {view === 'login' && <LoginScreen onDone={handleAuthenticated} />}
                {view === 'loading' && <div className="status">connecting to the server…</div>}
              </AuthLayout>
              )}
        </UploadsProvider>
      </ToastProvider>
    </ApiContext.Provider>
  )
}

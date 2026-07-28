import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, P2FClient, colorsFor, type ThemeColors, type ThemeMode } from '@p2f/shared'
import { createClient } from '../lib/client'
import {
  loadCredentials, saveCredentials, clearCredentials, settings,
  readRefreshToken, restoreRefreshToken
} from '../lib/electronApi'

export type Phase = 'loading' | 'server' | 'setup' | 'login' | 'main'

export interface AppContextValue {
  phase: Phase
  client: P2FClient | null
  serverUrl: string
  username: string | null
  connected: boolean
  colors: ThemeColors
  scheme: ThemeMode
  downloadDir: string | null
  setDownloadDir: (dir: string | null) => Promise<void>
  keepAwakeDuringTransfers: boolean
  setKeepAwakeDuringTransfersPref: (value: boolean) => Promise<void>
  themeOverride: ThemeMode | null
  setThemeOverridePref: (mode: ThemeMode | null) => Promise<void>
  connectToServer: (url: string) => Promise<void>
  changeServer: () => Promise<void>
  completeSetup: (username: string, password: string, remember: boolean, setupToken?: string) => Promise<void>
  completeLogin: (username: string, password: string, remember: boolean) => Promise<void>
  logout: () => Promise<void>
  retry: () => Promise<void>
  handleUnauthorized: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp (): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}

function useSystemScheme (): ThemeMode {
  const [scheme, setScheme] = useState<ThemeMode>(
    () => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => { setScheme(e.matches ? 'dark' : 'light') }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return scheme
}

export function AppProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [client, setClient] = useState<P2FClient | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [downloadDir, setDownloadDirState] = useState<string | null>(null)
  const [keepAwakeDuringTransfers, setKeepAwakeDuringTransfersState] = useState(false)
  const [themeOverride, setThemeOverride] = useState<ThemeMode | null>(null)
  const system = useSystemScheme()
  const scheme: ThemeMode = themeOverride ?? system
  const colors = useMemo(() => colorsFor(scheme), [scheme])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = scheme
    for (const [key, value] of Object.entries(colors)) {
      root.style.setProperty(`--color-${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`, value)
    }
  }, [scheme, colors])

  // F9: after a login/setup/refresh, capture the rotated refresh token from the
  // main-process cookie jar and persist it (in place of the raw password).
  const persistRefreshToken = useCallback(async (c: P2FClient, user: string): Promise<void> => {
    const token = await readRefreshToken(c.baseUrl)
    if (token) await saveCredentials(c.baseUrl, user, token)
  }, [])

  // F9: silently mint a fresh session from a persisted refresh token. Returns
  // the username on success, or null if there's nothing stored / it's expired.
  const tryStoredRefresh = useCallback(async (c: P2FClient): Promise<string | null> => {
    const creds = await loadCredentials(c.baseUrl)
    if (!creds) return null
    try {
      await restoreRefreshToken(c.baseUrl, creds.refreshToken)
      await c.refresh() // rotates: the jar now holds a new refresh token
      await persistRefreshToken(c, creds.username)
      return creds.username
    } catch {
      await clearCredentials(c.baseUrl)
      return null
    }
  }, [persistRefreshToken])

  const evaluateAuth = useCallback(async (c: P2FClient): Promise<void> => {
    try {
      const info = await c.info()
      setConnected(true)
      if (info.auth.needsSetup) { setPhase('setup'); return }
      if (!info.auth.authenticated) {
        const user = await tryStoredRefresh(c)
        if (user) { setUsername(user); setPhase('main'); return }
        setPhase('login')
        return
      }
      const me = await c.me()
      setUsername(me.username)
      setPhase('main')
    } catch {
      setConnected(false)
      const creds = await loadCredentials(c.baseUrl)
      setPhase(creds ? 'main' : 'server')
    }
  }, [tryStoredRefresh])
  const evaluateAuthRef = useRef(evaluateAuth)
  evaluateAuthRef.current = evaluateAuth

  useEffect(() => {
    void (async () => {
      const [url, dir, override, keepAwake] = await Promise.all([
        settings.getServerUrl(), settings.getDownloadDir(), settings.getThemeOverride(), settings.getKeepAwakeDuringTransfers()
      ])
      setDownloadDirState(dir)
      setThemeOverride(override)
      setKeepAwakeDuringTransfersState(keepAwake)
      if (!url) { setPhase('server'); return }
      const c = createClient(url)
      setClient(c)
      setServerUrl(c.baseUrl)
      await evaluateAuth(c)
    })()
  }, [evaluateAuth])

  useEffect(() => {
    if (phase !== 'main' || !client) return
    const id = window.setInterval(() => {
      client.info().then(
        info => { setConnected(true); if (info.auth.required && !info.auth.authenticated) void evaluateAuthRef.current(client) },
        () => { setConnected(false) }
      )
    }, 10_000)
    return () => window.clearInterval(id)
  }, [phase, client])

  const connectToServer = useCallback(async (url: string): Promise<void> => {
    const c = createClient(url)
    await c.info()
    setClient(c)
    setServerUrl(c.baseUrl)
    await settings.setServerUrl(c.baseUrl)
    await evaluateAuth(c)
  }, [evaluateAuth])

  const changeServer = useCallback(async (): Promise<void> => {
    if (client) await clearCredentials(client.baseUrl)
    await settings.clearServerScoped()
    setClient(null)
    setUsername(null)
    setPhase('server')
  }, [client])

  const completeSetup = useCallback(async (u: string, p: string, remember: boolean, setupToken?: string): Promise<void> => {
    if (!client) throw new Error('not connected')
    await client.setup(u, p, setupToken)
    if (remember) await persistRefreshToken(client, u)
    setUsername(u)
    setPhase('main')
  }, [client, persistRefreshToken])

  const completeLogin = useCallback(async (u: string, p: string, remember: boolean): Promise<void> => {
    if (!client) throw new Error('not connected')
    await client.login(u, p)
    if (remember) await persistRefreshToken(client, u)
    else await clearCredentials(client.baseUrl)
    setUsername(u)
    setPhase('main')
  }, [client, persistRefreshToken])

  const logout = useCallback(async (): Promise<void> => {
    try { await client?.logout() } catch { /* session already gone server-side */ }
    if (client) await clearCredentials(client.baseUrl)
    setUsername(null)
    setPhase('login')
  }, [client])

  const retry = useCallback(async (): Promise<void> => {
    if (client) await evaluateAuth(client)
  }, [client, evaluateAuth])

  const handleUnauthorized = useCallback(async (): Promise<void> => {
    if (!client) return
    const user = await tryStoredRefresh(client)
    if (user) { setUsername(user); return }
    setPhase('login')
  }, [client, tryStoredRefresh])

  const setDownloadDir = useCallback(async (dir: string | null): Promise<void> => {
    await settings.setDownloadDir(dir)
    setDownloadDirState(dir)
  }, [])

  const setKeepAwakeDuringTransfersPref = useCallback(async (value: boolean): Promise<void> => {
    await settings.setKeepAwakeDuringTransfers(value)
    setKeepAwakeDuringTransfersState(value)
  }, [])

  const setThemeOverridePref = useCallback(async (mode: ThemeMode | null): Promise<void> => {
    await settings.setThemeOverride(mode)
    setThemeOverride(mode)
  }, [])

  const value: AppContextValue = {
    phase, client, serverUrl, username, connected, colors, scheme,
    downloadDir, setDownloadDir, keepAwakeDuringTransfers, setKeepAwakeDuringTransfersPref,
    themeOverride, setThemeOverridePref,
    connectToServer, changeServer, completeSetup, completeLogin, logout, retry, handleUnauthorized
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function withUnauthorizedRetry<T> (app: AppContextValue, fn: () => Promise<T>): Promise<T> {
  return fn().catch(async (err) => {
    if (err instanceof ApiError && err.status === 401) await app.handleUnauthorized()
    throw err
  })
}

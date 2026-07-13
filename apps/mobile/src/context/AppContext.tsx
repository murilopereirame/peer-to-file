import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useColorScheme } from 'react-native'
import { colorsFor, type ThemeColors, type ThemeMode, P2FClient, ApiError } from '@p2f/shared'
import { createClient } from '../lib/client'
import { storage } from '../lib/storage'

export type Phase = 'loading' | 'server' | 'setup' | 'login' | 'main'

export interface AppContextValue {
  phase: Phase
  client: P2FClient | null
  serverUrl: string
  username: string | null
  connected: boolean
  colors: ThemeColors
  scheme: ThemeMode
  downloadDirUri: string | null
  setDownloadDirUri: (uri: string | null) => Promise<void>
  themeOverride: ThemeMode | null
  setThemeOverridePref: (mode: ThemeMode | null) => Promise<void>
  connectToServer: (url: string) => Promise<void>
  changeServer: () => Promise<void>
  completeSetup: (username: string, password: string, remember: boolean) => Promise<void>
  completeLogin: (username: string, password: string, remember: boolean) => Promise<void>
  logout: () => Promise<void>
  retry: () => Promise<void>
  /** Call after any authenticated request 401s: tries stored creds once, else forces the login screen. */
  handleUnauthorized: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp (): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}

export function AppProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [client, setClient] = useState<P2FClient | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [downloadDirUri, setDownloadDirUriState] = useState<string | null>(null)
  const [themeOverride, setThemeOverride] = useState<ThemeMode | null>(null)
  const system = useColorScheme()
  const scheme: ThemeMode = themeOverride ?? (system === 'dark' ? 'dark' : 'light')
  const colors = useMemo(() => colorsFor(scheme), [scheme])
  const clientRef = useRef<P2FClient | null>(null)

  const evaluateAuth = useCallback(async (c: P2FClient): Promise<void> => {
    try {
      const info = await c.info()
      setConnected(true)
      if (info.auth.required && info.auth.needsSetup) {
        setPhase('setup')
        return
      }
      if (info.auth.required && !info.auth.authenticated) {
        const creds = await storage.getCredentials()
        if (creds) {
          try {
            await c.login(creds.username, creds.password)
            setUsername(creds.username)
            setPhase('main')
            return
          } catch { /* stored password no longer valid — fall through to manual login */ }
        }
        setPhase('login')
        return
      }
      if (info.auth.required) {
        const me = await c.me()
        setUsername(me.username)
      } else {
        setUsername(null)
      }
      setPhase('main')
    } catch {
      setConnected(false)
      const creds = await storage.getCredentials()
      // Already set up before: let them into the shell so they see a clear
      // "disconnected" badge instead of being stuck on the server screen
      // every time the VPN happens to be down when the app opens.
      setPhase(creds ? 'main' : 'server')
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const [url, dirUri, override] = await Promise.all([
        storage.getServerUrl(), storage.getDownloadDirUri(), storage.getThemeOverride()
      ])
      setDownloadDirUriState(dirUri)
      setThemeOverride(override)
      if (!url) { setPhase('server'); return }
      const c = createClient(url)
      clientRef.current = c
      setClient(c)
      setServerUrl(url)
      await evaluateAuth(c)
    })()
  }, [evaluateAuth])

  // Connection badge polling while the app shell is visible.
  useEffect(() => {
    if (phase !== 'main' || !client) return
    const id = setInterval(() => {
      client.info().then(
        info => { setConnected(true); if (info.auth.required && !info.auth.authenticated) void evaluateAuthRef.current(client) },
        () => { setConnected(false) }
      )
    }, 10_000)
    return () => clearInterval(id)
  }, [phase, client])

  const evaluateAuthRef = useRef(evaluateAuth)
  evaluateAuthRef.current = evaluateAuth

  const connectToServer = useCallback(async (url: string): Promise<void> => {
    const c = createClient(url)
    await c.info() // throws if unreachable — surfaced to the ServerScreen's own try/catch
    clientRef.current = c
    setClient(c)
    setServerUrl(c.baseUrl)
    await storage.setServerUrl(c.baseUrl)
    await evaluateAuth(c)
  }, [evaluateAuth])

  const changeServer = useCallback(async (): Promise<void> => {
    await storage.clearAll()
    setClient(null)
    setUsername(null)
    setDownloadDirUriState(null)
    setPhase('server')
  }, [])

  const completeSetup = useCallback(async (u: string, p: string, remember: boolean): Promise<void> => {
    if (!client) throw new Error('not connected')
    await client.setup(u, p)
    if (remember) await storage.setCredentials(u, p)
    setUsername(u)
    setPhase('main')
  }, [client])

  const completeLogin = useCallback(async (u: string, p: string, remember: boolean): Promise<void> => {
    if (!client) throw new Error('not connected')
    await client.login(u, p)
    if (remember) await storage.setCredentials(u, p)
    else await storage.clearCredentials()
    setUsername(u)
    setPhase('main')
  }, [client])

  const logout = useCallback(async (): Promise<void> => {
    try { await client?.logout() } catch { /* session already gone server-side */ }
    await storage.clearCredentials()
    setUsername(null)
    setPhase('login')
  }, [client])

  const retry = useCallback(async (): Promise<void> => {
    if (client) await evaluateAuth(client)
  }, [client, evaluateAuth])

  const handleUnauthorized = useCallback(async (): Promise<void> => {
    if (!client) return
    const creds = await storage.getCredentials()
    if (creds) {
      try {
        await client.login(creds.username, creds.password)
        return
      } catch { /* fall through */ }
    }
    setPhase('login')
  }, [client])

  const setDownloadDirUri = useCallback(async (uri: string | null): Promise<void> => {
    await storage.setDownloadDirUri(uri)
    setDownloadDirUriState(uri)
  }, [])

  const setThemeOverridePref = useCallback(async (mode: ThemeMode | null): Promise<void> => {
    await storage.setThemeOverride(mode)
    setThemeOverride(mode)
  }, [])

  const value: AppContextValue = {
    phase, client, serverUrl, username, connected, colors, scheme,
    downloadDirUri, setDownloadDirUri, themeOverride, setThemeOverridePref,
    connectToServer, changeServer,
    completeSetup, completeLogin, logout, retry, handleUnauthorized
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function withUnauthorizedRetry<T> (
  app: AppContextValue, fn: () => Promise<T>
): Promise<T> {
  return fn().catch(async (err) => {
    if (err instanceof ApiError && err.status === 401) {
      await app.handleUnauthorized()
    }
    throw err
  })
}

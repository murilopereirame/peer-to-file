import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ThemeMode } from '@p2f/shared'

const STORAGE_KEY = 'p2f-theme'

interface Ctx {
  /** Resolved theme actually applied — either the override or, absent one, the OS preference. */
  scheme: ThemeMode
  /** The user's explicit choice, or null to follow the OS preference. */
  override: ThemeMode | null
  setOverride: (mode: ThemeMode | null) => void
}

const ThemeContext = createContext<Ctx | null>(null)

export function useTheme (): Ctx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
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

function loadStoredOverride (): ThemeMode | null {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : null
}

export function ThemeProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [override, setOverrideState] = useState<ThemeMode | null>(loadStoredOverride)
  const system = useSystemScheme()
  const scheme: ThemeMode = override ?? system

  useEffect(() => {
    document.documentElement.dataset.theme = scheme
  }, [scheme])

  const setOverride = useCallback((mode: ThemeMode | null) => {
    if (mode === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
    setOverrideState(mode)
  }, [])

  return <ThemeContext.Provider value={{ scheme, override, setOverride }}>{children}</ThemeContext.Provider>
}

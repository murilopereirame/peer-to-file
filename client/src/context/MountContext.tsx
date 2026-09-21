import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { MountInfo, Role } from '@p2f/shared'
import { useApi } from './ApiContext'

const STORAGE_KEY = 'p2f-active-mount'

interface Ctx {
  mounts: MountInfo[]
  /** Null until the first /api/mounts fetch resolves. */
  activeMountId: number | null
  activeMount: MountInfo | null
  setActiveMountId: (id: number) => void
  /** The signed-in user's role — null until /api/me resolves. Drives the Admin nav item. */
  role: Role | null
  /** Query-string fragment (e.g. "&mount=3") to append to a GET URL that already has a query — '' for the default mount. */
  mountQS: string
  /** Field to spread into a JSON POST body — `{ mount: 3 }` or `{}` for the default mount. */
  mountBody: { mount?: number }
  refresh: () => Promise<void>
}

const MountContext = createContext<Ctx | null>(null)

export function useMount (): Ctx {
  const ctx = useContext(MountContext)
  if (!ctx) throw new Error('useMount must be used within a MountProvider')
  return ctx
}

function loadStoredMountId (): number | null {
  const stored = localStorage.getItem(STORAGE_KEY)
  const n = stored === null ? NaN : Number(stored)
  return Number.isFinite(n) ? n : null
}

/**
 * Tracks which mount (filesystem root) the browser/search views are pointed
 * at, and the signed-in user's role (gates the Admin view). Both come from
 * the server, refetched on demand (e.g. after an admin grants/revokes access
 * to the mount currently being browsed) rather than polled.
 */
export function MountProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { apiFetch } = useApi()
  const [mounts, setMounts] = useState<MountInfo[]>([])
  const [role, setRole] = useState<Role | null>(null)
  const [activeMountId, setActiveMountIdState] = useState<number | null>(null)

  const setActiveMountId = useCallback((id: number) => {
    setActiveMountIdState(id)
    localStorage.setItem(STORAGE_KEY, String(id))
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const [mountsRes, meRes] = await Promise.all([apiFetch('/api/mounts'), apiFetch('/api/me')])
    const mountsBody = await mountsRes.json() as { mounts: MountInfo[] }
    const meBody = await meRes.json() as { role: Role | null, defaultMountId: number | null }
    setMounts(mountsBody.mounts)
    setRole(meBody.role)
    setActiveMountIdState(current => {
      // Keep the current pick if it's still reachable; otherwise fall back to
      // a remembered choice on this browser, then this user's admin-assigned
      // default mount, then the global default mount, then whatever's first.
      if (current !== null && mountsBody.mounts.some(m => m.id === current)) return current
      const stored = loadStoredMountId()
      if (stored !== null && mountsBody.mounts.some(m => m.id === stored)) return stored
      if (meBody.defaultMountId !== null && mountsBody.mounts.some(m => m.id === meBody.defaultMountId)) return meBody.defaultMountId
      return mountsBody.mounts.find(m => m.isDefault)?.id ?? mountsBody.mounts[0]?.id ?? null
    })
  }, [apiFetch])

  useEffect(() => { void refresh() }, [refresh])

  const activeMount = useMemo(
    () => mounts.find(m => m.id === activeMountId) ?? null,
    [mounts, activeMountId]
  )
  // Always sent explicitly once known, default mount included — the server
  // resolves an id/name for any mount the caller has access to, whether or
  // not it happens to be the default, so there's no need to special-case it.
  const mountQS = activeMountId !== null ? `&mount=${activeMountId}` : ''
  const mountBody = useMemo<{ mount?: number }>(
    () => (activeMountId !== null ? { mount: activeMountId } : {}),
    [activeMountId]
  )

  return (
    <MountContext.Provider value={{ mounts, activeMountId, activeMount, setActiveMountId, role, mountQS, mountBody, refresh }}>
      {children}
    </MountContext.Provider>
  )
}

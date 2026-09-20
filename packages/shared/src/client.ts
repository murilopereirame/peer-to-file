import { ApiError } from './types.ts'
import type {
  AdminMount, AdminUser, HistoryEntry, Listing, LogEntry, MountInfo, Role, SearchResponse, ServerInfo, TorrentMeta
} from './types.ts'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface P2FClientOptions {
  /** e.g. `http://10.0.0.1:8000` — no trailing slash, no path. */
  baseUrl: string
  /**
   * Injected so each app can route requests through the right transport:
   * the browser's own `fetch` (same-origin, cookies work automatically) on
   * the web client, or a main-process-proxied `fetch` on desktop (see
   * apps/desktop/electron/netFetch.cts — runs in Electron's main process
   * with its own in-memory cookie jar, so it isn't subject to the server's
   * `Access-Control-Allow-Origin: *` blocking credentialed cross-origin
   * cookies the way the renderer's own `fetch` would be).
   */
  fetchImpl: FetchLike
}

export function normalizeServerUrl (raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('server URL is required')
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`
  return trimmed
}

/**
 * Thin wrapper around the peer-to-file HTTP API. Framework-agnostic: no
 * DOM, no Electron imports here, so it can be shared verbatim by both apps.
 * Session state (cookie) is handled entirely by whatever
 * `fetchImpl` is passed in — this class never inspects auth state itself,
 * it just surfaces 401s as `ApiError` for the caller to react to.
 */
export class P2FClient {
  baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor (opts: P2FClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl
  }

  private async request (pathname: string, init?: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        credentials: 'include',
        ...init,
        // F5: CSRF guard header the server requires on cookie-authenticated
        // mutations. Harmless on GETs; set centrally so every call carries it.
        headers: { 'X-P2F-Csrf': '1', ...(init?.headers as Record<string, string> | undefined) }
      })
    } catch (err) {
      throw new ApiError(0, err instanceof Error ? err.message : 'network request failed')
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = await res.clone().json() as { error?: string }
        if (body.error) detail = body.error
      } catch { /* non-JSON error body */ }
      throw new ApiError(res.status, detail)
    }
    return res
  }

  private async requestJson<T> (pathname: string, init?: RequestInit): Promise<T> {
    const res = await this.request(pathname, init)
    return await res.json() as T
  }

  private static jsonInit (method: string, body: unknown): RequestInit {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  }

  async info (): Promise<ServerInfo> {
    return await this.requestJson<ServerInfo>('/api/info')
  }

  async setup (username: string, password: string, setupToken?: string): Promise<{ username: string }> {
    return await this.requestJson('/api/setup', P2FClient.jsonInit('POST', { username, password, setupToken }))
  }

  async login (username: string, password: string): Promise<{ username: string }> {
    return await this.requestJson('/api/login', P2FClient.jsonInit('POST', { username, password }))
  }

  /** F9: rotate the refresh cookie into a fresh access+refresh pair. */
  async refresh (): Promise<{ username: string }> {
    return await this.requestJson('/api/refresh', { method: 'POST' })
  }

  async logout (): Promise<void> {
    await this.request('/api/logout', { method: 'POST' })
  }

  async logoutAll (): Promise<void> {
    await this.request('/api/logout-all', { method: 'POST' })
  }

  async me (): Promise<{ username: string | null, role: Role | null }> {
    return await this.requestJson('/api/me')
  }

  /** Mounts (id, name) requester may browse — the default plus any explicitly granted, or every mount for an admin. */
  async mounts (): Promise<{ mounts: MountInfo[] }> {
    return await this.requestJson('/api/mounts')
  }

  /** `mount` is a mount id or name; omitted means the default mount. */
  async list (path = '', mount?: number | string): Promise<Listing> {
    const params = new URLSearchParams({ path })
    if (mount !== undefined) params.set('mount', String(mount))
    return await this.requestJson(`/api/list?${params.toString()}`)
  }

  async deleteEntry (path: string, mount?: number | string): Promise<void> {
    await this.request('/api/delete', P2FClient.jsonInit('POST', { path, mount: mount === undefined ? undefined : String(mount) }))
  }

  /**
   * `mount` is where `from` lives; `toMount` is where `to` should land (omit
   * for a same-mount move/rename — the common case). The caller needs access
   * to both when they differ.
   */
  async move (from: string, to: string, mount?: number | string, toMount?: number | string): Promise<{ path: string, mount: number }> {
    return await this.requestJson('/api/move', P2FClient.jsonInit('POST', {
      from,
      to,
      mount: mount === undefined ? undefined : String(mount),
      toMount: toMount === undefined ? undefined : String(toMount)
    }))
  }

  async mkdir (path: string, mount?: number | string): Promise<{ path: string }> {
    return await this.requestJson('/api/mkdir', P2FClient.jsonInit('POST', { path, mount: mount === undefined ? undefined : String(mount) }))
  }

  /** `clientPublicKeyBase64` is this session's ephemeral ECDH public key — see browserCrypto.ts's establishKeyWrap. */
  async torrentMeta (path: string, clientPublicKeyBase64: string, mount?: number | string): Promise<TorrentMeta> {
    const params = new URLSearchParams({ path, ck: clientPublicKeyBase64 })
    if (mount !== undefined) params.set('mount', String(mount))
    return await this.requestJson(`/api/torrent?${params.toString()}`)
  }

  /** Recursive name search. Omit `mount` to search every mount the caller can reach. */
  async search (query: string, opts: { mount?: number | string, path?: string, type?: 'dir' | 'file', limit?: number } = {}): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query })
    if (opts.mount !== undefined) params.set('mount', String(opts.mount))
    if (opts.path !== undefined) params.set('path', opts.path)
    if (opts.type !== undefined) params.set('type', opts.type)
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    return await this.requestJson(`/api/search?${params.toString()}`)
  }

  // --- admin: users + mount access -----------------------------------------

  async adminUsers (): Promise<{ users: AdminUser[] }> {
    return await this.requestJson('/api/admin/users')
  }

  async adminSetUserRole (username: string, role: Role): Promise<void> {
    await this.request(`/api/admin/users/${encodeURIComponent(username)}/role`, P2FClient.jsonInit('POST', { role }))
  }

  async adminCreateUser (username: string, password: string, role?: Role): Promise<AdminUser> {
    return await this.requestJson('/api/admin/users', P2FClient.jsonInit('POST', { username, password, role }))
  }

  async adminDeleteUser (username: string): Promise<void> {
    await this.request(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' })
  }

  async adminMounts (): Promise<{ mounts: AdminMount[] }> {
    return await this.requestJson('/api/admin/mounts')
  }

  async adminCreateMount (name: string, path: string): Promise<MountInfo> {
    return await this.requestJson('/api/admin/mounts', P2FClient.jsonInit('POST', { name, path }))
  }

  async adminDeleteMount (id: number): Promise<void> {
    await this.request(`/api/admin/mounts/${id}`, { method: 'DELETE' })
  }

  async adminGrantMountAccess (mountId: number, username: string): Promise<void> {
    await this.request(`/api/admin/mounts/${mountId}/access`, P2FClient.jsonInit('POST', { username }))
  }

  async adminRevokeMountAccess (mountId: number, userId: number): Promise<void> {
    await this.request(`/api/admin/mounts/${mountId}/access/${userId}`, { method: 'DELETE' })
  }

  async logs (opts: { limit?: number, sinceId?: number } = {}): Promise<{ entries: LogEntry[] }> {
    const params = new URLSearchParams()
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.sinceId !== undefined) params.set('sinceId', String(opts.sinceId))
    return await this.requestJson(`/api/logs?${params.toString()}`)
  }

  async historyList (): Promise<{ entries: HistoryEntry[] }> {
    return await this.requestJson('/api/downloads/history')
  }

  async historyRecord (
    path: string, name: string, length: number, infoHash?: string, durationMs?: number
  ): Promise<void> {
    await this.request('/api/downloads/history', P2FClient.jsonInit('POST', { path, name, length, infoHash, durationMs }))
  }

  async historyClear (): Promise<void> {
    await this.request('/api/downloads/history/clear', { method: 'POST' })
  }

  async uploadHistoryList (): Promise<{ entries: HistoryEntry[] }> {
    return await this.requestJson('/api/uploads/history')
  }

  async uploadHistoryRecord (path: string, name: string, length: number, durationMs?: number): Promise<void> {
    await this.request('/api/uploads/history', P2FClient.jsonInit('POST', { path, name, length, durationMs }))
  }

  async uploadHistoryClear (): Promise<void> {
    await this.request('/api/uploads/history/clear', { method: 'POST' })
  }

  /** URL to POST a file's raw bytes to, to create it at `dirPath/name`. */
  uploadUrl (dirPath: string, name: string, mount?: number | string): string {
    const params = new URLSearchParams({ path: dirPath, name })
    if (mount !== undefined) params.set('mount', String(mount))
    return `${this.baseUrl}/api/upload?${params.toString()}`
  }
}

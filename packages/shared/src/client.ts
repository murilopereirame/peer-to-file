import { ApiError } from './types.ts'
import type {
  HistoryEntry, Listing, LogEntry, ServerInfo, TorrentMeta
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

  async me (): Promise<{ username: string | null }> {
    return await this.requestJson('/api/me')
  }

  async list (path = ''): Promise<Listing> {
    return await this.requestJson(`/api/list?path=${encodeURIComponent(path)}`)
  }

  async deleteEntry (path: string): Promise<void> {
    await this.request('/api/delete', P2FClient.jsonInit('POST', { path }))
  }

  async move (from: string, to: string): Promise<{ path: string }> {
    return await this.requestJson('/api/move', P2FClient.jsonInit('POST', { from, to }))
  }

  async mkdir (path: string): Promise<{ path: string }> {
    return await this.requestJson('/api/mkdir', P2FClient.jsonInit('POST', { path }))
  }

  /** `clientPublicKeyBase64` is this session's ephemeral ECDH public key — see browserCrypto.ts's establishKeyWrap. */
  async torrentMeta (path: string, clientPublicKeyBase64: string): Promise<TorrentMeta> {
    return await this.requestJson(
      `/api/torrent?path=${encodeURIComponent(path)}&ck=${encodeURIComponent(clientPublicKeyBase64)}`
    )
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
  uploadUrl (dirPath: string, name: string): string {
    return `${this.baseUrl}/api/upload?path=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(name)}`
  }
}

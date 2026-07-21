// Renderer-side shape of the bridge exposed by electron/preload.cts via
// contextBridge — duplicated here rather than imported across the
// electron/ and src/ TypeScript projects (they use different module
// resolution settings), so keep this in sync with preload.cts by hand.

export interface StoredCredentials {
  username: string
  refreshToken: string
}

export interface FetchRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: ArrayBuffer | string
}

export interface FetchSuccess {
  status: number
  statusText: string
  ok: boolean
  headers: Array<[string, string]>
  body: ArrayBuffer
}

export interface FetchFailure {
  networkError: string
}

export type FetchResult = FetchSuccess | FetchFailure

export interface DownloadCompletedInfo {
  filename: string
  path: string
  state: 'completed' | 'cancelled' | 'interrupted'
}

export interface P2FBridge {
  fetch: (req: FetchRequest) => Promise<FetchResult>
  saveCredentials: (server: string, username: string, refreshToken: string) => Promise<void>
  loadCredentials: (server: string) => Promise<StoredCredentials | null>
  clearCredentials: (server: string) => Promise<void>
  getCookie: (origin: string, name: string) => Promise<string | null>
  setCookie: (origin: string, name: string, value: string) => Promise<void>
  defaultDownloadsDir: () => Promise<string | null>
  pickDownloadFolder: () => Promise<string | null>
  setDownloadDir: (path: string | null) => Promise<void>
  hashFile: (path: string) => Promise<string | null>
  registerPendingDownload: () => Promise<number>
  awaitDownloadCompletion: (ticketId: number) => Promise<DownloadCompletedInfo>
  getSetting: <T>(key: string) => Promise<T | undefined>
  setSetting: (key: string, value: unknown) => Promise<void>
  deleteSetting: (key: string) => Promise<void>
  setKeepAwake: (enabled: boolean) => Promise<void>
}

declare global {
  interface Window {
    p2f: P2FBridge
  }
}

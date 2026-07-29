import { contextBridge, ipcRenderer } from 'electron'
import type { StoredCredentials } from './credentials.cjs'
import type { FetchRequest, FetchResult } from './netFetch.cjs'

export interface DownloadCompletedInfo {
  filename: string
  path: string
  state: 'completed' | 'cancelled' | 'interrupted'
}

// The only bridge between the sandboxed renderer and the main process — see
// src/lib/electronApi.ts and src/lib/client.ts for the renderer-side
// wrappers around each of these. Kept to plain data in, plain data (or a
// thrown error) out, no Node/Electron types crossing into the renderer.
const api = {
  fetch: (req: FetchRequest): Promise<FetchResult> => ipcRenderer.invoke('net:fetch', req),

  /** Byte-level progress for a request sent with a matching `progressId`.
   *  Returns an unsubscribe — call it once the request has settled, or the
   *  listener outlives the upload it was watching. */
  onUploadProgress: (progressId: string, cb: (sent: number, total: number) => void): (() => void) => {
    const listener = (_e: unknown, id: string, sent: number, total: number): void => {
      if (id === progressId) cb(sent, total)
    }
    ipcRenderer.on('net:uploadProgress', listener)
    return () => { ipcRenderer.off('net:uploadProgress', listener) }
  },

  saveCredentials: (server: string, username: string, refreshToken: string): Promise<void> =>
    ipcRenderer.invoke('credentials:save', server, username, refreshToken),
  loadCredentials: (server: string): Promise<StoredCredentials | null> =>
    ipcRenderer.invoke('credentials:load', server),
  clearCredentials: (server: string): Promise<void> => ipcRenderer.invoke('credentials:clear', server),

  // Persist/restore the refresh token (p2f_refresh) via the main-process jar (F9).
  getCookie: (origin: string, name: string): Promise<string | null> =>
    ipcRenderer.invoke('net:getCookie', origin, name),
  setCookie: (origin: string, name: string, value: string): Promise<void> =>
    ipcRenderer.invoke('net:setCookie', origin, name, value),

  defaultDownloadsDir: (): Promise<string | null> => ipcRenderer.invoke('downloads:defaultDir'),
  pickDownloadFolder: (): Promise<string | null> => ipcRenderer.invoke('downloads:pickFolder'),
  setDownloadDir: (path: string | null): Promise<void> => ipcRenderer.invoke('downloads:setDir', path),
  hashFile: (path: string): Promise<string | null> => ipcRenderer.invoke('downloads:hashFile', path),
  /** Call before triggering a download, then pass the returned ticket to
   * awaitDownloadCompletion — see the doc comment on pendingDownloadQueue in
   * main.cts for why this is ticket-based rather than matched by filename. */
  registerPendingDownload: (): Promise<number> => ipcRenderer.invoke('downloads:registerPending'),
  awaitDownloadCompletion: (ticketId: number): Promise<DownloadCompletedInfo> =>
    ipcRenderer.invoke('downloads:awaitCompletion', ticketId),

  getSetting: <T, >(key: string): Promise<T | undefined> => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('settings:set', key, value),
  deleteSetting: (key: string): Promise<void> => ipcRenderer.invoke('settings:delete', key),

  setKeepAwake: (enabled: boolean): Promise<void> => ipcRenderer.invoke('power:setKeepAwake', enabled)
}

export type P2FBridge = typeof api

contextBridge.exposeInMainWorld('p2f', api)

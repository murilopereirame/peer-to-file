import { contextBridge, ipcRenderer } from 'electron'
import type { StoredCredentials } from './credentials.cjs'
import type { FetchRequest, FetchResult } from './netFetch.cjs'

// The only bridge between the sandboxed renderer and the main process — see
// src/lib/electronApi.ts and src/lib/client.ts for the renderer-side
// wrappers around each of these. Kept to plain data in, plain data (or a
// thrown error) out, no Node/Electron types crossing into the renderer.
const api = {
  fetch: (req: FetchRequest): Promise<FetchResult> => ipcRenderer.invoke('net:fetch', req),

  saveCredentials: (server: string, username: string, password: string): Promise<void> =>
    ipcRenderer.invoke('credentials:save', server, username, password),
  loadCredentials: (server: string): Promise<StoredCredentials | null> =>
    ipcRenderer.invoke('credentials:load', server),
  clearCredentials: (server: string): Promise<void> => ipcRenderer.invoke('credentials:clear', server),

  defaultDownloadsDir: (): Promise<string | null> => ipcRenderer.invoke('downloads:defaultDir'),
  pickDownloadFolder: (): Promise<string | null> => ipcRenderer.invoke('downloads:pickFolder'),
  setDownloadDir: (path: string | null): Promise<void> => ipcRenderer.invoke('downloads:setDir', path),

  getSetting: <T, >(key: string): Promise<T | undefined> => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('settings:set', key, value),
  deleteSetting: (key: string): Promise<void> => ipcRenderer.invoke('settings:delete', key)
}

export type P2FBridge = typeof api

contextBridge.exposeInMainWorld('p2f', api)

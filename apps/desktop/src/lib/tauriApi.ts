import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { load, type Store } from '@tauri-apps/plugin-store'

export interface StoredCredentials {
  username: string
  password: string
}

// --- OS keychain (via the `keyring` crate, custom Rust commands) -----------
// This is the one thing that's genuinely a *secret* — everything else
// (server URL, download folder, theme) lives in the plain settings store
// below.

export async function saveCredentials (server: string, username: string, password: string): Promise<void> {
  await invoke('save_credentials', { server, username, password })
}

export async function loadCredentials (server: string): Promise<StoredCredentials | null> {
  return await invoke<StoredCredentials | null>('load_credentials', { server })
}

export async function clearCredentials (server: string): Promise<void> {
  await invoke('clear_credentials', { server })
}

// --- Default download folder ------------------------------------------------
// Mirrored into Rust state (see src-tauri/src/main.rs) so the `on_download`
// window hook can redirect WebTorrent's finished-download stream there.

export async function defaultDownloadsDir (): Promise<string | null> {
  return await invoke<string | null>('default_downloads_dir')
}

export async function pickDownloadFolder (): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: 'Choose a default download folder' })
  return typeof selected === 'string' ? selected : null
}

async function syncDownloadDirToRust (path: string | null): Promise<void> {
  await invoke('set_download_dir', { path })
}

// --- Plain settings (server URL, download folder, theme) -------------------

let storePromise: Promise<Store> | null = null
async function settingsStore (): Promise<Store> {
  storePromise ??= load('settings.json', { autoSave: true, defaults: {} })
  return await storePromise
}

export const settings = {
  async getServerUrl (): Promise<string | null> {
    return (await (await settingsStore()).get<string>('serverUrl')) ?? null
  },
  async setServerUrl (url: string | null): Promise<void> {
    const store = await settingsStore()
    if (url) await store.set('serverUrl', url); else await store.delete('serverUrl')
  },

  async getDownloadDir (): Promise<string | null> {
    const stored = await (await settingsStore()).get<string>('downloadDir')
    const dir = stored ?? (await defaultDownloadsDir())
    await syncDownloadDirToRust(dir ?? null)
    return dir ?? null
  },
  async setDownloadDir (dir: string | null): Promise<void> {
    const store = await settingsStore()
    if (dir) await store.set('downloadDir', dir); else await store.delete('downloadDir')
    await syncDownloadDirToRust(dir)
  },

  async getThemeOverride (): Promise<'light' | 'dark' | null> {
    return (await (await settingsStore()).get<'light' | 'dark'>('theme')) ?? null
  },
  async setThemeOverride (mode: 'light' | 'dark' | null): Promise<void> {
    const store = await settingsStore()
    if (mode) await store.set('theme', mode); else await store.delete('theme')
  },

  async clearServerScoped (): Promise<void> {
    const store = await settingsStore()
    await store.delete('serverUrl')
  }
}

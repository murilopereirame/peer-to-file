import type { StoredCredentials } from '../electron-env'

export type { StoredCredentials }

// --- OS keychain (via `safeStorage` + IPC, see electron/credentials.cts) ---
// This is the one thing that's genuinely a *secret* — everything else
// (server URL, download folder, theme) lives in the plain settings store
// below.

export async function saveCredentials (server: string, username: string, password: string): Promise<void> {
  await window.p2f.saveCredentials(server, username, password)
}

export async function loadCredentials (server: string): Promise<StoredCredentials | null> {
  return await window.p2f.loadCredentials(server)
}

export async function clearCredentials (server: string): Promise<void> {
  await window.p2f.clearCredentials(server)
}

// --- Default download folder ------------------------------------------------
// Mirrored into the main process (see electron/main.cts) so the
// `will-download` session hook can redirect WebTorrent's finished-download
// stream there.

export async function defaultDownloadsDir (): Promise<string | null> {
  return await window.p2f.defaultDownloadsDir()
}

/** Like `settings.getDownloadDir()` but without the main-process resync — for
 * callers (e.g. torrentDownloads.ts) that just want to display the current
 * value, not change what `will-download` redirects into. */
export async function currentDownloadDir (): Promise<string | null> {
  const stored = await window.p2f.getSetting<string>('downloadDir')
  return stored ?? (await defaultDownloadsDir())
}

export async function pickDownloadFolder (): Promise<string | null> {
  return await window.p2f.pickDownloadFolder()
}

async function syncDownloadDirToMain (path: string | null): Promise<void> {
  await window.p2f.setDownloadDir(path)
}

// --- Plain settings (server URL, download folder, theme) -------------------

export const settings = {
  async getServerUrl (): Promise<string | null> {
    return (await window.p2f.getSetting<string>('serverUrl')) ?? null
  },
  async setServerUrl (url: string | null): Promise<void> {
    if (url) await window.p2f.setSetting('serverUrl', url); else await window.p2f.deleteSetting('serverUrl')
  },

  async getDownloadDir (): Promise<string | null> {
    const stored = await window.p2f.getSetting<string>('downloadDir')
    const dir = stored ?? (await defaultDownloadsDir())
    await syncDownloadDirToMain(dir ?? null)
    return dir ?? null
  },
  async setDownloadDir (dir: string | null): Promise<void> {
    if (dir) await window.p2f.setSetting('downloadDir', dir); else await window.p2f.deleteSetting('downloadDir')
    await syncDownloadDirToMain(dir)
  },

  async getThemeOverride (): Promise<'light' | 'dark' | null> {
    return (await window.p2f.getSetting<'light' | 'dark'>('theme')) ?? null
  },
  async setThemeOverride (mode: 'light' | 'dark' | null): Promise<void> {
    if (mode) await window.p2f.setSetting('theme', mode); else await window.p2f.deleteSetting('theme')
  },

  async clearServerScoped (): Promise<void> {
    await window.p2f.deleteSetting('serverUrl')
  }
}

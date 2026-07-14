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

// --- Post-save integrity check ----------------------------------------------
// The renderer has no way to re-read a file Electron's own download manager
// just wrote (only the main process has real filesystem access) — this
// streams the hash there so it works for arbitrarily large files.

export async function hashFile (path: string): Promise<string | null> {
  return await window.p2f.hashFile(path)
}

/** Call before triggering a download (a click/navigation) and hold onto the
 * returned ticket — it queues this download's turn in the main process
 * *before* the click can possibly fire `will-download`, so there's no
 * window where the completion could be missed. Matched to the eventual
 * `will-download` by arrival order, not by filename: two downloads of the
 * same file (a completely normal thing to retry) share a filename, and
 * matching on that let an old, already-finished download's completion
 * satisfy a brand new wait — resolving to the wrong path and, via the
 * checksum feature, hashing the wrong file entirely. */
export async function registerPendingDownload (): Promise<number> {
  return await window.p2f.registerPendingDownload()
}

/** Resolves with the finished download's actual save path once Electron's
 * download manager reports it done. */
export async function awaitDownloadCompletion (ticketId: number, timeoutMs = 10 * 60_000): Promise<string> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('timed out waiting for the download to finish')), timeoutMs)
  })
  const info = await Promise.race([window.p2f.awaitDownloadCompletion(ticketId), timeout])
  if (info.state !== 'completed') throw new Error(`download ${info.state}`)
  return info.path
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

  /** false (default): save straight to the default download folder, no
   * dialog. true: prompt for a location on every download via the native
   * Save dialog. */
  async getAskBeforeSave (): Promise<boolean> {
    return (await window.p2f.getSetting<boolean>('askBeforeSave')) ?? false
  },
  async setAskBeforeSave (value: boolean): Promise<void> {
    await window.p2f.setSetting('askBeforeSave', value)
  },

  async clearServerScoped (): Promise<void> {
    await window.p2f.deleteSetting('serverUrl')
  }
}

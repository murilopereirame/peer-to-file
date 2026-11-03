import type { DownloadCompletedInfo, RepairPhase, RepairRequest, RepairResult, StoredCredentials } from '../electron-env'

export type { RepairPhase, StoredCredentials }

// --- OS keychain (via `safeStorage` + IPC, see electron/credentials.cts) ---
// This is the one thing that's genuinely a *secret* — everything else
// (server URL, download folder, theme) lives in the plain settings store
// below.

/** F9: `refreshToken`, not the password — the raw password is never persisted. */
export async function saveCredentials (server: string, username: string, refreshToken: string): Promise<void> {
  await window.p2f.saveCredentials(server, username, refreshToken)
}

export async function loadCredentials (server: string): Promise<StoredCredentials | null> {
  return await window.p2f.loadCredentials(server)
}

export async function clearCredentials (server: string): Promise<void> {
  await window.p2f.clearCredentials(server)
}

// --- Refresh token (F9) -----------------------------------------------------
// The session's refresh token lives as a cookie in the main-process jar. These
// read it back out (to persist across restarts) and seed it on launch so
// client.refresh() can mint a fresh session without the password.
const REFRESH_COOKIE = 'p2f_refresh'

export async function readRefreshToken (origin: string): Promise<string | null> {
  return await window.p2f.getCookie(origin, REFRESH_COOKIE)
}

export async function restoreRefreshToken (origin: string, token: string): Promise<void> {
  await window.p2f.setCookie(origin, REFRESH_COOKIE, token)
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

// --- Keep-awake during transfers --------------------------------------------
// The setting below is just the user's preference (off by default); whether
// the OS is actually being held awake right now is a separate, transient
// call driven by whether a transfer is in flight — see the useKeepAwake
// hook in MainShell.tsx, which decides when to call this.

export async function setSystemKeepAwake (enabled: boolean): Promise<void> {
  await window.p2f.setKeepAwake(enabled)
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
export async function registerPendingDownload (savePath?: string): Promise<number> {
  return await window.p2f.registerPendingDownload(savePath)
}

/** Native Save dialog, shown by the main process (so it works whenever it's
 * called, unlike the renderer's gesture-bound showSaveFilePicker). Resolves
 * to the chosen path, or null if the user cancelled. */
export async function askSavePath (suggestedName: string): Promise<string | null> {
  return await window.p2f.askSavePath(suggestedName)
}

// --- Download cache folder ----------------------------------------------------
// Where in-progress download parts are kept (see fsChunkStore.ts and
// electron/pieceCache.cts). Unset means the app's own data folder.

export async function defaultCacheDir (): Promise<string> {
  return await window.p2f.defaultCacheDir()
}

export async function pickCacheFolder (): Promise<string | null> {
  return await window.p2f.pickCacheFolder()
}

/** Resolves with where Electron's download manager put the finished
 * download, and whether it says the write completed. */
export async function awaitDownloadCompletion (ticketId: number, timeoutMs = 10 * 60_000): Promise<DownloadCompletedInfo> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('timed out waiting for the download to finish')), timeoutMs)
  })
  return await Promise.race([window.p2f.awaitDownloadCompletion(ticketId), timeout])
}

// --- Piece-level repair ------------------------------------------------------
// See electron/pieceRepair.cts: checks every piece of a saved file and
// re-fetches only the ones that are missing or damaged.

export async function repairSavedDownload (
  repairId: string, req: RepairRequest, onProgress: (phase: RepairPhase, done: number, total: number) => void
): Promise<RepairResult> {
  return await window.p2f.repairDownload(repairId, req, onProgress)
}

export async function cancelRepair (repairId: string): Promise<void> {
  await window.p2f.cancelRepair(repairId)
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

  /** null when the user hasn't picked one — i.e. the default inside the
   * app's data folder (see defaultCacheDir). */
  async getCustomCacheDir (): Promise<string | null> {
    return (await window.p2f.getSetting<string>('cacheDir')) ?? null
  },
  /** The folder new downloads should keep their parts in. */
  async getCacheDir (): Promise<string> {
    return (await this.getCustomCacheDir()) ?? (await defaultCacheDir())
  },
  async setCacheDir (dir: string | null): Promise<void> {
    if (dir) await window.p2f.setSetting('cacheDir', dir); else await window.p2f.deleteSetting('cacheDir')
  },

  /** false (default): save straight to the default download folder, no
   * dialog. true: ask where to save (native Save dialog) every time a
   * download is started. */
  async getAskBeforeSave (): Promise<boolean> {
    return (await window.p2f.getSetting<boolean>('askBeforeSave')) ?? false
  },
  async setAskBeforeSave (value: boolean): Promise<void> {
    await window.p2f.setSetting('askBeforeSave', value)
  },

  /** false (default): never hold the system awake. true: while a download
   * or upload is actively running, block system sleep (see
   * setSystemKeepAwake / useKeepAwake). */
  async getKeepAwakeDuringTransfers (): Promise<boolean> {
    return (await window.p2f.getSetting<boolean>('keepAwakeDuringTransfers')) ?? false
  },
  async setKeepAwakeDuringTransfers (value: boolean): Promise<void> {
    await window.p2f.setSetting('keepAwakeDuringTransfers', value)
  },

  async clearServerScoped (): Promise<void> {
    await window.p2f.deleteSetting('serverUrl')
  }
}

// --- In-progress downloads (survive quitting the app) -----------------------
// Same idea as the browser web client's localStorage-backed list (see
// client/src/lib/downloadManager.ts), just persisted through the main
// process's settings store instead — the renderer's own origin is the fixed
// `p2file://` scheme regardless of which server is configured, not something
// scoped per-server the way a browser tab's origin is.

export interface SavedDownload {
  path: string
  name: string
  mountId?: number
  paused?: boolean
  infoHash?: string
  /** Exact destination picked via "Save as…" / "ask each time"; unset means
   * the default download folder. */
  savePath?: string
  /** Cache folder this download's parts live in — kept per download so
   * changing the setting doesn't strand a half-finished one. Unset on
   * entries saved by older versions (their parts were in OPFS). */
  cacheDir?: string
  lastActiveAt: number
}

export async function loadSavedDownloads (): Promise<SavedDownload[]> {
  return (await window.p2f.getSetting<SavedDownload[]>('downloads')) ?? []
}

export async function saveSavedDownloads (list: SavedDownload[]): Promise<void> {
  await window.p2f.setSetting('downloads', list)
}

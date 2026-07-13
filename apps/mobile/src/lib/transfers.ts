import { Directory, File, Paths } from 'expo-file-system'
import * as Legacy from 'expo-file-system/legacy'
import { Platform } from 'react-native'
import type { P2FClient } from '@p2f/shared'

export type TransferStatus = 'running' | 'paused' | 'done' | 'error' | 'canceled'

export interface DownloadItem {
  id: string
  path: string
  name: string
  status: TransferStatus
  bytesWritten: number
  totalBytes: number
  error?: string
  task?: ReturnType<typeof File.createDownloadTask>
}

export interface UploadItem {
  id: string
  destDir: string
  name: string
  status: TransferStatus
  bytesSent: number
  totalBytes: number
  error?: string
}

/**
 * Downloads go through the *signed* webseed URL from `/api/torrent`
 * (`?t=<hmac token>`, 48h TTL) rather than the plain `/api/raw` URL — that
 * token is exactly the mechanism the server already exposes for transports
 * that can't carry the session cookie (originally built for WebTorrent's
 * own fetch/WebSocket calls; see the server README). Using it here means
 * expo-file-system's native download client needs no cookie/session at
 * all, so there's nothing to get wrong across iOS/Android.
 */
export async function beginDownload (
  client: P2FClient,
  entry: { path: string, name: string, size: number | null },
  onProgress: (bytesWritten: number, totalBytes: number) => void
): Promise<{ task: ReturnType<typeof File.createDownloadTask>, run: () => Promise<File | null> }> {
  const meta = await client.torrentMeta(entry.path)
  const destination = new File(Paths.document, entry.name)
  const task = File.createDownloadTask(meta.webseed, destination, {
    onProgress: (p) => { onProgress(p.bytesWritten, p.totalBytes) }
  })
  return { task, run: () => task.downloadAsync() }
}

/**
 * Moves a finished download out of the app's private sandbox into a
 * user-chosen folder. Only meaningful on Android (Storage Access
 * Framework tree URI) — iOS has no equivalent "pick any folder" API, so a
 * finished download simply stays in the app's Documents directory, which
 * is visible in the Files app because `UIFileSharingEnabled` is set.
 *
 * Uses the legacy base64 read/write pair (the new File/Directory API has
 * no SAF support). That holds the whole file in memory for this one copy
 * step — the same worst-case trade-off the web client documents for
 * browsers without the File System Access API — but the initial download
 * itself (above) is always a true disk-to-disk stream with no such limit.
 */
export async function relocateToDownloadFolder (file: File, downloadDirUri: string | null): Promise<void> {
  if (Platform.OS !== 'android' || !downloadDirUri) return
  const base64 = await Legacy.readAsStringAsync(file.uri, { encoding: 'base64' })
  const destUri = await Legacy.StorageAccessFramework.createFileAsync(
    downloadDirUri, file.name, guessMimeType(file.name)
  )
  await Legacy.writeAsStringAsync(destUri, base64, { encoding: 'base64' })
  await file.delete()
}

function guessMimeType (name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    zip: 'application/zip', pdf: 'application/pdf', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4', txt: 'text/plain'
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Uploads a locally-picked file's raw bytes to `/api/upload`. Relies on the
 * platform's ambient cookie jar to carry the session — unlike downloads,
 * there's no signed-token path for uploads (the server only mints those for
 * reads), so this is the one transfer that depends on expo-file-system's
 * native upload client sharing cookies with the rest of the app. If that
 * ever doesn't hold on a given OS/version, the failure is a clean 401 in
 * the Uploads list, not silent corruption — log out/in re-establishes the
 * session cookie for both.
 */
export function beginUpload (
  client: P2FClient,
  destDir: string,
  fileUri: string,
  name: string,
  onProgress: (bytesSent: number, totalBytes: number) => void
): { task: ReturnType<File['createUploadTask']>, run: () => Promise<{ status: number, body: string }> } {
  const file = new File(fileUri)
  const task = file.createUploadTask(client.uploadUrl(destDir, name), {
    httpMethod: 'POST',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- UploadType enum value (BINARY_CONTENT); server expects a raw body, not multipart.
    uploadType: 0 as any,
    onProgress: (p) => { onProgress(p.bytesSent, p.totalBytes) }
  })
  return { task, run: () => task.uploadAsync() }
}

export async function listDownloadFolderLabel (uri: string | null): Promise<string> {
  if (!uri) return Platform.OS === 'ios' ? 'App Documents (Files app)' : 'App storage (default)'
  try {
    return decodeURIComponent(uri.split('/').pop() ?? uri)
  } catch {
    return uri
  }
}

export function documentsDirectory (): Directory {
  return Paths.document
}

import { Directory, File, Paths } from 'expo-file-system'
import * as Legacy from 'expo-file-system/legacy'
import { Platform } from 'react-native'
import type { P2FClient } from '@p2f/shared'
import { base64ToBytes, encryptFileForUpload } from './transferCrypto'

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
): Promise<{
  task: ReturnType<typeof File.createDownloadTask>
  run: () => Promise<File | null>
  key: Uint8Array
  iv: Uint8Array
}> {
  const meta = await client.torrentMeta(entry.path)
  const destination = new File(Paths.document, entry.name)
  const task = File.createDownloadTask(meta.webseed, destination, {
    onProgress: (p) => { onProgress(p.bytesWritten, p.totalBytes) }
  })
  // The wire carries AES-256-CTR ciphertext (see cipherCache.ts /
  // torrents.ts server-side) — the key/IV travel back to the caller so
  // decryptFileInPlace can be applied once the download finishes (see
  // DownloadsContext.tsx's finish(), which also covers the resume path
  // that doesn't call beginDownload again).
  return { task, run: () => task.downloadAsync(), key: base64ToBytes(meta.encKey), iv: base64ToBytes(meta.encIv) }
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
 *
 * Encrypted client-side (AES-256-CTR, key/IV generated per upload) before
 * it goes over the wire, mirroring the web/desktop clients — see the doc
 * comment on the /api/upload handler in src/server/app.ts. There's no
 * streaming file API here (unlike downloads' native task), so the source
 * file is read and encrypted whole into a temp file under Paths.cache,
 * which the upload task then reads from instead of the original — cleaned
 * up once the upload settles either way.
 */
export async function beginUpload (
  client: P2FClient,
  destDir: string,
  fileUri: string,
  name: string,
  onProgress: (bytesSent: number, totalBytes: number) => void
): Promise<{ task: ReturnType<File['createUploadTask']>, run: () => Promise<{ status: number, body: string }> }> {
  const source = new File(fileUri)
  const { ciphertext, headers } = await encryptFileForUpload(source)

  const tmp = new File(Paths.cache, `p2f-upload-${Date.now()}-${name}`)
  tmp.create()
  tmp.write(ciphertext)

  const task = tmp.createUploadTask(client.uploadUrl(destDir, name), {
    httpMethod: 'POST',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- UploadType enum value (BINARY_CONTENT); server expects a raw body, not multipart.
    uploadType: 0 as any,
    headers,
    onProgress: (p) => { onProgress(p.bytesSent, p.totalBytes) }
  })
  return {
    task,
    run: async () => {
      try {
        return await task.uploadAsync()
      } finally {
        try { tmp.delete() } catch { /* best-effort cleanup */ }
      }
    }
  }
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

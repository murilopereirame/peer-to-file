import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import { encryptFileForUpload, errMessage, establishKeyWrap, getServerEcdhPublicKey, joinPath, notifyOS } from '@p2f/shared'
import { useApp } from './AppContext'
import { ipcFetchWithProgress } from '../lib/client'
import { useToast } from './ToastContext'

export interface UploadEntry {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  /** Plaintext size of the selected file, known up front from the File.
   *  AES-CTR is a stream cipher, so the ciphertext on the wire is the same
   *  length and `sent` can be read against this directly. */
  size: number
  /** Bytes handed to the socket so far. */
  sent: number
  progress: number
  /** Smoothed wire speed, derived from main-process upload progress. */
  speedBytesPerSec: number
  error?: string
}

interface Ctx {
  uploads: UploadEntry[]
  start: (destDir: string, file: File, onSettled?: () => void) => void
  remove: (id: string) => void
}

const UploadsContext = createContext<Ctx | null>(null)

export function useUploads (): Ctx {
  const ctx = useContext(UploadsContext)
  if (!ctx) throw new Error('useUploads must be used inside UploadsProvider')
  return ctx
}

export function UploadsProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const app = useApp()
  const notify = useToast()
  const [uploads, setUploads] = useState<UploadEntry[]>([])
  // Last progress report per upload, to turn cumulative byte counts into a
  // rate for the speed readout/graph.
  const lastProgress = useRef(new Map<string, { at: number, sent: number, speed: number }>())

  const patch = useCallback((id: string, fields: Partial<UploadEntry>) => {
    setUploads(prev => prev.map(u => u.id === id ? { ...u, ...fields } : u))
  }, [])

  // Reads the whole file into memory before sending — acceptable on
  // desktop's RAM budget, and there's no signed-token/streamed path for
  // uploads the way there is for downloads (see torrentDownloads.ts); this
  // mirrors the same worst-case trade-off the browser client documents for
  // its own Blob fallback. Encrypted client-side (AES-256-CTR, key/IV
  // generated per upload, then ECDH-wrapped so the wire never carries the
  // key either) — see the doc comment on the /api/upload handler in
  // src/server/app.ts and packages/shared/src/browserCrypto.ts.
  const start = useCallback((destDir: string, file: File, onSettled?: () => void) => {
    const client = app.client
    if (!client) return
    const id = `${destDir}/${file.name}#${Date.now()}`
    const startedAt = Date.now()
    setUploads(prev => [
      { id, name: file.name, status: 'running', size: file.size, sent: 0, progress: 0, speedBytesPerSec: 0 },
      ...prev
    ])

    // Exponentially smoothed so the graph shows a trend rather than the
    // sawtooth of however large a chunk the socket last accepted — same
    // treatment the web client gives its XHR progress events.
    const onProgress = (sent: number, total: number): void => {
      const now = performance.now()
      const previous = lastProgress.current.get(id)
      let speed = previous?.speed ?? 0
      if (previous && now > previous.at) {
        const instant = (sent - previous.sent) / ((now - previous.at) / 1000)
        speed = previous.speed === 0 ? instant : previous.speed * 0.6 + instant * 0.4
      }
      lastProgress.current.set(id, { at: now, sent, speed })
      patch(id, { sent, progress: total > 0 ? sent / total : 0, speedBytesPerSec: Math.max(0, speed) })
    }

    void (async () => {
      const serverPublicKey = await getServerEcdhPublicKey(async () => client.info())
      const keyWrap = await establishKeyWrap(serverPublicKey)
      return encryptFileForUpload(file, keyWrap)
    })()
      .then(async ({ body, headers }) => ipcFetchWithProgress(client.uploadUrl(destDir, file.name), {
        method: 'POST',
        // X-P2F-Csrf: F5 CSRF guard on cookie-authenticated mutations.
        headers: { 'Content-Type': 'application/octet-stream', 'X-P2F-Csrf': '1', ...headers },
        body: await body.arrayBuffer()
      }, onProgress))
      .then(res => {
        if (res.ok) {
          patch(id, { status: 'done', sent: file.size, progress: 1, speedBytesPerSec: 0 })
          void client.uploadHistoryRecord(joinPath(destDir, file.name), file.name, file.size, Date.now() - startedAt)
          notify(`"${file.name}" finished uploading`)
          notifyOS('Upload complete', file.name)
        } else {
          patch(id, {
            status: 'error', speedBytesPerSec: 0, error: `server rejected the upload (HTTP ${res.status})`
          })
        }
      })
      .catch(err => { patch(id, { status: 'error', speedBytesPerSec: 0, error: errMessage(err) }) })
      .finally(() => {
        lastProgress.current.delete(id)
        onSettled?.()
      })
  }, [app, patch, notify])

  const remove = useCallback((id: string) => {
    lastProgress.current.delete(id)
    setUploads(prev => prev.filter(u => u.id !== id))
  }, [])

  return <UploadsContext.Provider value={{ uploads, start, remove }}>{children}</UploadsContext.Provider>
}

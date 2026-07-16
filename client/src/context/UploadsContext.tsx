import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { encryptFileForUpload, establishKeyWrap, getServerEcdhPublicKey, joinPath, notifyOS } from '@p2f/shared'
import { useApi } from './ApiContext'
import { useToast } from './ToastContext'

export type UploadStatus = 'uploading' | 'done' | 'error'

export interface UploadEntry {
  id: string
  name: string
  progress: number
  status: UploadStatus
  message?: string
}

interface Ctx {
  uploads: UploadEntry[]
  start: (destDir: string, file: File, onSettled?: () => void) => void
  dismiss: (id: string) => void
}

const UploadsContext = createContext<Ctx | null>(null)

export function useUploads (): Ctx {
  const ctx = useContext(UploadsContext)
  if (!ctx) throw new Error('useUploads must be used within an UploadsProvider')
  return ctx
}

/**
 * Uploads are short-lived and don't need to survive a reload (unlike
 * downloads), so this is plain component state driven by XHR upload
 * progress events — fetch() has no upload-progress API. Held in a Provider
 * (rather than a plain hook instantiated per call site) so the Transfers
 * tab and the file browser's upload trigger see the same in-flight queue.
 */
export function UploadsProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { apiBase, apiFetch } = useApi()
  const notify = useToast()
  const [uploads, setUploads] = useState<UploadEntry[]>([])
  const inFlight = useRef(new Map<string, XMLHttpRequest>())

  // Abort any still-running uploads if the browser view unmounts (e.g. the
  // user signs out mid-upload) instead of leaving them running to completion
  // with nothing left to receive their progress/completion events.
  useEffect(() => {
    const xhrs = inFlight.current
    return () => { for (const xhr of xhrs.values()) xhr.abort() }
  }, [])

  const patch = useCallback((id: string, patch: Partial<UploadEntry>) => {
    setUploads(list => list.map(u => (u.id === id ? { ...u, ...patch } : u)))
  }, [])

  const start = useCallback((destDir: string, file: File, onSettled?: () => void) => {
    if (!apiBase) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const startedAt = Date.now()
    setUploads(list => [...list, { id, name: file.name, progress: 0, status: 'uploading' }])

    // Encrypted client-side (AES-256-CTR, key/IV generated per upload, then
    // ECDH-wrapped so the wire never carries the key either) — see the doc
    // comment on the /api/upload handler in src/server/app.ts and
    // packages/shared/src/browserCrypto.ts.
    void (async () => {
      const serverPublicKey = await getServerEcdhPublicKey(async () => {
        const res = await apiFetch('/api/info')
        return await res.json() as { ecdhPublicKey: string }
      })
      const keyWrap = await establishKeyWrap(serverPublicKey)
      return encryptFileForUpload(file, keyWrap)
    })().then(({ body, headers }) => {
      const url = `${apiBase}/api/upload?path=${encodeURIComponent(destDir)}&name=${encodeURIComponent(file.name)}`
      const xhr = new XMLHttpRequest()
      inFlight.current.set(id, xhr)
      xhr.open('POST', url)
      xhr.withCredentials = true
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) patch(id, { progress: e.loaded / e.total })
      })
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          patch(id, { progress: 1, status: 'done' })
          void apiFetch('/api/uploads/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: joinPath(destDir, file.name), name: file.name, length: file.size, durationMs: Date.now() - startedAt
            })
          })
          notify(`"${file.name}" finished uploading`)
          notifyOS('Upload complete', file.name)
        } else {
          let message = `HTTP ${xhr.status}`
          try {
            const responseBody = JSON.parse(xhr.responseText) as { error?: string }
            if (responseBody.error) message = responseBody.error
          } catch { /* non-JSON error body */ }
          patch(id, { status: 'error', message })
        }
      })
      xhr.addEventListener('error', () => patch(id, { status: 'error', message: 'network error' }))
      xhr.addEventListener('loadend', () => { inFlight.current.delete(id); onSettled?.() })
      xhr.send(body)
    }, err => {
      patch(id, { status: 'error', message: err instanceof Error ? err.message : 'encryption failed' })
      onSettled?.()
    })
  }, [apiBase, apiFetch, patch, notify])

  const dismiss = useCallback((id: string) => {
    setUploads(list => list.filter(u => u.id !== id))
  }, [])

  return <UploadsContext.Provider value={{ uploads, start, dismiss }}>{children}</UploadsContext.Provider>
}

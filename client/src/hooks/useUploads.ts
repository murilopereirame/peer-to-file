import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '../context/ApiContext'
import { encryptFileForUpload, establishKeyWrap, getServerEcdhPublicKey } from '@p2f/shared'

export type UploadStatus = 'uploading' | 'done' | 'error'

export interface UploadEntry {
  id: string
  name: string
  progress: number
  status: UploadStatus
  message?: string
}

/**
 * Uploads are short-lived and don't need to survive a reload (unlike
 * downloads), so this is plain component state driven by XHR upload
 * progress events — fetch() has no upload-progress API.
 */
export function useUploads (onUploaded: () => void): {
  uploads: UploadEntry[]
  upload: (file: File, destPath: string) => void
  dismiss: (id: string) => void
} {
  const { apiBase, apiFetch } = useApi()
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

  const upload = useCallback((file: File, destPath: string) => {
    if (!apiBase) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
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
      const url = `${apiBase}/api/upload?path=${encodeURIComponent(destPath)}&name=${encodeURIComponent(file.name)}`
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
          onUploaded()
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
      xhr.addEventListener('loadend', () => { inFlight.current.delete(id) })
      xhr.send(body)
    }, err => {
      patch(id, { status: 'error', message: err instanceof Error ? err.message : 'encryption failed' })
    })
  }, [apiBase, apiFetch, patch, onUploaded])

  const dismiss = useCallback((id: string) => {
    setUploads(list => list.filter(u => u.id !== id))
  }, [])

  return { uploads, upload, dismiss }
}

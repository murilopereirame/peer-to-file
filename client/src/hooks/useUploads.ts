import { useCallback, useState } from 'react'
import { useApi } from '../context/ApiContext'

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
  const { apiBase } = useApi()
  const [uploads, setUploads] = useState<UploadEntry[]>([])

  const patch = useCallback((id: string, patch: Partial<UploadEntry>) => {
    setUploads(list => list.map(u => (u.id === id ? { ...u, ...patch } : u)))
  }, [])

  const upload = useCallback((file: File, destPath: string) => {
    if (!apiBase) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setUploads(list => [...list, { id, name: file.name, progress: 0, status: 'uploading' }])

    const url = `${apiBase}/api/upload?path=${encodeURIComponent(destPath)}&name=${encodeURIComponent(file.name)}`
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = true
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
          const body = JSON.parse(xhr.responseText) as { error?: string }
          if (body.error) message = body.error
        } catch { /* non-JSON error body */ }
        patch(id, { status: 'error', message })
      }
    })
    xhr.addEventListener('error', () => patch(id, { status: 'error', message: 'network error' }))
    xhr.send(file)
  }, [apiBase, patch, onUploaded])

  const dismiss = useCallback((id: string) => {
    setUploads(list => list.filter(u => u.id !== id))
  }, [])

  return { uploads, upload, dismiss }
}

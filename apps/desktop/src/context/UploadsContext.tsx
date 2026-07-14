import React, { createContext, useCallback, useContext, useState } from 'react'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { encryptFileForUpload, errMessage, establishKeyWrap, getServerEcdhPublicKey } from '@p2f/shared'
import { useApp } from './AppContext'

export interface UploadEntry {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
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
  const [uploads, setUploads] = useState<UploadEntry[]>([])

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
    setUploads(prev => [{ id, name: file.name, status: 'running' }, ...prev])
    void (async () => {
      const serverPublicKey = await getServerEcdhPublicKey(async () => client.info())
      const keyWrap = await establishKeyWrap(serverPublicKey)
      return encryptFileForUpload(file, keyWrap)
    })()
      .then(async ({ body, headers }) => tauriFetch(client.uploadUrl(destDir, file.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body: await body.arrayBuffer()
      }))
      .then(res => {
        if (res.ok) patch(id, { status: 'done' })
        else patch(id, { status: 'error', error: `server rejected the upload (HTTP ${res.status})` })
      })
      .catch(err => { patch(id, { status: 'error', error: errMessage(err) }) })
      .finally(() => { onSettled?.() })
  }, [app, patch])

  const remove = useCallback((id: string) => { setUploads(prev => prev.filter(u => u.id !== id)) }, [])

  return <UploadsContext.Provider value={{ uploads, start, remove }}>{children}</UploadsContext.Provider>
}

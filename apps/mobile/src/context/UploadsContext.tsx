import React, { createContext, useCallback, useContext, useState } from 'react'
import { errMessage } from '@p2f/shared'
import { useApp } from './AppContext'
import { beginUpload, type TransferStatus } from '../lib/transfers'

export interface UploadEntry {
  id: string
  destDir: string
  name: string
  status: TransferStatus
  bytesSent: number
  totalBytes: number
  error?: string
}

interface Ctx {
  uploads: UploadEntry[]
  start: (destDir: string, fileUri: string, name: string, onSettled?: () => void) => void
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

  const start = useCallback((destDir: string, fileUri: string, name: string, onSettled?: () => void) => {
    const client = app.client
    if (!client) return
    const id = `${destDir}/${name}#${Date.now()}`
    setUploads(prev => [{ id, destDir, name, status: 'running', bytesSent: 0, totalBytes: 0 }, ...prev])
    const { run } = beginUpload(client, destDir, fileUri, name, (sent, total) => {
      patch(id, { bytesSent: sent, totalBytes: total })
    })
    void run()
      .then((result) => {
        if (result.status >= 200 && result.status < 300) {
          patch(id, { status: 'done' })
        } else {
          patch(id, { status: 'error', error: `server rejected the upload (HTTP ${result.status})` })
        }
      })
      .catch((err) => { patch(id, { status: 'error', error: errMessage(err) }) })
      .finally(() => { onSettled?.() })
  }, [app, patch])

  const remove = useCallback((id: string) => {
    setUploads(prev => prev.filter(u => u.id !== id))
  }, [])

  return <UploadsContext.Provider value={{ uploads, start, remove }}>{children}</UploadsContext.Provider>
}

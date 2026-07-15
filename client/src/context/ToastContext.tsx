import { createContext, useCallback, useContext, useRef, useState } from 'react'

export type ToastKind = 'success' | 'error' | 'info'

interface Toast {
  id: number
  message: string
  kind: ToastKind
}

const ToastContext = createContext<((message: string, kind?: ToastKind) => void) | null>(null)

const TOAST_TTL_MS = 3500

export function ToastProvider ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts(list => list.filter(t => t.id !== id))
  }, [])

  const notify = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = nextId.current++
    setToasts(list => [...list, { id, message, kind }])
    setTimeout(() => dismiss(id), TOAST_TTL_MS)
  }, [dismiss])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-stack">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast (): (message: string, kind?: ToastKind) => void {
  const notify = useContext(ToastContext)
  if (!notify) throw new Error('useToast must be used within a ToastProvider')
  return notify
}

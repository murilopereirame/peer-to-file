import { createContext, useContext } from 'react'

export interface ApiContextValue {
  apiBase: string | null
  apiFetch: (pathname: string, init?: RequestInit) => Promise<Response>
}

export const ApiContext = createContext<ApiContextValue | null>(null)

export function useApi (): ApiContextValue {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error('useApi() used outside <ApiContext.Provider>')
  return ctx
}

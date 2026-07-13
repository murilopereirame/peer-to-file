export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
}

export interface Listing {
  path: string
  entries: DirEntry[]
}

export interface AuthInfo {
  required: boolean
  needsSetup: boolean
  authenticated: boolean
}

export interface ServerInfo {
  name: string
  version: string
  webrtcSeeding: boolean
  auth: AuthInfo
}

export interface LogEntry {
  id: number
  ts: number
  kind: string
  message: string
  [key: string]: unknown
}

export interface HistoryEntry {
  path: string
  name: string
  length: number
  finishedAt: number
}

export interface TorrentMeta {
  name: string
  length: number
  infoHash: string
  pieceLength: number
  announce: string[]
  webseed: string
  magnet: string
  torrentBase64: string
  /** Base64 AES-256 key for the transfer-encryption ciphertext this torrent/webseed carries. */
  encKey: string
  /** Base64 AES-CTR IV/nonce paired with encKey. */
  encIv: string
}

export interface Credentials {
  serverUrl: string
  username: string
  password: string
}

/** Thrown by P2FClient for any non-2xx response, or a network-level failure. */
export class ApiError extends Error {
  readonly status: number

  constructor (status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function isUnauthorized (err: unknown): boolean {
  return err instanceof ApiError && err.status === 401
}

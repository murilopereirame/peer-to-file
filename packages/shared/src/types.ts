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
  /** Base64 raw ECDH (P-256) public key — see browserCrypto.ts's establishKeyWrap. */
  ecdhPublicKey: string
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
  id: number
  path: string
  name: string
  length: number
  completed_at: number
  info_hash: string | null
  duration_ms: number | null
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
  /**
   * Base64 ECDH-wrapped AES-256-CTR key+IV for the ciphertext this torrent/
   * webseed carries — unwrap with the same keypair used to request this
   * metadata (see browserCrypto.ts's establishKeyWrap/unwrapKeyMaterial).
   */
  encKeyWrapped: string
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

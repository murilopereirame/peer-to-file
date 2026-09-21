export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
  isSymlink: boolean
}

export interface Listing {
  path: string
  entries: DirEntry[]
}

export type Role = 'user' | 'admin'

/** A filesystem root the server shares. See src/server/db.ts's Mount. */
export interface MountInfo {
  id: number
  name: string
  isDefault: boolean
  /** Only present for an admin caller — the path itself isn't needed to browse it. */
  path?: string
}

export interface MountAccessEntry {
  user_id: number
  username: string
  granted_at: number
}

/** Admin-only view of a mount, including who has access to it. */
export interface AdminMount {
  id: number
  name: string
  path: string
  isDefault: boolean
  createdAt: number
  access: MountAccessEntry[]
}

export interface AdminUser {
  id: number
  username: string
  role: Role
  createdAt: number
}

export interface SearchHit {
  path: string
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
  isSymlink: boolean
  mount: { id: number, name: string }
}

export interface SearchResponse {
  query: string
  results: SearchHit[]
  /** True when the result set may be incomplete (hit the limit, or a scan budget on a huge tree). */
  truncated: boolean
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
  /** SHA-256 (hex) of the original plaintext — lets a client verify a
   * finished download decrypted and saved correctly, independent of
   * BitTorrent's own per-piece hashing of the ciphertext. */
  plainSha256: string
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

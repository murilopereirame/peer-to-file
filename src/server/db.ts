import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import nodePath from 'node:path'

/**
 * Persistence for authentication, built on Node's bundled SQLite
 * (node:sqlite) — no native modules to compile or download.
 *
 * Only credential *hashes* are stored: passwords as scrypt, API tokens and
 * session ids as SHA-256. The database contains no recoverable secrets
 * except the transfer-token HMAC key in `meta`.
 */

export interface User {
  id: number
  username: string
  created_at: number
}

export interface ApiTokenInfo {
  id: number
  user_id: number
  name: string
  created_at: number
  last_used_at: number | null
  expires_at: number | null
}

export interface DownloadHistoryEntry {
  id: number
  path: string
  name: string
  length: number
  completed_at: number
  info_hash: string | null
  duration_ms: number | null
}

// N raised to 2^17 (OWASP guidance). Old hashes stored with a smaller N still
// verify — the parameters are encoded in each hash string — and are upgraded
// transparently on the next successful login (see needsRehash / upgrade below).
// maxmem must be raised in step with N: scrypt needs ~128*N*r bytes, which at
// N=2^17 exceeds node's 32 MiB default.
const SCRYPT_N = 131072
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 256 * 1024 * 1024

function hashPassword (password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword (password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltHex, hashHex] = parts as [string, string, string, string, string, string]
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM
  })
  return crypto.timingSafeEqual(actual, expected)
}

/** True if a stored hash uses weaker parameters than the current target. */
function needsRehash (stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true
  const [, n, r, p] = parts
  return Number(n) < SCRYPT_N || Number(r) < SCRYPT_R || Number(p) < SCRYPT_P
}

const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex')

export class AuthDb {
  private readonly db: DatabaseSync

  constructor (path: string) {
    // node:sqlite creates the database *file* on first open but not its
    // parent directories (e.g. a fresh /config volume with nothing in it
    // yet) — ensure the directory exists first, same as `mkdir -p`. Skip
    // SQLite's special in-memory pseudo-paths, which aren't real files.
    if (path !== ':memory:' && path !== '') {
      fs.mkdirSync(nodePath.dirname(path), { recursive: true })
    }
    this.db = new DatabaseSync(path)
    // Default (rollback) journal mode, not WAL: this is a single-process,
    // low-concurrency local database, so WAL's extra -shm/-wal side files
    // and locking buy nothing here and are one more thing that can misbehave
    // under a sandboxed CI filesystem.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS download_history (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        length INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_download_history_user
        ON download_history(user_id, completed_at DESC);
    `)
    // Added after the initial release — CREATE TABLE IF NOT EXISTS above
    // leaves an existing table's columns untouched, so a pre-existing
    // database needs these added explicitly. Nullable: rows recorded before
    // this migration (and any future caller that omits them) just have no
    // hash/duration to show.
    for (const stmt of [
      'ALTER TABLE download_history ADD COLUMN info_hash TEXT',
      'ALTER TABLE download_history ADD COLUMN duration_ms INTEGER',
      "ALTER TABLE download_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'download'",
      // Nullable: a NULL expiry means "never expires", so API tokens created
      // before this migration keep working unchanged.
      'ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER'
    ]) {
      try { this.db.exec(stmt) } catch { /* column already exists */ }
    }
  }

  close (): void {
    this.db.close()
  }

  // --- users ---------------------------------------------------------------

  createUser (username: string, password: string): User {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) {
      throw new Error('username must be 1-64 chars of letters, digits, . _ -')
    }
    if (password.length < 12) {
      throw new Error('password must be at least 12 characters')
    }
    const now = Date.now()
    const res = this.db.prepare(
      'INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)'
    ).run(username, hashPassword(password), now)
    return { id: Number(res.lastInsertRowid), username, created_at: now }
  }

  /**
   * Create the very first user (first-run web setup). Atomic against other
   * requests in this process: node:sqlite is synchronous and there is no
   * `await` between the count check and the insert, so nothing else in this
   * single-process server can interleave. Throws if a user already exists.
   */
  setupFirstUser (username: string, password: string): User {
    if (this.userCount() > 0) {
      throw new Error('setup already completed')
    }
    return this.createUser(username, password)
  }

  deleteUser (username: string): boolean {
    return this.db.prepare('DELETE FROM users WHERE username = ?').run(username).changes > 0
  }

  listUsers (): User[] {
    return this.db.prepare(
      'SELECT id, username, created_at FROM users ORDER BY username'
    ).all() as unknown as User[]
  }

  userCount (): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return row.n
  }

  verifyCredentials (username: string, password: string): User | null {
    const row = this.db.prepare(
      'SELECT id, username, pass_hash, created_at FROM users WHERE username = ?'
    ).get(username) as ({ id: number, username: string, pass_hash: string, created_at: number } | undefined)
    if (!row || !verifyPassword(password, row.pass_hash)) return null
    // Transparently upgrade a hash stored with weaker (older) scrypt params
    // now that we've verified the plaintext once.
    if (needsRehash(row.pass_hash)) {
      this.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), row.id)
    }
    return { id: row.id, username: row.username, created_at: row.created_at }
  }

  // --- sessions (short-lived access) + refresh tokens ---------------------
  // Cookie values are raw random ids; only their SHA-256 hashes are stored.
  // Access sessions are a hard TTL (no sliding renewal); the refresh token
  // below is what extends a login, rotating single-use on each /api/refresh.

  createSession (userId: number, ttlMs: number): string {
    const id = crypto.randomBytes(32).toString('hex')
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sha256(id), userId, now, now + ttlMs)
    return id
  }

  getSessionUser (sessionId: string): User | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.created_at, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?
    `).get(sha256(sessionId)) as ({ id: number, username: string, created_at: number, expires_at: number } | undefined)
    if (!row) return null
    if (row.expires_at < Date.now()) {
      this.deleteSession(sessionId)
      return null
    }
    return { id: row.id, username: row.username, created_at: row.created_at }
  }

  deleteSession (sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(sessionId))
  }

  createRefreshToken (userId: number, ttlMs: number): string {
    const id = crypto.randomBytes(32).toString('hex')
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO refresh_tokens (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sha256(id), userId, now, now + ttlMs)
    return id
  }

  /**
   * Single-use: validates a refresh token and deletes it (rotation), returning
   * its user. node:sqlite is synchronous with no await between the read and the
   * delete, so a token can't be redeemed twice by concurrent requests.
   */
  consumeRefreshToken (refreshId: string): User | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.created_at, r.expires_at FROM refresh_tokens r
      JOIN users u ON u.id = r.user_id WHERE r.id_hash = ?
    `).get(sha256(refreshId)) as ({ id: number, username: string, created_at: number, expires_at: number } | undefined)
    if (!row) return null
    this.db.prepare('DELETE FROM refresh_tokens WHERE id_hash = ?').run(sha256(refreshId))
    if (row.expires_at < Date.now()) return null
    return { id: row.id, username: row.username, created_at: row.created_at }
  }

  deleteRefreshToken (refreshId: string): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE id_hash = ?').run(sha256(refreshId))
  }

  /** Revoke every access session and refresh token for a user. */
  deleteAllUserSessions (userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    this.db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId)
  }

  pruneExpiredSessions (): void {
    const now = Date.now()
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    this.db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now)
  }

  // --- API tokens (Bearer) --------------------------------------------------

  /** `ttlMs` null → non-expiring token; otherwise it expires ttlMs from now. */
  createApiToken (username: string, name: string, ttlMs: number | null = null): string {
    const user = this.db.prepare('SELECT id FROM users WHERE username = ?')
      .get(username) as ({ id: number } | undefined)
    if (!user) throw new Error(`no such user: ${username}`)
    const token = `p2f_${crypto.randomBytes(32).toString('base64url')}`
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO api_tokens (user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(user.id, name, sha256(token), now, ttlMs === null ? null : now + ttlMs)
    return token
  }

  getTokenUser (token: string): User | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.created_at, t.id AS token_id, t.expires_at FROM api_tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?
    `).get(sha256(token)) as ({ id: number, username: string, created_at: number, token_id: number, expires_at: number | null } | undefined)
    if (!row) return null
    // NULL expiry = never expires (grandfathered / explicitly non-expiring).
    if (row.expires_at !== null && row.expires_at < Date.now()) return null
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run(Date.now(), row.token_id)
    return { id: row.id, username: row.username, created_at: row.created_at }
  }

  listApiTokens (username?: string): ApiTokenInfo[] {
    const sql = `
      SELECT t.id, t.user_id, t.name, t.created_at, t.last_used_at, t.expires_at FROM api_tokens t
      JOIN users u ON u.id = t.user_id
      ${username ? 'WHERE u.username = ?' : ''} ORDER BY t.id
    `
    const stmt = this.db.prepare(sql)
    return (username ? stmt.all(username) : stmt.all()) as unknown as ApiTokenInfo[]
  }

  deleteApiToken (id: number): boolean {
    return this.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes > 0
  }

  // --- meta ------------------------------------------------------------------

  /** Stable random HMAC key for transfer tokens, created on first use. */
  transferSecret (): Buffer {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .get('transfer_secret') as ({ value: string } | undefined)
    if (row) return Buffer.from(row.value, 'hex')
    const secret = crypto.randomBytes(32)
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('transfer_secret', secret.toString('hex'))
    return secret
  }

  /**
   * Stable random master secret the ciphertext cache (cipherCache.ts) derives
   * per-file transfer-encryption keys from, created on first use. Must be
   * stable across restarts — deriving a *different* key per process would
   * re-encrypt unchanged files to different ciphertext, and with it a
   * different infohash, breaking the "resume after a server restart"
   * property the whole torrent-metadata cache depends on.
   */
  cipherMasterSecret (): Buffer {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .get('cipher_secret') as ({ value: string } | undefined)
    if (row) return Buffer.from(row.value, 'hex')
    const secret = crypto.randomBytes(32)
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('cipher_secret', secret.toString('hex'))
    return secret
  }

  /**
   * Stable ECDH (P-256) private key the server uses to receive transfer
   * keys wrapped by a client's ephemeral keypair (keyExchange.ts) — this is
   * what keeps the AES-256-CTR key/IV for a transfer from ever crossing the
   * wire in the clear, independent of TLS: a passive observer of the
   * ciphertext and the wrapped-key blob still can't derive the shared
   * secret without solving ECDH. Stable across restarts so the server's
   * public key (handed out via /api/info) doesn't change under clients.
   */
  ecdhPrivateKey (): Buffer {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .get('ecdh_private_key') as ({ value: string } | undefined)
    if (row) return Buffer.from(row.value, 'hex')
    const ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
    const privateKey = ecdh.getPrivateKey()
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('ecdh_private_key', privateKey.toString('hex'))
    return privateKey
  }

  // --- transfer history ---------------------------------------------------
  // Scoped by user_id when auth is on; NULL (a single shared, unscoped
  // history) when it's off, since there's no user identity to key it by.
  // Downloads and uploads share one table, distinguished by `kind` — kept
  // as separate public methods/endpoints per transfer type rather than one
  // generic API, since download entries carry an info_hash and upload
  // entries never do.

  private recordTransfer (
    kind: 'download' | 'upload', userId: number | null, path: string, name: string, length: number,
    infoHash: string | null, durationMs: number | null
  ): void {
    this.db.prepare(
      'INSERT INTO download_history (user_id, kind, path, name, length, completed_at, info_hash, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, kind, path, name, length, Date.now(), infoHash, durationMs)
  }

  private listTransferHistory (kind: 'download' | 'upload', userId: number | null, limit: number): DownloadHistoryEntry[] {
    const sql = `
      SELECT id, path, name, length, completed_at, info_hash, duration_ms FROM download_history
      WHERE kind = ? AND user_id ${userId === null ? 'IS NULL' : '= ?'}
      ORDER BY completed_at DESC LIMIT ?
    `
    const stmt = this.db.prepare(sql)
    const rows = userId === null ? stmt.all(kind, limit) : stmt.all(kind, userId, limit)
    return rows as unknown as DownloadHistoryEntry[]
  }

  private clearTransferHistory (kind: 'download' | 'upload', userId: number | null): void {
    const sql = `DELETE FROM download_history WHERE kind = ? AND user_id ${userId === null ? 'IS NULL' : '= ?'}`
    const stmt = this.db.prepare(sql)
    if (userId === null) stmt.run(kind)
    else stmt.run(kind, userId)
  }

  recordDownload (
    userId: number | null, path: string, name: string, length: number,
    infoHash: string | null = null, durationMs: number | null = null
  ): void {
    this.recordTransfer('download', userId, path, name, length, infoHash, durationMs)
  }

  listDownloadHistory (userId: number | null, limit = 200): DownloadHistoryEntry[] {
    return this.listTransferHistory('download', userId, limit)
  }

  clearDownloadHistory (userId: number | null): void {
    this.clearTransferHistory('download', userId)
  }

  recordUpload (
    userId: number | null, path: string, name: string, length: number, durationMs: number | null = null
  ): void {
    this.recordTransfer('upload', userId, path, name, length, null, durationMs)
  }

  listUploadHistory (userId: number | null, limit = 200): DownloadHistoryEntry[] {
    return this.listTransferHistory('upload', userId, limit)
  }

  clearUploadHistory (userId: number | null): void {
    this.clearTransferHistory('upload', userId)
  }
}

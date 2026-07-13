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
}

export interface DownloadHistoryEntry {
  id: number
  path: string
  name: string
  length: number
  completed_at: number
}

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

function hashPassword (password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword (password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltHex, hashHex] = parts as [string, string, string, string, string, string]
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p)
  })
  return crypto.timingSafeEqual(actual, expected)
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
  }

  close (): void {
    this.db.close()
  }

  // --- users ---------------------------------------------------------------

  createUser (username: string, password: string): User {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) {
      throw new Error('username must be 1-64 chars of letters, digits, . _ -')
    }
    if (password.length < 8) {
      throw new Error('password must be at least 8 characters')
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
    return { id: row.id, username: row.username, created_at: row.created_at }
  }

  // --- sessions (cookie value is the raw id; only its hash is stored) ------

  createSession (userId: number, ttlMs: number): string {
    const id = crypto.randomBytes(32).toString('hex')
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sha256(id), userId, now, now + ttlMs)
    return id
  }

  getSessionUser (sessionId: string, slideTtlMs?: number): User | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.created_at, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?
    `).get(sha256(sessionId)) as ({ id: number, username: string, created_at: number, expires_at: number } | undefined)
    if (!row) return null
    if (row.expires_at < Date.now()) {
      this.deleteSession(sessionId)
      return null
    }
    if (slideTtlMs) {
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?')
        .run(Date.now() + slideTtlMs, sha256(sessionId))
    }
    return { id: row.id, username: row.username, created_at: row.created_at }
  }

  deleteSession (sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(sessionId))
  }

  pruneExpiredSessions (): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  }

  // --- API tokens (Bearer) --------------------------------------------------

  createApiToken (username: string, name: string): string {
    const user = this.db.prepare('SELECT id FROM users WHERE username = ?')
      .get(username) as ({ id: number } | undefined)
    if (!user) throw new Error(`no such user: ${username}`)
    const token = `p2f_${crypto.randomBytes(32).toString('base64url')}`
    this.db.prepare(
      'INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(user.id, name, sha256(token), Date.now())
    return token
  }

  getTokenUser (token: string): User | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.created_at, t.id AS token_id FROM api_tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?
    `).get(sha256(token)) as ({ id: number, username: string, created_at: number, token_id: number } | undefined)
    if (!row) return null
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run(Date.now(), row.token_id)
    return { id: row.id, username: row.username, created_at: row.created_at }
  }

  listApiTokens (username?: string): ApiTokenInfo[] {
    const sql = `
      SELECT t.id, t.user_id, t.name, t.created_at, t.last_used_at FROM api_tokens t
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

  // --- download history -------------------------------------------------
  // Scoped by user_id when auth is on; NULL (a single shared, unscoped
  // history) when it's off, since there's no user identity to key it by.

  recordDownload (userId: number | null, path: string, name: string, length: number): void {
    this.db.prepare(
      'INSERT INTO download_history (user_id, path, name, length, completed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, path, name, length, Date.now())
  }

  listDownloadHistory (userId: number | null, limit = 200): DownloadHistoryEntry[] {
    const sql = `
      SELECT id, path, name, length, completed_at FROM download_history
      WHERE user_id ${userId === null ? 'IS NULL' : '= ?'}
      ORDER BY completed_at DESC LIMIT ?
    `
    const stmt = this.db.prepare(sql)
    const rows = userId === null ? stmt.all(limit) : stmt.all(userId, limit)
    return rows as unknown as DownloadHistoryEntry[]
  }

  clearDownloadHistory (userId: number | null): void {
    const sql = `DELETE FROM download_history WHERE user_id ${userId === null ? 'IS NULL' : '= ?'}`
    const stmt = this.db.prepare(sql)
    if (userId === null) stmt.run()
    else stmt.run(userId)
  }
}

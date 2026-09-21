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

export type Role = 'user' | 'admin'

export interface User {
  id: number
  username: string
  role: Role
  created_at: number
  /** The mount this user should land on by default, overriding the global
   *  default mount — set by an admin, null to fall back to the global one.
   *  Only populated by queries that select it explicitly (listUsers,
   *  getUserByUsername, getUserById); omitted elsewhere (e.g. auth lookups
   *  that don't need it). */
  default_mount_id?: number | null
}

export interface Mount {
  id: number
  name: string
  path: string
  /** True for the single mount seeded from P2F_ROOT — always accessible to
   *  every authenticated user, can't be deleted, and can't be gated by
   *  mount_access (preserves the pre-multi-mount behavior of the root). */
  is_default: boolean
  created_at: number
  created_by: number | null
}

export interface MountAccessEntry {
  user_id: number
  username: string
  granted_at: number
}

export interface MountDenialEntry {
  user_id: number
  username: string
  denied_at: number
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
      CREATE TABLE IF NOT EXISTS mounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        -- Deliberately not UNIQUE: the same directory can legitimately be
        -- shared under two names with different access grants, and the
        -- default mount (seeded from P2F_ROOT) must be free to coincide
        -- with an admin-created mount pointing at the same place.
        path TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      -- At most one mount may be the default (seeded from P2F_ROOT).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mounts_one_default
        ON mounts(is_default) WHERE is_default = 1;
      CREATE TABLE IF NOT EXISTS mount_access (
        mount_id INTEGER NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (mount_id, user_id)
      );
      -- Explicit exclusions from the default mount, which every user can
      -- otherwise browse implicitly (see the mounts section below). Only
      -- meaningful for the default mount: every other mount is already
      -- opt-in via mount_access, so "no grant" already means "no access".
      CREATE TABLE IF NOT EXISTS mount_denials (
        mount_id INTEGER NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        denied_at INTEGER NOT NULL,
        PRIMARY KEY (mount_id, user_id)
      );
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
      'ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER',
      // Every user created before roles existed keeps working as a plain
      // 'user' — an operator upgrading in place must explicitly promote
      // themselves back to 'admin' via the CLI (see cli.ts's set-role).
      "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
      // A per-user override of which mount they land on. NULL (the default
      // for every existing user) means "use the global default mount",
      // preserving current behavior.
      'ALTER TABLE users ADD COLUMN default_mount_id INTEGER REFERENCES mounts(id)'
    ]) {
      try { this.db.exec(stmt) } catch { /* column already exists */ }
    }
  }

  close (): void {
    this.db.close()
  }

  // --- users ---------------------------------------------------------------

  /** `role` defaults to 'user' — only setupFirstUser grants 'admin', and only
   *  an existing admin can promote anyone else (see app.ts's /api/admin/users). */
  createUser (username: string, password: string, role: Role = 'user'): User {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) {
      throw new Error('username must be 1-64 chars of letters, digits, . _ -')
    }
    if (password.length < 12) {
      throw new Error('password must be at least 12 characters')
    }
    const now = Date.now()
    const res = this.db.prepare(
      'INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)'
    ).run(username, hashPassword(password), role, now)
    return { id: Number(res.lastInsertRowid), username, role, created_at: now }
  }

  /**
   * Create the very first user (first-run web setup) as an admin — it's the
   * only account that exists yet, so it has to be the one that can manage
   * mounts and other users afterward. Atomic against other requests in this
   * process: node:sqlite is synchronous and there is no `await` between the
   * count check and the insert, so nothing else in this single-process
   * server can interleave. Throws if a user already exists.
   */
  setupFirstUser (username: string, password: string): User {
    if (this.userCount() > 0) {
      throw new Error('setup already completed')
    }
    return this.createUser(username, password, 'admin')
  }

  deleteUser (username: string): boolean {
    const user = this.getUserByUsername(username)
    if (!user) return false
    this.db.prepare('DELETE FROM mount_access WHERE user_id = ?').run(user.id)
    this.db.prepare('DELETE FROM mount_denials WHERE user_id = ?').run(user.id)
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(user.id).changes > 0
  }

  listUsers (): User[] {
    return this.db.prepare(
      'SELECT id, username, role, created_at, default_mount_id FROM users ORDER BY username'
    ).all() as unknown as User[]
  }

  getUserByUsername (username: string): User | null {
    const row = this.db.prepare(
      'SELECT id, username, role, created_at, default_mount_id FROM users WHERE username = ?'
    ).get(username) as (User | undefined)
    return row ?? null
  }

  getUserById (id: number): User | null {
    const row = this.db.prepare(
      'SELECT id, username, role, created_at, default_mount_id FROM users WHERE id = ?'
    ).get(id) as (User | undefined)
    return row ?? null
  }

  /** Sets (or, with `mountId` null, clears) a user's personal default mount.
   *  Returns false if the user doesn't exist. */
  setUserDefaultMount (userId: number, mountId: number | null): boolean {
    return this.db.prepare('UPDATE users SET default_mount_id = ? WHERE id = ?').run(mountId, userId).changes > 0
  }

  /** How many admins currently exist — used to refuse demoting the last one. */
  countAdmins (): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }
    return row.n
  }

  /** Returns false if the user doesn't exist. */
  setUserRole (userId: number, role: Role): boolean {
    return this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId).changes > 0
  }

  userCount (): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return row.n
  }

  verifyCredentials (username: string, password: string): User | null {
    const row = this.db.prepare(
      'SELECT id, username, role, pass_hash, created_at FROM users WHERE username = ?'
    ).get(username) as ({ id: number, username: string, role: Role, pass_hash: string, created_at: number } | undefined)
    if (!row || !verifyPassword(password, row.pass_hash)) return null
    // Transparently upgrade a hash stored with weaker (older) scrypt params
    // now that we've verified the plaintext once.
    if (needsRehash(row.pass_hash)) {
      this.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), row.id)
    }
    return { id: row.id, username: row.username, role: row.role, created_at: row.created_at }
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
      SELECT u.id, u.username, u.role, u.created_at, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?
    `).get(sha256(sessionId)) as ({ id: number, username: string, role: Role, created_at: number, expires_at: number } | undefined)
    if (!row) return null
    if (row.expires_at < Date.now()) {
      this.deleteSession(sessionId)
      return null
    }
    return { id: row.id, username: row.username, role: row.role, created_at: row.created_at }
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
      SELECT u.id, u.username, u.role, u.created_at, r.expires_at FROM refresh_tokens r
      JOIN users u ON u.id = r.user_id WHERE r.id_hash = ?
    `).get(sha256(refreshId)) as ({ id: number, username: string, role: Role, created_at: number, expires_at: number } | undefined)
    if (!row) return null
    this.db.prepare('DELETE FROM refresh_tokens WHERE id_hash = ?').run(sha256(refreshId))
    if (row.expires_at < Date.now()) return null
    return { id: row.id, username: row.username, role: row.role, created_at: row.created_at }
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
      SELECT u.id, u.username, u.role, u.created_at, t.id AS token_id, t.expires_at FROM api_tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?
    `).get(sha256(token)) as ({ id: number, username: string, role: Role, created_at: number, token_id: number, expires_at: number | null } | undefined)
    if (!row) return null
    // NULL expiry = never expires (grandfathered / explicitly non-expiring).
    if (row.expires_at !== null && row.expires_at < Date.now()) return null
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run(Date.now(), row.token_id)
    return { id: row.id, username: row.username, role: row.role, created_at: row.created_at }
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
   * Stable random master secret the transfer-encryption layer (cipher.ts)
   * derives per-file keys from, created on first use. Must be
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

  // --- mounts --------------------------------------------------------------
  // Multiple filesystem roots ("mounts") can be shared at once. Exactly one —
  // seeded from P2F_ROOT at startup, see ensureDefaultMount — is the
  // `is_default` mount: implicitly browsable by every authenticated user
  // (matching the tool's original single-root behavior) and undeletable.
  // Every other mount is opt-in: an admin grants specific users access via
  // mount_access; admins themselves can always reach every mount.

  private rowToMount (row: { id: number, name: string, path: string, is_default: number, created_at: number, created_by: number | null }): Mount {
    return { id: row.id, name: row.name, path: row.path, is_default: row.is_default === 1, created_at: row.created_at, created_by: row.created_by }
  }

  createMount (name: string, dirPath: string, createdBy: number | null, isDefault = false): Mount {
    if (!/^[a-zA-Z0-9._ -]{1,64}$/.test(name)) {
      throw new Error('mount name must be 1-64 chars of letters, digits, spaces, . _ -')
    }
    const now = Date.now()
    const res = this.db.prepare(
      'INSERT INTO mounts (name, path, is_default, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(name, dirPath, isDefault ? 1 : 0, now, createdBy)
    return { id: Number(res.lastInsertRowid), name, path: dirPath, is_default: isDefault, created_at: now, created_by: createdBy }
  }

  /**
   * Ensures the default mount exists and points at `dirPath` — called on
   * every startup with the current P2F_ROOT, so an operator changing that
   * env var updates the existing default mount in place rather than leaving
   * a stale one behind (this mirrors how the pre-multi-mount server always
   * trusted config.root fresh on each boot).
   */
  ensureDefaultMount (dirPath: string): Mount {
    const existing = this.getDefaultMount()
    if (!existing) return this.createMount('default', dirPath, null, true)
    if (existing.path !== dirPath) {
      this.db.prepare('UPDATE mounts SET path = ? WHERE id = ?').run(dirPath, existing.id)
      existing.path = dirPath
    }
    return existing
  }

  getDefaultMount (): Mount | null {
    const row = this.db.prepare('SELECT * FROM mounts WHERE is_default = 1').get() as
      ({ id: number, name: string, path: string, is_default: number, created_at: number, created_by: number | null } | undefined)
    return row ? this.rowToMount(row) : null
  }

  getMountById (id: number): Mount | null {
    const row = this.db.prepare('SELECT * FROM mounts WHERE id = ?').get(id) as
      ({ id: number, name: string, path: string, is_default: number, created_at: number, created_by: number | null } | undefined)
    return row ? this.rowToMount(row) : null
  }

  getMountByName (name: string): Mount | null {
    const row = this.db.prepare('SELECT * FROM mounts WHERE name = ?').get(name) as
      ({ id: number, name: string, path: string, is_default: number, created_at: number, created_by: number | null } | undefined)
    return row ? this.rowToMount(row) : null
  }

  listMounts (): Mount[] {
    const rows = this.db.prepare('SELECT * FROM mounts ORDER BY is_default DESC, name').all() as
      Array<{ id: number, name: string, path: string, is_default: number, created_at: number, created_by: number | null }>
    return rows.map(r => this.rowToMount(r))
  }

  /** Mounts a given user may browse: every mount for an admin, otherwise the
   *  default mount (unless this user was explicitly denied it) plus any
   *  explicitly granted. */
  listMountsForUser (userId: number, isAdmin: boolean): Mount[] {
    if (isAdmin) return this.listMounts()
    const rows = this.db.prepare(`
      SELECT m.* FROM mounts m
      WHERE (m.is_default = 1 AND NOT EXISTS (SELECT 1 FROM mount_denials d WHERE d.mount_id = m.id AND d.user_id = ?))
         OR EXISTS (SELECT 1 FROM mount_access a WHERE a.mount_id = m.id AND a.user_id = ?)
      ORDER BY m.is_default DESC, m.name
    `).all(userId, userId) as Array<{ id: number, name: string, path: string, is_default: number, created_at: number, created_by: number | null }>
    return rows.map(r => this.rowToMount(r))
  }

  hasMountAccess (mount: Mount, userId: number, isAdmin: boolean): boolean {
    if (isAdmin) return true
    if (mount.is_default) {
      return this.db.prepare('SELECT 1 FROM mount_denials WHERE mount_id = ? AND user_id = ?')
        .get(mount.id, userId) === undefined
    }
    return this.db.prepare('SELECT 1 FROM mount_access WHERE mount_id = ? AND user_id = ?')
      .get(mount.id, userId) !== undefined
  }

  /** Deletes a mount and its access grants/denials. Refuses to delete the default mount. */
  deleteMount (id: number): boolean {
    const mount = this.getMountById(id)
    if (!mount || mount.is_default) return false
    this.db.prepare('DELETE FROM mount_access WHERE mount_id = ?').run(id)
    this.db.prepare('DELETE FROM mount_denials WHERE mount_id = ?').run(id)
    this.db.prepare('UPDATE users SET default_mount_id = NULL WHERE default_mount_id = ?').run(id)
    return this.db.prepare('DELETE FROM mounts WHERE id = ?').run(id).changes > 0
  }

  grantMountAccess (mountId: number, userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO mount_access (mount_id, user_id, granted_at) VALUES (?, ?, ?)')
      .run(mountId, userId, Date.now())
  }

  revokeMountAccess (mountId: number, userId: number): void {
    this.db.prepare('DELETE FROM mount_access WHERE mount_id = ? AND user_id = ?').run(mountId, userId)
  }

  listMountAccess (mountId: number): MountAccessEntry[] {
    return this.db.prepare(`
      SELECT a.user_id, u.username, a.granted_at FROM mount_access a
      JOIN users u ON u.id = a.user_id WHERE a.mount_id = ? ORDER BY u.username
    `).all(mountId) as unknown as MountAccessEntry[]
  }

  /** Excludes a user from the default mount's implicit, everyone-has-it access. No-op for other mounts (see mount_denials). */
  denyMountAccess (mountId: number, userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO mount_denials (mount_id, user_id, denied_at) VALUES (?, ?, ?)')
      .run(mountId, userId, Date.now())
  }

  /** Undoes a denyMountAccess. */
  allowMountAccess (mountId: number, userId: number): void {
    this.db.prepare('DELETE FROM mount_denials WHERE mount_id = ? AND user_id = ?').run(mountId, userId)
  }

  listMountDenials (mountId: number): MountDenialEntry[] {
    return this.db.prepare(`
      SELECT d.user_id, u.username, d.denied_at FROM mount_denials d
      JOIN users u ON u.id = d.user_id WHERE d.mount_id = ? ORDER BY u.username
    `).all(mountId) as unknown as MountDenialEntry[]
  }
}

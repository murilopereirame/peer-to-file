import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface CipherEntry {
  key: Buffer
  iv: Buffer
  cachePath: string
  /** SHA-256 of the original plaintext (hex) — lets a client verify a
   * finished download decrypted and saved correctly, independent of
   * BitTorrent's own per-piece hashing (which only covers the ciphertext
   * reaching the client intact, not what happens to it after). */
  plainSha256: string
}

export interface ReapResult {
  /** Number of cache entry directories deleted. */
  removed: number
  /** Total bytes reclaimed from disk. */
  bytesFreed: number
}

export interface CipherCache {
  getEntry (absPath: string): Promise<CipherEntry>
  /**
   * Delete every cache entry that is neither pinned (actively seeded) nor
   * touched within the last `idleMs` — i.e. files no longer being transferred.
   * An evicted file is simply re-encrypted, deterministically, on its next
   * request, so this is safe to run on a timer (see cacheCleanup.ts). Returns
   * how much was reclaimed.
   */
  reapIdle (idleMs: number): Promise<ReapResult>
}

export interface CipherCacheOptions {
  /** Soft cap on total cache size in bytes; 0 disables eviction. */
  maxBytes?: number
  /** Returns true if a cache file must not be evicted (e.g. actively seeded). */
  isPinned?: (cachePath: string) => boolean
}

/**
 * On-demand ciphertext cache: application-layer encryption for file transfers,
 * independent of whatever TLS/VPN the deployment does or doesn't have. Each
 * shared file's AES-256-CTR key+IV is derived deterministically from a
 * per-server master secret (AuthDb.cipherMasterSecret()) and the file's
 * identity (path + size + mtime) — NOT randomly generated per process. That
 * determinism matters: torrent metadata (torrents.ts) is hashed from the
 * ciphertext this module produces, and the whole "resume after a server
 * restart" flow relies on the infohash for unchanged file content staying
 * identical across restarts (see torrents.ts's own doc comment) — a
 * randomly-keyed cache would re-encrypt to different bytes, and a different
 * infohash, every time the process restarted.
 *
 * The plaintext is streamed through the cipher into a cache file once per
 * file identity; torrent hashing, WebRTC seeding (seeder.ts) and the webseed
 * (/api/raw) all then read that ciphertext file instead of the original, so
 * the wire never carries plaintext regardless of transport. CTR is
 * length-preserving (no auth tag), so the cache file is byte-identical in
 * size to the source — existing length/Range logic downstream needs no
 * changes.
 *
 * The cache path itself is keyed by path+size+mtime, so an unchanged file's
 * ciphertext survives a restart on disk exactly where this will look for it
 * — no need to re-encrypt (or even to keep an in-memory cache at all across
 * restarts; the in-memory map here is purely a dedup for concurrent requests
 * within one process). Deliberately stored outside P2F_ROOT so it stays
 * writable even when the shared root is mounted read-only.
 */
export function createCipherCache (
  cacheDir: string, masterSecret: Buffer, options: CipherCacheOptions = {}
): CipherCache {
  const cache = new Map<string, Promise<CipherEntry>>()
  const maxBytes = options.maxBytes ?? 0
  const isPinned = options.isPinned ?? (() => false)
  // idHash -> last access time, an in-memory LRU hint for eviction ordering.
  const lastAccess = new Map<string, number>()
  // idHash -> identity, so eviction can drop the matching in-memory promise
  // (whose cachePath points at the dir being deleted) synchronously.
  const idHashToIdentity = new Map<string, string>()

  async function getEntry (absPath: string): Promise<CipherEntry> {
    const st = await fs.stat(absPath)
    const identity = `${absPath}:${st.size}:${st.mtimeMs}`
    const idHash = crypto.createHash('sha256').update(identity).digest('hex')
    lastAccess.set(idHash, Date.now())
    idHashToIdentity.set(idHash, identity)
    let promise = cache.get(identity)
    if (!promise) {
      promise = buildEntry(absPath, identity).then(async entry => {
        if (maxBytes > 0) await evictIfNeeded().catch(() => {})
        return entry
      })
      promise.catch(() => {
        if (cache.get(identity) === promise) cache.delete(identity)
      })
      cache.set(identity, promise)
    }
    return promise
  }

  interface DiskEntry {
    idHash: string
    dir: string
    size: number
    cacheFile: string | null
    /** Best available "last used" timestamp: the in-memory LRU hint if we have
     * one, else the newest file mtime so an entry that survived a restart (no
     * in-memory hint) is aged from when its ciphertext was written, not treated
     * as infinitely old. */
    atime: number
  }

  /** Enumerate on-disk cache entries with their size and best-known age. */
  async function scanEntries (): Promise<{ entries: DiskEntry[], total: number }> {
    let dirs: string[]
    try {
      dirs = await fs.readdir(cacheDir)
    } catch {
      return { entries: [], total: 0 }
    }
    const entries: DiskEntry[] = []
    let total = 0
    for (const idHash of dirs) {
      const dir = path.join(cacheDir, idHash)
      let files: string[]
      try {
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      let size = 0
      let cacheFile: string | null = null
      let newestMtime = 0
      for (const f of files) {
        try {
          const st = await fs.stat(path.join(dir, f))
          size += st.size
          if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs
          if (!f.endsWith('.sha256')) cacheFile = path.join(dir, f)
        } catch { /* vanished mid-scan */ }
      }
      total += size
      entries.push({ idHash, dir, size, cacheFile, atime: lastAccess.get(idHash) ?? newestMtime })
    }
    return { entries, total }
  }

  /** Delete one entry directory and drop the in-memory bookkeeping pointing at
   * it, so the next request rebuilds it instead of returning a stale path. */
  async function removeEntry (e: DiskEntry): Promise<void> {
    await fs.rm(e.dir, { recursive: true, force: true })
    lastAccess.delete(e.idHash)
    const identity = idHashToIdentity.get(e.idHash)
    if (identity) { cache.delete(identity); idHashToIdentity.delete(e.idHash) }
  }

  /**
   * Best-effort LRU eviction: when the on-disk cache exceeds maxBytes, delete
   * the least-recently-used entry directories until back under the cap, never
   * touching one that's currently pinned (actively seeded). An evicted file is
   * simply re-encrypted on its next request, so this is safe to get wrong.
   */
  async function evictIfNeeded (): Promise<void> {
    const { entries, total } = await scanEntries()
    if (total <= maxBytes) return
    let remaining = total
    // Oldest first.
    entries.sort((a, b) => a.atime - b.atime)
    for (const e of entries) {
      if (remaining <= maxBytes) break
      if (e.cacheFile && isPinned(e.cacheFile)) continue
      try {
        await removeEntry(e)
        remaining -= e.size
      } catch { /* eviction is best-effort */ }
    }
  }

  async function reapIdle (idleMs: number): Promise<ReapResult> {
    const { entries } = await scanEntries()
    const now = Date.now()
    let removed = 0
    let bytesFreed = 0
    for (const e of entries) {
      // Keep anything still in use: currently seeded, or touched recently.
      if (now - e.atime < idleMs) continue
      if (e.cacheFile && isPinned(e.cacheFile)) continue
      try {
        await removeEntry(e)
        removed++
        bytesFreed += e.size
      } catch { /* best-effort */ }
    }
    return { removed, bytesFreed }
  }

  async function buildEntry (absPath: string, identity: string): Promise<CipherEntry> {
    const idHash = crypto.createHash('sha256').update(identity).digest('hex')
    const dir = path.join(cacheDir, idHash)
    const cachePath = path.join(dir, path.basename(absPath))
    const hashPath = `${cachePath}.sha256`

    // HKDF over the master secret, salted with this exact file identity —
    // deterministic, so the same file (same path/size/mtime) always derives
    // the same key/IV, on this or any future run of the server.
    const derived = Buffer.from(crypto.hkdfSync(
      'sha256', masterSecret, identity, 'p2f-transfer-cipher', 48
    ))
    const key = derived.subarray(0, 32)
    const iv = derived.subarray(32, 48)

    // Content-addressed by identity: if it's already on disk (e.g. from
    // before a restart), it's already correct — no need to re-encrypt.
    if (await fileExists(cachePath)) {
      const plainSha256 = await readOrRebuildHash(hashPath, absPath)
      return { key, iv, cachePath, plainSha256 }
    }

    await fs.mkdir(dir, { recursive: true })
    const tmpPath = `${cachePath}.tmp-${crypto.randomUUID()}`
    try {
      const plainHash = crypto.createHash('sha256')
      await pipeline(
        fsSync.createReadStream(absPath),
        hashingPassthrough(plainHash),
        crypto.createCipheriv('aes-256-ctr', key, iv),
        fsSync.createWriteStream(tmpPath)
      )
      await fs.rename(tmpPath, cachePath)
      const plainSha256 = plainHash.digest('hex')
      await fs.writeFile(hashPath, plainSha256, 'utf8')
      return { key, iv, cachePath, plainSha256 }
    } catch (err) {
      await fs.rm(tmpPath, { force: true })
      throw err
    }
  }

  return { getEntry, reapIdle }
}

/** Transform that passes chunks through unchanged while feeding them into `hash` — lets the plaintext be hashed and encrypted in the same read pass instead of two. */
function hashingPassthrough (hash: crypto.Hash): Transform {
  return new Transform({
    transform (chunk, _enc, cb) {
      hash.update(chunk as Buffer)
      cb(null, chunk)
    }
  })
}

/** Cache hits normally just read the sidecar; pre-existing ciphertext cache
 * entries from before checksums were tracked have none, so hash the
 * (still-present) plaintext once here and persist it for next time. */
async function readOrRebuildHash (hashPath: string, absPath: string): Promise<string> {
  try {
    return (await fs.readFile(hashPath, 'utf8')).trim()
  } catch {
    const hash = crypto.createHash('sha256')
    await pipeline(fsSync.createReadStream(absPath), hash)
    const plainSha256 = hash.digest('hex')
    await fs.writeFile(hashPath, plainSha256, 'utf8')
    return plainSha256
  }
}

async function fileExists (p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

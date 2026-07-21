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

export interface CipherCache {
  getEntry (absPath: string): Promise<CipherEntry>
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

  /**
   * Best-effort LRU eviction: when the on-disk cache exceeds maxBytes, delete
   * the least-recently-used entry directories until back under the cap, never
   * touching one that's currently pinned (actively seeded). An evicted file is
   * simply re-encrypted on its next request, so this is safe to get wrong.
   */
  async function evictIfNeeded (): Promise<void> {
    let dirs: string[]
    try {
      dirs = await fs.readdir(cacheDir)
    } catch {
      return
    }
    const entries: Array<{ idHash: string, dir: string, size: number, cacheFile: string | null, atime: number }> = []
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
      for (const f of files) {
        try {
          const st = await fs.stat(path.join(dir, f))
          size += st.size
          if (!f.endsWith('.sha256')) cacheFile = path.join(dir, f)
        } catch { /* vanished mid-scan */ }
      }
      total += size
      entries.push({ idHash, dir, size, cacheFile, atime: lastAccess.get(idHash) ?? 0 })
    }
    if (total <= maxBytes) return
    // Oldest first.
    entries.sort((a, b) => a.atime - b.atime)
    for (const e of entries) {
      if (total <= maxBytes) break
      if (e.cacheFile && isPinned(e.cacheFile)) continue
      try {
        await fs.rm(e.dir, { recursive: true, force: true })
        total -= e.size
        lastAccess.delete(e.idHash)
        // Drop the in-memory promise pointing at this evicted dir, so the next
        // request rebuilds it instead of returning a path that no longer exists.
        const identity = idHashToIdentity.get(e.idHash)
        if (identity) { cache.delete(identity); idHashToIdentity.delete(e.idHash) }
      } catch { /* eviction is best-effort */ }
    }
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

  return { getEntry }
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

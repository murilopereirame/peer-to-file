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
export function createCipherCache (cacheDir: string, masterSecret: Buffer): CipherCache {
  const cache = new Map<string, Promise<CipherEntry>>()

  async function getEntry (absPath: string): Promise<CipherEntry> {
    const st = await fs.stat(absPath)
    const identity = `${absPath}:${st.size}:${st.mtimeMs}`
    let promise = cache.get(identity)
    if (!promise) {
      promise = buildEntry(absPath, identity)
      promise.catch(() => {
        if (cache.get(identity) === promise) cache.delete(identity)
      })
      cache.set(identity, promise)
    }
    return promise
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

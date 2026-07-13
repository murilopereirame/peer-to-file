import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export interface CipherEntry {
  key: Buffer
  iv: Buffer
  cachePath: string
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
    if (await fileExists(cachePath)) return { key, iv, cachePath }

    await fs.mkdir(dir, { recursive: true })
    const tmpPath = `${cachePath}.tmp-${crypto.randomUUID()}`
    try {
      await pipeline(
        fsSync.createReadStream(absPath),
        crypto.createCipheriv('aes-256-ctr', key, iv),
        fsSync.createWriteStream(tmpPath)
      )
      await fs.rename(tmpPath, cachePath)
    } catch (err) {
      await fs.rm(tmpPath, { force: true })
      throw err
    }
    return { key, iv, cachePath }
  }

  return { getEntry }
}

async function fileExists (p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

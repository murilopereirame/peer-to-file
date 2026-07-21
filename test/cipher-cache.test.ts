import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCipherCache } from '../src/server/cipherCache.ts'

let root: string
let cacheDir: string
const secret = crypto.randomBytes(32)

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-cache-src-')))
})
after(async () => { await fs.rm(root, { recursive: true, force: true }) })

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-cache-'))
})

async function cacheEntryCount (): Promise<number> {
  const dirs = await fs.readdir(cacheDir).catch(() => [])
  return dirs.length
}

async function makeFile (name: string, bytes: number): Promise<string> {
  const p = path.join(root, name)
  await fs.writeFile(p, crypto.randomBytes(bytes))
  return p
}

test('LRU eviction keeps the cache under the byte cap (F2)', async () => {
  // cap fits ~2 of the 4 KiB entries; adding more evicts the oldest.
  const cache = createCipherCache(cacheDir, secret, { maxBytes: 9 * 1024 })
  const a = await makeFile('a.bin', 4096)
  const b = await makeFile('b.bin', 4096)
  const c = await makeFile('c.bin', 4096)

  await cache.getEntry(a)
  await cache.getEntry(b)
  // touch `a` so `b` becomes the least-recently-used before we push over cap
  await cache.getEntry(a)
  await cache.getEntry(c)

  // eviction is best-effort/async relative to the write; give it a tick
  await new Promise(r => setTimeout(r, 50))
  assert.ok(await cacheEntryCount() <= 2, 'cache should have been trimmed to the cap')
})

test('a pinned (actively-seeded) entry is never evicted (F2)', async () => {
  const a = await makeFile('pinned.bin', 4096)
  const cache = createCipherCache(cacheDir, secret, {
    maxBytes: 4 * 1024,
    isPinned: p => p.includes('pinned.bin')
  })
  const entry = await cache.getEntry(a)

  // add more files to blow past the cap repeatedly
  for (let i = 0; i < 4; i++) {
    await cache.getEntry(await makeFile(`filler-${i}.bin`, 4096))
    await new Promise(r => setTimeout(r, 20))
  }
  // the pinned ciphertext file must still be on disk
  await assert.doesNotReject(fs.access(entry.cachePath), 'pinned entry was evicted')
})

test('an entry re-encrypts correctly after eviction', async () => {
  // Cap fits ~2 of the 4 KiB entries.
  const cache = createCipherCache(cacheDir, secret, { maxBytes: 9 * 1024 })
  const a = await makeFile('x.bin', 4096)
  const first = await cache.getEntry(a)
  const key1 = Buffer.from(first.key)

  // push `a` out by filling past the cap with other files
  await cache.getEntry(await makeFile('y.bin', 4096))
  await cache.getEntry(await makeFile('z.bin', 4096))
  await new Promise(r => setTimeout(r, 50))

  // requesting `a` again derives the same (deterministic) key and rebuilds the
  // ciphertext; as the just-accessed entry it is never the eviction target.
  const again = await cache.getEntry(a)
  assert.deepEqual(Buffer.from(again.key), key1)
  await assert.doesNotReject(fs.access(again.cachePath))
})

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCipherCache } from '../src/server/cipherCache.ts'
import { startCacheCleanup } from '../src/server/cacheCleanup.ts'
import { createActivityLog } from '../src/server/activity.ts'
import { silentLogger } from '../src/server/log.ts'
import type { Seeder } from '../src/server/seeder.ts'

let root: string
let cacheDir: string
const secret = crypto.randomBytes(32)

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-cleanup-src-')))
})
after(async () => { await fs.rm(root, { recursive: true, force: true }) })

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-cleanup-'))
})

async function makeFile (name: string, bytes: number): Promise<string> {
  const p = path.join(root, name)
  await fs.writeFile(p, crypto.randomBytes(bytes))
  return p
}

async function cacheEntryCount (): Promise<number> {
  return (await fs.readdir(cacheDir).catch(() => [])).length
}

/** Seeder stub that pins a set of paths until reapIdle unpins them. */
function fakeSeeder (): Seeder & { pinned: Set<string> } {
  const pinned = new Set<string>()
  return {
    pinned,
    enabled: true,
    ensureSeeding () {},
    isSeeding: p => pinned.has(p),
    reapIdle () {
      // Everything the stub was pinning is idle: unpin it all.
      const reaped = [...pinned]
      pinned.clear()
      return reaped
    },
    async destroy () {}
  }
}

test('cleanup unpins idle seeded entries then reaps them in one pass', async () => {
  const seeder = fakeSeeder()
  const cache = createCipherCache(cacheDir, secret, { isPinned: p => seeder.isSeeding(p) })
  const activity = createActivityLog()

  const entry = await cache.getEntry(await makeFile('seeded.bin', 4096))
  seeder.pinned.add(entry.cachePath) // pretend it's actively seeded

  // idleMs 0: without unpinning it would stay (pinned); the cleanup must reap
  // the seeder first so the now-unpinned entry is deletable in the same run.
  await new Promise(r => setTimeout(r, 5))
  const cleanup = startCacheCleanup({ seeder, cipherCache: cache, activity, log: silentLogger, idleMs: 0, intervalMs: 60_000 })
  await cleanup.runOnce()
  cleanup.stop()

  assert.equal(seeder.pinned.size, 0, 'idle torrent should have been unpinned')
  assert.equal(await cacheEntryCount(), 0, 'unpinned idle entry should be reaped')
  const logged = activity.list().some(e => e.message.includes('cache cleanup'))
  assert.ok(logged, 'a cleanup summary should be logged when something was reaped')
})

test('cleanup leaves entries that are still pinned', async () => {
  // A seeder whose reapIdle keeps everything pinned (still has peers).
  const pinned = new Set<string>()
  const seeder: Seeder = {
    enabled: true,
    ensureSeeding () {},
    isSeeding: p => pinned.has(p),
    reapIdle: () => [], // nothing idle — still transferring
    async destroy () {}
  }
  const cache = createCipherCache(cacheDir, secret, { isPinned: p => pinned.has(p) })
  const activity = createActivityLog()

  const entry = await cache.getEntry(await makeFile('busy.bin', 4096))
  pinned.add(entry.cachePath)

  await new Promise(r => setTimeout(r, 5))
  const cleanup = startCacheCleanup({ seeder, cipherCache: cache, activity, log: silentLogger, idleMs: 0, intervalMs: 60_000 })
  await cleanup.runOnce()
  cleanup.stop()

  assert.equal(await cacheEntryCount(), 1, 'a still-seeded entry must survive cleanup')
  await assert.doesNotReject(fs.access(entry.cachePath))
})

test('cleanup runOnce never rejects even if a subsystem throws', async () => {
  const seeder: Seeder = {
    enabled: true,
    ensureSeeding () {},
    isSeeding: () => false,
    reapIdle () { throw new Error('boom') },
    async destroy () {}
  }
  const cache = createCipherCache(cacheDir, secret)
  const cleanup = startCacheCleanup({ seeder, cipherCache: cache, activity: createActivityLog(), log: silentLogger, idleMs: 0, intervalMs: 60_000 })
  await assert.doesNotReject(cleanup.runOnce())
  cleanup.stop()
})

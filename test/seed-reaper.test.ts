import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startSeedReaper } from '../src/server/seedReaper.ts'
import { createActivityLog } from '../src/server/activity.ts'
import { silentLogger } from '../src/server/log.ts'
import type { Seeder } from '../src/server/seeder.ts'

function fakeSeeder (reap: (idleMs: number) => number): Seeder {
  return {
    enabled: true,
    ensureSeeding () {},
    reapIdle: reap,
    async destroy () {}
  }
}

test('seed reaper runs the sweep and logs when torrents are dropped', () => {
  let calledWith = -1
  const seeder = fakeSeeder(idleMs => { calledWith = idleMs; return 3 })
  const activity = createActivityLog()
  const reaper = startSeedReaper({ seeder, activity, log: silentLogger, idleMs: 12345, intervalMs: 60_000 })
  reaper.runOnce()
  reaper.stop()

  assert.equal(calledWith, 12345, 'idle threshold is passed through')
  assert.ok(activity.list().some(e => e.message.includes('3 idle torrent')), 'logs a summary when something was reaped')
})

test('seed reaper stays quiet when nothing is idle', () => {
  const seeder = fakeSeeder(() => 0)
  const activity = createActivityLog()
  const reaper = startSeedReaper({ seeder, activity, log: silentLogger, idleMs: 1, intervalMs: 60_000 })
  reaper.runOnce()
  reaper.stop()
  assert.equal(activity.list().length, 0, 'no activity logged when nothing reaped')
})

test('seed reaper swallows sweep errors', () => {
  const seeder = fakeSeeder(() => { throw new Error('boom') })
  const reaper = startSeedReaper({ seeder, activity: createActivityLog(), log: silentLogger, idleMs: 1, intervalMs: 60_000 })
  assert.doesNotThrow(() => reaper.runOnce())
  reaper.stop()
})

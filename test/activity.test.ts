import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createActivityLog, createDebouncer } from '../src/server/activity.ts'

test('records entries with incrementing ids, newest first', () => {
  const log = createActivityLog()
  log.add('server', 'started')
  log.add('auth', 'alice signed in')
  log.add('torrent', 'metadata requested for foo.bin')

  const entries = log.list()
  assert.deepEqual(entries.map(e => e.message), [
    'metadata requested for foo.bin', 'alice signed in', 'started'
  ])
  assert.ok(entries[0]!.id > entries[1]!.id)
  assert.ok(entries.every(e => typeof e.ts === 'number' && e.ts > 0))
})

test('attaches optional metadata', () => {
  const log = createActivityLog()
  log.add('webseed', 'serving foo.bin to 10.0.0.2', { ip: '10.0.0.2', path: 'foo.bin' })
  assert.deepEqual(log.list()[0]!.meta, { ip: '10.0.0.2', path: 'foo.bin' })
})

test('caps at capacity, dropping the oldest entries', () => {
  const log = createActivityLog(3)
  for (let i = 0; i < 5; i++) log.add('server', `event ${i}`)
  const entries = log.list()
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.message), ['event 4', 'event 3', 'event 2'])
})

test('list respects limit', () => {
  const log = createActivityLog()
  for (let i = 0; i < 10; i++) log.add('server', `event ${i}`)
  assert.equal(log.list({ limit: 4 }).length, 4)
  assert.deepEqual(log.list({ limit: 4 }).map(e => e.message), ['event 9', 'event 8', 'event 7', 'event 6'])
})

test('list respects sinceId for incremental polling', () => {
  const log = createActivityLog()
  log.add('server', 'a')
  log.add('server', 'b')
  const afterA = log.list()[1]!.id // the 'a' entry, since list() is newest-first
  log.add('server', 'c')
  log.add('server', 'd')

  const incremental = log.list({ sinceId: afterA })
  assert.deepEqual(incremental.map(e => e.message), ['d', 'c', 'b'])
})

test('debouncer allows the first call per key, suppresses repeats within the window', async () => {
  const allow = createDebouncer(50)
  assert.equal(allow('k1'), true)
  assert.equal(allow('k1'), false)
  assert.equal(allow('k2'), true) // different key, independent
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(allow('k1'), true) // window elapsed
})

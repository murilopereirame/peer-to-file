import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { silentLogger } from '../src/server/log.ts'

let root: string
let dbDir: string
let running: RunningServer
let base: string
let aliceCookie: string
let bobCookie: string

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-history-')))
  await fs.writeFile(path.join(root, 'file.bin'), crypto.randomBytes(1024))
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-historydb-'))

  running = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
    trackerPort: 0,
    publicHost: null,
    publicUrl: null,
    authEnabled: true,
    dbPath: path.join(dbDir, 'p2f.db'),
    cacheDir: path.join(root, '.p2f-cache')
  }, silentLogger)
  base = `http://127.0.0.1:${running.config.port}`

  running.db.createUser('alice', 'correct horse battery')
  running.db.createUser('bob', 'correct horse battery')

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct horse battery' })
    })
    return res.headers.get('set-cookie')!.split(';')[0]!
  }
  aliceCookie = await login('alice')
  bobCookie = await login('bob')
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(dbDir, { recursive: true, force: true })
})

test('unauthenticated history requests are rejected', async () => {
  const list = await fetch(`${base}/api/downloads/history`)
  assert.equal(list.status, 401)
  const record = await fetch(`${base}/api/downloads/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'file.bin', name: 'file.bin', length: 1024 })
  })
  assert.equal(record.status, 401)
})

test('recording validates its body', async () => {
  const res = await fetch(`${base}/api/downloads/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
    body: JSON.stringify({ path: 'file.bin' })
  })
  assert.equal(res.status, 400)
})

test('download history is recorded and scoped per user', async () => {
  const record = async (cookie: string, name: string): Promise<void> => {
    const res = await fetch(`${base}/api/downloads/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ path: name, name, length: 1024 })
    })
    assert.equal(res.status, 201)
  }
  await record(aliceCookie, 'alice-file.bin')
  await record(bobCookie, 'bob-file.bin')

  const aliceList = await (await fetch(`${base}/api/downloads/history`, { headers: { Cookie: aliceCookie } })).json() as any
  assert.deepEqual(aliceList.entries.map((e: any) => e.name), ['alice-file.bin'])

  const bobList = await (await fetch(`${base}/api/downloads/history`, { headers: { Cookie: bobCookie } })).json() as any
  assert.deepEqual(bobList.entries.map((e: any) => e.name), ['bob-file.bin'])
})

test('clearing history only clears the requesting user\'s own entries', async () => {
  const clear = await fetch(`${base}/api/downloads/history/clear`, {
    method: 'POST',
    headers: { Cookie: aliceCookie }
  })
  assert.equal(clear.status, 200)

  const aliceList = await (await fetch(`${base}/api/downloads/history`, { headers: { Cookie: aliceCookie } })).json() as any
  assert.deepEqual(aliceList.entries, [])

  const bobList = await (await fetch(`${base}/api/downloads/history`, { headers: { Cookie: bobCookie } })).json() as any
  assert.deepEqual(bobList.entries.map((e: any) => e.name), ['bob-file.bin'])
})

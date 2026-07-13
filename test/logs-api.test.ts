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
let cookie: string

/** A throwaway ECDH (P-256) public key — /api/torrent requires one (see keyExchange.ts) but this test doesn't unwrap the response's key material. */
async function clientPublicKey (): Promise<string> {
  const keyPair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', keyPair.publicKey)).toString('base64')
}

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-logs-')))
  await fs.writeFile(path.join(root, 'file.bin'), crypto.randomBytes(32 * 1024))
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-logsdb-'))

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
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(dbDir, { recursive: true, force: true })
})

test('GET /api/logs requires authentication', async () => {
  const res = await fetch(`${base}/api/logs`)
  assert.equal(res.status, 401)
})

test('server activity accumulates in the log, newest first', async () => {
  // the server itself logged a 'server started' entry before this test ever ran
  const startCount = running.activity.list().length
  assert.ok(startCount >= 1)

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct horse battery' })
  })
  cookie = login.headers.get('set-cookie')!.split(';')[0]!

  const ck = await clientPublicKey()
  await fetch(`${base}/api/torrent?path=file.bin&ck=${encodeURIComponent(ck)}`, { headers: { Cookie: cookie } })

  const res = await fetch(`${base}/api/logs`, { headers: { Cookie: cookie } })
  assert.equal(res.status, 200)
  const body = await res.json() as { entries: Array<{ id: number, kind: string, message: string }> }

  assert.ok(body.entries.length > startCount)
  // newest first: the torrent request should be the very latest entry
  assert.equal(body.entries[0]!.kind, 'torrent')
  assert.match(body.entries[0]!.message, /file\.bin/)
  assert.ok(body.entries.some(e => e.kind === 'auth' && /alice.*signed in/.test(e.message)))
})

test('GET /api/logs respects limit and sinceId', async () => {
  for (let i = 0; i < 5; i++) {
    await fetch(`${base}/api/list?path=`, { headers: { Cookie: cookie } })
  }
  running.activity.add('server', 'marker-entry')

  const limited = await fetch(`${base}/api/logs?limit=2`, { headers: { Cookie: cookie } })
  const limitedBody = await limited.json() as { entries: Array<{ id: number, message: string }> }
  assert.equal(limitedBody.entries.length, 2)
  assert.equal(limitedBody.entries[0]!.message, 'marker-entry')

  const markerId = limitedBody.entries[0]!.id
  running.activity.add('server', 'after-marker')
  const since = await fetch(`${base}/api/logs?sinceId=${markerId}`, { headers: { Cookie: cookie } })
  const sinceBody = await since.json() as { entries: Array<{ message: string }> }
  assert.deepEqual(sinceBody.entries.map(e => e.message), ['after-marker'])
})

test('unauthenticated login failures are recorded without leaking the password', async () => {
  await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'totally-wrong' })
  })
  const res = await fetch(`${base}/api/logs?limit=1`, { headers: { Cookie: cookie } })
  const body = await res.json() as { entries: Array<{ message: string }> }
  assert.match(body.entries[0]!.message, /failed login for "alice"/)
  assert.doesNotMatch(body.entries[0]!.message, /totally-wrong/)
})

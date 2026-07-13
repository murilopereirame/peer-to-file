import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { silentLogger } from '../src/server/log.ts'

let root: string
let dbDir: string
let running: RunningServer
let base: string
let cookie: string
let apiToken: string

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-auth-')))
  await fs.writeFile(path.join(root, 'file.bin'), crypto.randomBytes(32 * 1024))
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-authdb-'))

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
  apiToken = running.db.createApiToken('alice', 'test')
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(dbDir, { recursive: true, force: true })
})

test('unauthenticated API requests are rejected', async () => {
  for (const endpoint of ['/api/list?path=', '/api/torrent?path=file.bin', '/api/me']) {
    const res = await fetch(`${base}${endpoint}`)
    assert.equal(res.status, 401, endpoint)
  }
  const raw = await fetch(`${base}/api/raw?path=file.bin`)
  assert.equal(raw.status, 401)

  const del = await fetch(`${base}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'file.bin' })
  })
  assert.equal(del.status, 401)

  const move = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'file.bin', to: 'renamed.bin' })
  })
  assert.equal(move.status, 401)

  const upload = await fetch(`${base}/api/upload?path=&name=nope.bin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('x'),
    duplex: 'half'
  } as RequestInit)
  assert.equal(upload.status, 401)

  // none of the rejected requests should have touched the filesystem
  assert.deepEqual(await fs.readdir(root), ['file.bin'])
})

test('/api/info stays public and reports auth state', async () => {
  const res = await fetch(`${base}/api/info`)
  assert.equal(res.status, 200)
  const body = await res.json() as any
  assert.deepEqual(body.auth, { required: true, needsSetup: false, authenticated: false })
})

test('login with wrong credentials fails', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'wrong password' })
  })
  assert.equal(res.status, 401)
})

test('login sets a session cookie that unlocks the API', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct horse battery' })
  })
  assert.equal(res.status, 200)
  const setCookie = res.headers.get('set-cookie')
  assert.ok(setCookie?.includes('p2f_session='))
  assert.ok(setCookie?.includes('HttpOnly'))
  cookie = setCookie!.split(';')[0]!

  const list = await fetch(`${base}/api/list?path=`, { headers: { Cookie: cookie } })
  assert.equal(list.status, 200)

  const me = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })
  assert.deepEqual(await me.json(), { username: 'alice' })
})

test('Bearer API tokens unlock the API', async () => {
  const res = await fetch(`${base}/api/list?path=`, {
    headers: { Authorization: `Bearer ${apiToken}` }
  })
  assert.equal(res.status, 200)
  const bad = await fetch(`${base}/api/list?path=`, {
    headers: { Authorization: 'Bearer p2f_not-a-real-token' }
  })
  assert.equal(bad.status, 401)
})

test('torrent metadata carries tokenized webseed + tracker URLs that work', async () => {
  const res = await fetch(`${base}/api/torrent?path=file.bin`, { headers: { Cookie: cookie } })
  assert.equal(res.status, 200)
  const body = await res.json() as any

  // webseed: path-bound token, usable with no cookie at all
  const webseedUrl = new URL(body.webseed)
  assert.ok(webseedUrl.searchParams.get('t'), 'webseed missing transfer token')
  const raw = await fetch(body.webseed)
  assert.equal(raw.status, 200)

  // the token must not open other paths
  const stolen = new URL(body.webseed)
  stolen.searchParams.set('path', 'other.bin')
  assert.equal((await fetch(stolen)).status, 401)

  // announce goes through the token-gated main-port /tracker
  const announce = body.announce[0] as string
  assert.ok(announce.startsWith(`ws://127.0.0.1:${running.config.port}/tracker?t=`))

  const ws = new WebSocket(announce)
  const reply = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tracker reply')), 5000)
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        action: 'announce',
        info_hash: Buffer.from(body.infoHash, 'hex').toString('binary'),
        peer_id: Buffer.from('-P2FTEST0000000000AB', 'ascii').toString('binary'),
        uploaded: 0, downloaded: 0, left: 1, event: 'started', numwant: 0
      }))
    })
    ws.on('message', data => { clearTimeout(timer); resolve(JSON.parse(data.toString())) })
  })
  ws.close()
  assert.equal(reply.action, 'announce')
})

test('tracker upgrades without a valid token are rejected', async () => {
  for (const url of ['/tracker', '/tracker?t=123.fake']) {
    const ws = new WebSocket(`ws://127.0.0.1:${running.config.port}${url}`)
    const outcome = await new Promise<string>(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 5000)
      ws.on('open', () => { clearTimeout(timer); resolve('open') })
      ws.on('error', () => { clearTimeout(timer); resolve('rejected') })
      ws.on('unexpected-response', () => { clearTimeout(timer); resolve('rejected') })
    })
    ws.terminate()
    assert.equal(outcome, 'rejected', url)
  }
})

test('the standalone tracker port is not opened when auth is on', () => {
  // trackerPort stayed 0: nothing listened on it
  assert.equal(running.config.trackerPort, 0)
  assert.equal(running.tracker.http, null)
})

test('logout invalidates the session', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct horse battery' })
  })
  const tempCookie = login.headers.get('set-cookie')!.split(';')[0]!

  const out = await fetch(`${base}/api/logout`, {
    method: 'POST',
    headers: { Cookie: tempCookie }
  })
  assert.equal(out.status, 200)

  const after = await fetch(`${base}/api/list?path=`, { headers: { Cookie: tempCookie } })
  assert.equal(after.status, 401)
})

test('web client and bundle stay public (login happens in the app)', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200)
  assert.equal((await fetch(`${base}/vendor/webtorrent.min.js`, { method: 'HEAD' })).status, 200)
})

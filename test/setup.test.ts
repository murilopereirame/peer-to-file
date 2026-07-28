import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { silentLogger } from '../src/server/log.ts'
import { testConfig } from './support.ts'

// First-run setup flow: the server starts with no users at all, and
// /api/setup is the only way to create the initial (admin) account.

let root: string
let dbDir: string
let running: RunningServer
let base: string
let token: string

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-setup-')))
})

beforeEach(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-setup-db-'))
  running = await startServer(testConfig({
    root,
    dbPath: path.join(dbDir, 'p2f.db')
  }), silentLogger)
  base = `http://127.0.0.1:${running.config.port}`
  token = running.setupToken!
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function teardown (): Promise<void> {
  await running.close()
  await fs.rm(dbDir, { recursive: true, force: true })
}

test('a fresh server reports that setup is needed', async () => {
  const res = await fetch(`${base}/api/info`)
  const body = await res.json() as any
  assert.deepEqual(body.auth, { required: true, needsSetup: true, authenticated: false })
  await teardown()
})

test('setup requires the one-time setup token (F1a)', async () => {
  const noToken = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' })
  })
  assert.equal(noToken.status, 403)

  const wrongToken = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery', setupToken: 'nope' })
  })
  assert.equal(wrongToken.status, 403)

  assert.equal(running.db.userCount(), 0)
  await teardown()
})

test('/api/setup creates the admin account and signs them in', async () => {
  const res = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery', setupToken: token })
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { username: 'admin' })
  const setCookie = res.headers.get('set-cookie')
  assert.ok(setCookie?.includes('p2f_session='))
  const cookie = setCookie!.split(';')[0]!

  // the session from setup works immediately, no separate login needed
  const list = await fetch(`${base}/api/list?path=`, { headers: { Cookie: cookie } })
  assert.equal(list.status, 200)

  // and needsSetup flips off
  const info = await fetch(`${base}/api/info`, { headers: { Cookie: cookie } })
  assert.deepEqual((await info.json() as any).auth, {
    required: true, needsSetup: false, authenticated: true
  })

  // the created account can also log in normally afterwards
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' })
  })
  assert.equal(login.status, 200)
  await teardown()
})

test('/api/setup is rejected once an account exists', async () => {
  await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery', setupToken: token })
  })
  const second = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'someone-else', password: 'another password' })
  })
  assert.equal(second.status, 409)
  assert.deepEqual(running.db.listUsers().map(u => u.username), ['admin'])
  await teardown()
})

test('/api/setup is rejected once a user exists via the CLI path (createUser)', async () => {
  running.db.createUser('precreated', 'correct horse battery')
  const res = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' })
  })
  assert.equal(res.status, 409)
  await teardown()
})

test('/api/setup validates input', async () => {
  const missing = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', setupToken: token })
  })
  assert.equal(missing.status, 400)

  const shortPassword = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'short', setupToken: token })
  })
  assert.equal(shortPassword.status, 400)

  assert.equal(running.db.userCount(), 0)
  await teardown()
})

test('two concurrent setup requests only create one account', async () => {
  const [a, b] = await Promise.all([
    fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'first', password: 'correct horse battery', setupToken: token })
    }),
    fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'second', password: 'correct horse battery', setupToken: token })
    })
  ])
  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, [200, 409])
  assert.equal(running.db.userCount(), 1)
  await teardown()
})

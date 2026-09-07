import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { silentLogger } from '../src/server/log.ts'
import { testConfig } from './support.ts'

let root: string
let extraDir: string
let running: RunningServer
let base: string
let adminToken: string
let userToken: string
let extraMountId: number

const authHeader = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })
const authJson = (token: string): Record<string, string> => ({ ...authHeader(token), 'Content-Type': 'application/json' })

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-mounts-root-')))
  await fs.writeFile(path.join(root, 'root-report.txt'), 'in the default mount')

  extraDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-mounts-extra-')))
  await fs.writeFile(path.join(extraDir, 'extra-report.txt'), 'in the extra mount')

  running = await startServer(testConfig({ root }), silentLogger)
  base = `http://127.0.0.1:${running.config.port}`

  // The very first user created becomes the admin (F1a's setupFirstUser
  // semantics) — mirror that here via the DB directly, same as setup would.
  running.db.setupFirstUser('admin', 'correct horse battery')
  running.db.createUser('member', 'correct horse battery')
  adminToken = running.db.createApiToken('admin', 'test')
  userToken = running.db.createApiToken('member', 'test')
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(extraDir, { recursive: true, force: true })
})

test('GET /api/mounts: admin sees every mount (with path), a plain user sees only the default', async () => {
  const asAdmin = await fetch(`${base}/api/mounts`, { headers: authHeader(adminToken) })
  assert.equal(asAdmin.status, 200)
  const adminBody = await asAdmin.json() as { mounts: Array<{ name: string, isDefault: boolean, path?: string }> }
  assert.deepEqual(adminBody.mounts.map(m => m.name), ['default'])
  assert.equal(adminBody.mounts[0]!.isDefault, true)
  assert.equal(typeof adminBody.mounts[0]!.path, 'string')

  const asUser = await fetch(`${base}/api/mounts`, { headers: authHeader(userToken) })
  const userBody = await asUser.json() as { mounts: Array<{ name: string, path?: string }> }
  assert.deepEqual(userBody.mounts.map(m => m.name), ['default'])
  assert.equal(userBody.mounts[0]!.path, undefined) // path is admin-only
})

test('POST /api/admin/mounts requires the admin role', async () => {
  const res = await fetch(`${base}/api/admin/mounts`, {
    method: 'POST',
    headers: authJson(userToken),
    body: JSON.stringify({ name: 'extra', path: extraDir })
  })
  assert.equal(res.status, 403)
})

test('an admin creates a mount; a plain user has no access to it until granted', async () => {
  const create = await fetch(`${base}/api/admin/mounts`, {
    method: 'POST',
    headers: authJson(adminToken),
    body: JSON.stringify({ name: 'extra', path: extraDir })
  })
  assert.equal(create.status, 201)
  const created = await create.json() as { id: number, name: string, path: string, isDefault: boolean }
  assert.equal(created.name, 'extra')
  assert.equal(created.path, extraDir)
  assert.equal(created.isDefault, false)
  extraMountId = created.id

  // Admin can browse it immediately (implicit access).
  const asAdmin = await fetch(`${base}/api/list?path=&mount=${extraMountId}`, { headers: authHeader(adminToken) })
  assert.equal(asAdmin.status, 200)
  const adminListing = await asAdmin.json() as { entries: Array<{ name: string }> }
  assert.deepEqual(adminListing.entries.map(e => e.name), ['extra-report.txt'])

  // A plain user is refused until explicitly granted access.
  const asUser = await fetch(`${base}/api/list?path=&mount=${extraMountId}`, { headers: authHeader(userToken) })
  assert.equal(asUser.status, 403)

  const grant = await fetch(`${base}/api/admin/mounts/${extraMountId}/access`, {
    method: 'POST',
    headers: authJson(adminToken),
    body: JSON.stringify({ username: 'member' })
  })
  assert.equal(grant.status, 201)

  const asUserAfterGrant = await fetch(`${base}/api/list?path=&mount=${extraMountId}`, { headers: authHeader(userToken) })
  assert.equal(asUserAfterGrant.status, 200)

  // Revoking access takes it away again.
  const memberId = ((await (await fetch(`${base}/api/admin/users`, { headers: authHeader(adminToken) })).json()) as
    { users: Array<{ id: number, username: string }> }).users.find(u => u.username === 'member')!.id
  const revoke = await fetch(`${base}/api/admin/mounts/${extraMountId}/access/${memberId}`, {
    method: 'DELETE', headers: authHeader(adminToken)
  })
  assert.equal(revoke.status, 200)
  const asUserAfterRevoke = await fetch(`${base}/api/list?path=&mount=${extraMountId}`, { headers: authHeader(userToken) })
  assert.equal(asUserAfterRevoke.status, 403)

  // Re-grant for the tests below that rely on member having access.
  await fetch(`${base}/api/admin/mounts/${extraMountId}/access`, {
    method: 'POST', headers: authJson(adminToken), body: JSON.stringify({ username: 'member' })
  })
})

test('an unknown mount is a 404, not a silent fallback to the default', async () => {
  const res = await fetch(`${base}/api/list?path=&mount=nope`, { headers: authHeader(adminToken) })
  assert.equal(res.status, 404)
})

test('the default mount cannot be deleted', async () => {
  const mountsRes = await fetch(`${base}/api/admin/mounts`, { headers: authHeader(adminToken) })
  const { mounts } = await mountsRes.json() as { mounts: Array<{ id: number, name: string }> }
  const def = mounts.find(m => m.name === 'default')!
  const del = await fetch(`${base}/api/admin/mounts/${def.id}`, { method: 'DELETE', headers: authHeader(adminToken) })
  assert.equal(del.status, 400)
})

test('GET /api/search finds a match in a specific mount', async () => {
  const res = await fetch(`${base}/api/search?q=report&mount=${extraMountId}`, { headers: authHeader(adminToken) })
  assert.equal(res.status, 200)
  const body = await res.json() as { results: Array<{ name: string, mount: { name: string } }> }
  assert.deepEqual(body.results.map(r => r.name), ['extra-report.txt'])
  assert.equal(body.results[0]!.mount.name, 'extra')
})

test('GET /api/search without a mount searches every mount the caller can reach', async () => {
  const res = await fetch(`${base}/api/search?q=report`, { headers: authHeader(adminToken) })
  assert.equal(res.status, 200)
  const body = await res.json() as { results: Array<{ name: string, mount: { name: string } }> }
  const names = body.results.map(r => `${r.mount.name}/${r.name}`).sort()
  assert.deepEqual(names, ['default/root-report.txt', 'extra/extra-report.txt'])
})

test('GET /api/search on a mount the caller cannot reach is a 403', async () => {
  // Revoke member's access to `extra` for this one check, then restore it.
  const memberId = ((await (await fetch(`${base}/api/admin/users`, { headers: authHeader(adminToken) })).json()) as
    { users: Array<{ id: number, username: string }> }).users.find(u => u.username === 'member')!.id
  await fetch(`${base}/api/admin/mounts/${extraMountId}/access/${memberId}`, { method: 'DELETE', headers: authHeader(adminToken) })

  const res = await fetch(`${base}/api/search?q=report&mount=${extraMountId}`, { headers: authHeader(userToken) })
  assert.equal(res.status, 403)

  const acrossAll = await fetch(`${base}/api/search?q=report`, { headers: authHeader(userToken) })
  const body = await acrossAll.json() as { results: Array<{ mount: { name: string } }> }
  assert.ok(!body.results.some(r => r.mount.name === 'extra'))

  await fetch(`${base}/api/admin/mounts/${extraMountId}/access`, {
    method: 'POST', headers: authJson(adminToken), body: JSON.stringify({ username: 'member' })
  })
})

test('GET /api/search requires a non-empty query', async () => {
  const res = await fetch(`${base}/api/search?q=`, { headers: authHeader(adminToken) })
  assert.equal(res.status, 400)
})

test('GET /api/admin/users lists roles, and role changes take effect immediately', async () => {
  const list = await fetch(`${base}/api/admin/users`, { headers: authHeader(adminToken) })
  const body = await list.json() as { users: Array<{ username: string, role: string }> }
  assert.deepEqual(body.users.map(u => [u.username, u.role]).sort(), [['admin', 'admin'], ['member', 'user']])

  const promote = await fetch(`${base}/api/admin/users/member/role`, {
    method: 'POST', headers: authJson(adminToken), body: JSON.stringify({ role: 'admin' })
  })
  assert.equal(promote.status, 200)

  // member is now an admin and can reach admin-only routes.
  const asPromoted = await fetch(`${base}/api/admin/users`, { headers: authHeader(userToken) })
  assert.equal(asPromoted.status, 200)

  // ...and can now list every mount (admin bypass), including a path.
  const mounts = await fetch(`${base}/api/mounts`, { headers: authHeader(userToken) })
  const mountsBody = await mounts.json() as { mounts: Array<{ path?: string }> }
  assert.equal(mounts.status, 200)
  assert.ok(mountsBody.mounts.every(m => typeof m.path === 'string'))

  // demote back to 'user' for later tests
  const demote = await fetch(`${base}/api/admin/users/member/role`, {
    method: 'POST', headers: authJson(adminToken), body: JSON.stringify({ role: 'user' })
  })
  assert.equal(demote.status, 200)
})

test('the last remaining admin cannot be demoted', async () => {
  const res = await fetch(`${base}/api/admin/users/admin/role`, {
    method: 'POST', headers: authJson(adminToken), body: JSON.stringify({ role: 'user' })
  })
  assert.equal(res.status, 400)
})

test('a raw token minted for one mount does not authorize the same path in another mount', async () => {
  // Both mounts have a file whose name collides in spirit (not literally,
  // just to prove the token is mount-scoped): mint a torrent for the file in
  // `extra`, then try to replay its raw token against the default mount.
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const ck = Buffer.from(await crypto.subtle.exportKey('raw', keyPair.publicKey)).toString('base64')
  const torrentRes = await fetch(
    `${base}/api/torrent?path=extra-report.txt&mount=${extraMountId}&ck=${encodeURIComponent(ck)}`,
    { headers: authHeader(adminToken) }
  )
  assert.equal(torrentRes.status, 200)
  const { webseed } = await torrentRes.json() as { webseed: string }
  const url = new URL(webseed)
  const token = url.searchParams.get('t')!

  // Replaying the same token+path against the default mount id must fail.
  const defaultMounts = await (await fetch(`${base}/api/mounts`, { headers: authHeader(adminToken) })).json() as
    { mounts: Array<{ id: number, name: string }> }
  const defaultId = defaultMounts.mounts.find(m => m.name === 'default')!.id
  const replay = await fetch(`${base}/api/raw?path=extra-report.txt&mount=${defaultId}&t=${encodeURIComponent(token)}`)
  assert.equal(replay.status, 401)

  // The original token against its own mount still works (no session/bearer needed).
  const original = await fetch(`${base}/api/raw?path=extra-report.txt&mount=${extraMountId}&t=${encodeURIComponent(token)}`)
  assert.equal(original.status, 200)
})

test('POST /api/move moves a file across mounts when the caller has access to both', async () => {
  const move = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: authJson(adminToken),
    body: JSON.stringify({ from: 'root-report.txt', to: 'moved-report.txt', toMount: extraMountId })
  })
  assert.equal(move.status, 200)
  const body = await move.json() as { path: string, mount: number }
  assert.equal(body.path, 'moved-report.txt')
  assert.equal(body.mount, extraMountId)

  // gone from the default mount, present in the extra mount
  const fromListing = await fetch(`${base}/api/list?path=`, { headers: authHeader(adminToken) })
  const fromBody = await fromListing.json() as { entries: Array<{ name: string }> }
  assert.ok(!fromBody.entries.some(e => e.name === 'root-report.txt'))

  const toListing = await fetch(`${base}/api/list?path=&mount=${extraMountId}`, { headers: authHeader(adminToken) })
  const toBody = await toListing.json() as { entries: Array<{ name: string }> }
  assert.ok(toBody.entries.some(e => e.name === 'moved-report.txt'))

  // move it back so later tests (and a rerun of this one) see the original layout
  const moveBack = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: authJson(adminToken),
    body: JSON.stringify({ from: 'moved-report.txt', mount: extraMountId, to: 'root-report.txt', toMount: 'default' })
  })
  assert.equal(moveBack.status, 200)
})

test('POST /api/move across mounts is refused without access to the destination mount', async () => {
  // A fresh mount `member` has no access to.
  const create = await fetch(`${base}/api/admin/mounts`, {
    method: 'POST',
    headers: authJson(adminToken),
    body: JSON.stringify({ name: 'locked', path: extraDir })
  })
  assert.equal(create.status, 201)
  const locked = await create.json() as { id: number }

  const move = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: authJson(userToken),
    body: JSON.stringify({ from: 'root-report.txt', to: 'wont-land.txt', toMount: locked.id })
  })
  assert.equal(move.status, 403)

  // nothing moved
  const listing = await fetch(`${base}/api/list?path=`, { headers: authHeader(userToken) })
  const body = await listing.json() as { entries: Array<{ name: string }> }
  assert.ok(body.entries.some(e => e.name === 'root-report.txt'))
})

test('POST /api/move without toMount stays a same-mount move (unchanged behavior)', async () => {
  const move = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: authJson(adminToken),
    body: JSON.stringify({ from: 'root-report.txt', to: 'root-report-renamed.txt' })
  })
  assert.equal(move.status, 200)
  const body = await move.json() as { mount: number }
  const defaultMounts = await (await fetch(`${base}/api/mounts`, { headers: authHeader(adminToken) })).json() as
    { mounts: Array<{ id: number, name: string }> }
  assert.equal(body.mount, defaultMounts.mounts.find(m => m.name === 'default')!.id)

  // rename back for good measure
  await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: authJson(adminToken),
    body: JSON.stringify({ from: 'root-report-renamed.txt', to: 'root-report.txt' })
  })
})

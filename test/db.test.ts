import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AuthDb } from '../src/server/db.ts'

let root: string

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-db-')))
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('creates missing parent directories for the database file', () => {
  // Regression: node:sqlite creates the DB *file* on first open but not its
  // parent directories, which broke a fresh, empty /config Docker volume
  // (P2F_DB=/config/p2f.db with nothing under /config yet).
  const dbPath = path.join(root, 'fresh-volume', 'nested', 'p2f.db')
  const db = new AuthDb(dbPath)
  db.createUser('alice', 'correct horse battery')
  assert.deepEqual(db.listUsers().map(u => u.username), ['alice'])
  db.close()
})

test('reopens an existing database file without complaint', () => {
  const dbPath = path.join(root, 'reopen', 'p2f.db')
  const first = new AuthDb(dbPath)
  first.createUser('bob', 'correct horse battery')
  first.close()

  const second = new AuthDb(dbPath)
  assert.deepEqual(second.listUsers().map(u => u.username), ['bob'])
  second.close()
})

test('roles: createUser defaults to "user", setupFirstUser grants "admin"', () => {
  const db = new AuthDb(':memory:')
  const admin = db.setupFirstUser('owner', 'correct horse battery')
  assert.equal(admin.role, 'admin')
  const plain = db.createUser('carol', 'correct horse battery')
  assert.equal(plain.role, 'user')
  assert.equal(db.countAdmins(), 1)

  assert.equal(db.setUserRole(plain.id, 'admin'), true)
  assert.equal(db.getUserById(plain.id)?.role, 'admin')
  assert.equal(db.countAdmins(), 2)
  assert.equal(db.setUserRole(99999, 'admin'), false)
  db.close()
})

test('deleteUser also removes their mount access grants', () => {
  const db = new AuthDb(':memory:')
  const owner = db.setupFirstUser('owner', 'correct horse battery')
  const dave = db.createUser('dave', 'correct horse battery')
  const mount = db.createMount('extra', root, owner.id)
  db.grantMountAccess(mount.id, dave.id)
  assert.equal(db.listMountAccess(mount.id).length, 1)

  assert.equal(db.deleteUser('dave'), true)
  assert.equal(db.listMountAccess(mount.id).length, 0)
  assert.equal(db.deleteUser('dave'), false)
  db.close()
})

test('mounts: the default mount is implicitly accessible to everyone and cannot be deleted', () => {
  const db = new AuthDb(':memory:')
  const owner = db.setupFirstUser('owner', 'correct horse battery')
  const erin = db.createUser('erin', 'correct horse battery')
  const def = db.ensureDefaultMount(root)
  assert.equal(def.is_default, true)

  assert.equal(db.hasMountAccess(def, erin.id, false), true)
  assert.deepEqual(db.listMountsForUser(erin.id, false).map(m => m.name), ['default'])
  assert.equal(db.deleteMount(def.id), false)
  db.close()
})

test('ensureDefaultMount is idempotent and tracks a changed path across restarts', async () => {
  const db = new AuthDb(':memory:')
  const first = db.ensureDefaultMount(root)
  const otherDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-db-other-')))
  try {
    const second = db.ensureDefaultMount(otherDir)
    assert.equal(second.id, first.id) // same row, just repointed
    assert.equal(second.path, otherDir)
    assert.equal(db.listMounts().length, 1)
  } finally {
    await fs.rm(otherDir, { recursive: true, force: true })
    db.close()
  }
})

test('mounts: a non-default mount is opt-in per user, admins always get access', () => {
  const db = new AuthDb(':memory:')
  const owner = db.setupFirstUser('owner', 'correct horse battery')
  const frank = db.createUser('frank', 'correct horse battery')
  const mount = db.createMount('extra', root, owner.id)

  assert.equal(db.hasMountAccess(mount, frank.id, false), false)
  assert.equal(db.hasMountAccess(mount, frank.id, true), true) // admin bypass
  assert.deepEqual(db.listMountsForUser(frank.id, false), []) // no default mount seeded yet, no access granted
  db.ensureDefaultMount(root)
  assert.deepEqual(db.listMountsForUser(frank.id, false).map(m => m.name).sort(), ['default'])

  db.grantMountAccess(mount.id, frank.id)
  assert.equal(db.hasMountAccess(mount, frank.id, false), true)
  assert.deepEqual(db.listMountsForUser(frank.id, false).map(m => m.name).sort(), ['default', 'extra'])

  db.revokeMountAccess(mount.id, frank.id)
  assert.equal(db.hasMountAccess(mount, frank.id, false), false)
  db.close()
})

test('deleteMount cascades its access grants', () => {
  const db = new AuthDb(':memory:')
  const owner = db.setupFirstUser('owner', 'correct horse battery')
  const grace = db.createUser('grace', 'correct horse battery')
  const mount = db.createMount('extra', root, owner.id)
  db.grantMountAccess(mount.id, grace.id)

  assert.equal(db.deleteMount(mount.id), true)
  assert.equal(db.getMountById(mount.id), null)
  // no dangling access row left referencing the deleted mount
  assert.equal(db.listMountAccess(mount.id).length, 0)
  db.close()
})

test('mount and user names must be unique', () => {
  const db = new AuthDb(':memory:')
  const owner = db.setupFirstUser('owner', 'correct horse battery')
  db.createMount('extra', root, owner.id)
  assert.throws(() => db.createMount('extra', root, owner.id))
  db.close()
})

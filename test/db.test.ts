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

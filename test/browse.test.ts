import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowseError, listDir, resolveInsideRoot } from '../src/server/browse.ts'

let outside: string
let root: string

before(async () => {
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-outside-'))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-root-'))
  await fs.writeFile(path.join(root, 'a.txt'), 'hello')
  await fs.mkdir(path.join(root, 'sub'))
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'world!')
  await fs.symlink(path.join(root, 'a.txt'), path.join(root, 'link-inside'))
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-outside'))
  await fs.symlink(path.join(root, 'does-not-exist'), path.join(root, 'link-broken'))
  // mimic loadConfig, which realpaths the root
  root = await fs.realpath(root)
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

async function expectStatus (promise: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof BrowseError, `expected BrowseError, got ${err}`)
    assert.equal(err.status, status)
    return true
  })
}

test('resolves paths inside the root', async () => {
  assert.equal(await resolveInsideRoot(root, ''), root)
  assert.equal(await resolveInsideRoot(root, 'a.txt'), path.join(root, 'a.txt'))
  assert.equal(await resolveInsideRoot(root, 'sub/b.txt'), path.join(root, 'sub', 'b.txt'))
  // redundant separators and dots are fine as long as the result stays inside
  assert.equal(await resolveInsideRoot(root, './sub/../a.txt'), path.join(root, 'a.txt'))
})

test('rejects .. traversal', async () => {
  await expectStatus(resolveInsideRoot(root, '../'), 403)
  await expectStatus(resolveInsideRoot(root, '../../etc/passwd'), 403)
  await expectStatus(resolveInsideRoot(root, 'sub/../../etc/passwd'), 403)
})

test('treats absolute paths as root-relative instead of escaping', async () => {
  // "/etc/passwd" must not resolve to the real /etc/passwd
  await expectStatus(resolveInsideRoot(root, '/etc/passwd'), 404)
  await expectStatus(resolveInsideRoot(root, '//etc/passwd'), 404)
})

test('rejects null bytes and non-strings', async () => {
  await expectStatus(resolveInsideRoot(root, 'a.txt\0.jpg'), 400)
  await expectStatus(resolveInsideRoot(root, 42), 400)
  await expectStatus(resolveInsideRoot(root, ['a.txt']), 400)
})

test('rejects symlinks that escape the root', async () => {
  await expectStatus(resolveInsideRoot(root, 'link-outside'), 403)
})

test('follows symlinks that stay inside the root', async () => {
  assert.equal(await resolveInsideRoot(root, 'link-inside'), path.join(root, 'a.txt'))
})

test('404 for missing paths', async () => {
  await expectStatus(resolveInsideRoot(root, 'nope.bin'), 404)
  await expectStatus(resolveInsideRoot(root, 'a.txt/child'), 404)
})

test('lists a directory with dirs first', async () => {
  const listing = await listDir(root, '')
  assert.equal(listing.path, '')
  assert.deepEqual(
    listing.entries.map(e => [e.name, e.type]),
    [['sub', 'dir'], ['a.txt', 'file'], ['link-inside', 'file']]
  )
  const a = listing.entries.find(e => e.name === 'a.txt')
  assert.equal(a?.size, 5)
  assert.ok(typeof a?.mtime === 'number' && a.mtime > 0)
})

test('listing omits escaping and broken symlinks', async () => {
  const listing = await listDir(root, '')
  const names = listing.entries.map(e => e.name)
  assert.ok(!names.includes('link-outside'))
  assert.ok(!names.includes('link-broken'))
})

test('lists subdirectories', async () => {
  const listing = await listDir(root, 'sub')
  assert.equal(listing.path, 'sub')
  assert.deepEqual(listing.entries.map(e => e.name), ['b.txt'])
  assert.equal(listing.entries[0]?.size, 6)
})

test('listDir on a file is a 400', async () => {
  await expectStatus(listDir(root, 'a.txt'), 400)
})

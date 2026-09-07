import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BrowseError, createFolder, deleteEntry, isValidEntryName, listDir, moveEntry, resolveInsideRoot, resolveNewPathInsideRoot
} from '../src/server/browse.ts'

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

// --- mutation helpers: delete/move touch the filesystem, so each test below
// gets its own throwaway root instead of sharing the read-only fixture above.

async function makeMutableRoot (): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-mutate-'))
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
  await fs.mkdir(path.join(dir, 'sub'))
  await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'world!')
  return fs.realpath(dir)
}

test('isValidEntryName rejects separators, dots and null bytes', () => {
  assert.equal(isValidEntryName('report.pdf'), true)
  assert.equal(isValidEntryName(''), false)
  assert.equal(isValidEntryName('.'), false)
  assert.equal(isValidEntryName('..'), false)
  assert.equal(isValidEntryName('a/b'), false)
  assert.equal(isValidEntryName('a\\b'), false)
  assert.equal(isValidEntryName('a\0b'), false)
})

test('resolveNewPathInsideRoot resolves a not-yet-existing target in an existing folder', async () => {
  const mroot = await makeMutableRoot()
  try {
    assert.equal(await resolveNewPathInsideRoot(mroot, 'new.txt'), path.join(mroot, 'new.txt'))
    assert.equal(await resolveNewPathInsideRoot(mroot, 'sub/new.txt'), path.join(mroot, 'sub', 'new.txt'))
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('resolveNewPathInsideRoot rejects a missing parent, invalid names and traversal', async () => {
  const mroot = await makeMutableRoot()
  try {
    await expectStatus(resolveNewPathInsideRoot(mroot, 'nope/new.txt'), 404)
    await expectStatus(resolveNewPathInsideRoot(mroot, 'a.txt/new.txt'), 400) // parent is a file
    await expectStatus(resolveNewPathInsideRoot(mroot, '../escape.txt'), 403)
    await expectStatus(resolveNewPathInsideRoot(mroot, 'sub/..'), 400) // ".." is not a valid file name
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('deleteEntry removes a file and reports its relative path', async () => {
  const mroot = await makeMutableRoot()
  try {
    const result = await deleteEntry(mroot, 'a.txt')
    assert.equal(result.rel, 'a.txt')
    assert.equal(result.wasDir, false)
    await assert.rejects(fs.stat(path.join(mroot, 'a.txt')))
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('deleteEntry removes a directory recursively', async () => {
  const mroot = await makeMutableRoot()
  try {
    const result = await deleteEntry(mroot, 'sub')
    assert.equal(result.wasDir, true)
    await assert.rejects(fs.stat(path.join(mroot, 'sub')))
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('deleteEntry refuses to delete the shared root', async () => {
  const mroot = await makeMutableRoot()
  try {
    await expectStatus(deleteEntry(mroot, ''), 400)
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('deleteEntry removes a symlink itself, not the file it points to', async () => {
  const mroot = await makeMutableRoot()
  try {
    await fs.symlink(path.join(mroot, 'a.txt'), path.join(mroot, 'link.txt'))
    const result = await deleteEntry(mroot, 'link.txt')
    assert.equal(result.rel, 'link.txt')
    await assert.rejects(fs.lstat(path.join(mroot, 'link.txt')))
    // the symlink's target must survive untouched
    assert.equal(await fs.readFile(path.join(mroot, 'a.txt'), 'utf8'), 'hello')
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('deleteEntry unlinks a symlink to a directory without touching its contents', async () => {
  const mroot = await makeMutableRoot()
  try {
    await fs.symlink(path.join(mroot, 'sub'), path.join(mroot, 'sub-link'))
    await deleteEntry(mroot, 'sub-link')
    await assert.rejects(fs.lstat(path.join(mroot, 'sub-link')))
    assert.equal(await fs.readFile(path.join(mroot, 'sub', 'b.txt'), 'utf8'), 'world!')
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('moveEntry renames a file in place', async () => {
  const mroot = await makeMutableRoot()
  try {
    const result = await moveEntry(mroot, 'a.txt', mroot, 'renamed.txt')
    assert.equal(result.toRel, 'renamed.txt')
    await assert.rejects(fs.stat(path.join(mroot, 'a.txt')))
    assert.equal(await fs.readFile(path.join(mroot, 'renamed.txt'), 'utf8'), 'hello')
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('moveEntry moves a file into another folder', async () => {
  const mroot = await makeMutableRoot()
  try {
    const result = await moveEntry(mroot, 'a.txt', mroot, 'sub/a.txt')
    assert.equal(result.toRel, path.join('sub', 'a.txt'))
    assert.equal(await fs.readFile(path.join(mroot, 'sub', 'a.txt'), 'utf8'), 'hello')
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('moveEntry refuses to overwrite an existing entry', async () => {
  const mroot = await makeMutableRoot()
  try {
    await fs.writeFile(path.join(mroot, 'taken.txt'), 'already here')
    await expectStatus(moveEntry(mroot, 'a.txt', mroot, 'taken.txt'), 409)
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('moveEntry refuses to move a folder into its own subtree', async () => {
  const mroot = await makeMutableRoot()
  try {
    await expectStatus(moveEntry(mroot, 'sub', mroot, 'sub/nested'), 400)
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('moveEntry refuses to move the shared root and rejects traversal', async () => {
  const mroot = await makeMutableRoot()
  try {
    await expectStatus(moveEntry(mroot, '', mroot, 'elsewhere'), 400)
    await expectStatus(moveEntry(mroot, 'a.txt', mroot, '../escape.txt'), 403)
    await expectStatus(moveEntry(mroot, '../escape.txt', mroot, 'a.txt'), 403)
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('moveEntry renames a symlink itself, leaving its target where it was', async () => {
  const mroot = await makeMutableRoot()
  try {
    await fs.symlink(path.join(mroot, 'a.txt'), path.join(mroot, 'link.txt'))
    const result = await moveEntry(mroot, 'link.txt', mroot, 'renamed-link.txt')
    assert.equal(result.toRel, 'renamed-link.txt')
    await assert.rejects(fs.lstat(path.join(mroot, 'link.txt')))
    const st = await fs.lstat(path.join(mroot, 'renamed-link.txt'))
    assert.ok(st.isSymbolicLink())
    // the target file itself never moved
    assert.equal(await fs.readFile(path.join(mroot, 'a.txt'), 'utf8'), 'hello')
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('moveEntry moves a file across two different roots', async () => {
  const fromRoot = await makeMutableRoot()
  const toRoot = await makeMutableRoot()
  try {
    const result = await moveEntry(fromRoot, 'a.txt', toRoot, 'moved.txt')
    assert.equal(result.fromRel, 'a.txt')
    assert.equal(result.toRel, 'moved.txt')
    await assert.rejects(fs.stat(path.join(fromRoot, 'a.txt')))
    assert.equal(await fs.readFile(path.join(toRoot, 'moved.txt'), 'utf8'), 'hello')
  } finally {
    await fs.rm(fromRoot, { recursive: true, force: true })
    await fs.rm(toRoot, { recursive: true, force: true })
  }
})

test('moveEntry across two roots does not treat the destination root as inside the source', async () => {
  // The "cannot move a folder into itself" guard only applies within a
  // single root — moving `sub` from fromRoot into toRoot's root is a
  // perfectly normal cross-mount move, not a self-containment error.
  const fromRoot = await makeMutableRoot()
  const toRoot = await makeMutableRoot()
  try {
    const result = await moveEntry(fromRoot, 'sub', toRoot, 'sub-moved')
    assert.equal(result.toRel, 'sub-moved')
    assert.equal(await fs.readFile(path.join(toRoot, 'sub-moved', 'b.txt'), 'utf8'), 'world!')
  } finally {
    await fs.rm(fromRoot, { recursive: true, force: true })
    await fs.rm(toRoot, { recursive: true, force: true })
  }
})

test('moveEntry across two roots still refuses to overwrite an existing destination entry', async () => {
  const fromRoot = await makeMutableRoot()
  const toRoot = await makeMutableRoot()
  try {
    await fs.writeFile(path.join(toRoot, 'taken.txt'), 'already here')
    await expectStatus(moveEntry(fromRoot, 'a.txt', toRoot, 'taken.txt'), 409)
  } finally {
    await fs.rm(fromRoot, { recursive: true, force: true })
    await fs.rm(toRoot, { recursive: true, force: true })
  }
})

test('moveEntry falls back to copy+remove when rename reports EXDEV (a genuine cross-filesystem move)', async () => {
  const fromRoot = await makeMutableRoot()
  const toRoot = await makeMutableRoot()
  const rename = mock.method(fs, 'rename', async () => {
    const err = new Error('cross-device link') as NodeJS.ErrnoException
    err.code = 'EXDEV'
    throw err
  })
  try {
    const result = await moveEntry(fromRoot, 'sub', toRoot, 'sub-copied')
    assert.equal(result.toRel, 'sub-copied')
    // source is gone, destination has the full recursive contents
    await assert.rejects(fs.stat(path.join(fromRoot, 'sub')))
    assert.equal(await fs.readFile(path.join(toRoot, 'sub-copied', 'b.txt'), 'utf8'), 'world!')
  } finally {
    rename.mock.restore()
    await fs.rm(fromRoot, { recursive: true, force: true })
    await fs.rm(toRoot, { recursive: true, force: true })
  }
})

test('moveEntry cleans up a partial copy if the EXDEV fallback itself fails', async () => {
  const fromRoot = await makeMutableRoot()
  const toRoot = await makeMutableRoot()
  const rename = mock.method(fs, 'rename', async () => {
    const err = new Error('cross-device link') as NodeJS.ErrnoException
    err.code = 'EXDEV'
    throw err
  })
  const cp = mock.method(fs, 'cp', async () => {
    throw new Error('disk full')
  })
  try {
    await assert.rejects(moveEntry(fromRoot, 'a.txt', toRoot, 'copied.txt'))
    // no partial file left at the destination, and the source is untouched
    await assert.rejects(fs.stat(path.join(toRoot, 'copied.txt')))
    assert.equal(await fs.readFile(path.join(fromRoot, 'a.txt'), 'utf8'), 'hello')
  } finally {
    cp.mock.restore()
    rename.mock.restore()
    await fs.rm(fromRoot, { recursive: true, force: true })
    await fs.rm(toRoot, { recursive: true, force: true })
  }
})

test('createFolder creates an empty directory and reports its relative path', async () => {
  const mroot = await makeMutableRoot()
  try {
    const result = await createFolder(mroot, 'newdir')
    assert.equal(result.rel, 'newdir')
    const st = await fs.stat(path.join(mroot, 'newdir'))
    assert.ok(st.isDirectory())
    assert.deepEqual(await fs.readdir(path.join(mroot, 'newdir')), [])
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('createFolder works inside a subfolder', async () => {
  const mroot = await makeMutableRoot()
  try {
    const result = await createFolder(mroot, 'sub/nested')
    assert.equal(result.rel, path.join('sub', 'nested'))
    const st = await fs.stat(path.join(mroot, 'sub', 'nested'))
    assert.ok(st.isDirectory())
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('createFolder refuses to overwrite an existing file or folder', async () => {
  const mroot = await makeMutableRoot()
  try {
    await expectStatus(createFolder(mroot, 'a.txt'), 409)
    await expectStatus(createFolder(mroot, 'sub'), 409)
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

test('createFolder rejects a missing parent, invalid names and traversal', async () => {
  const mroot = await makeMutableRoot()
  try {
    await expectStatus(createFolder(mroot, 'missing-parent/newdir'), 404)
    await expectStatus(createFolder(mroot, 'a.txt/newdir'), 400) // parent is a file
    await expectStatus(createFolder(mroot, '../escape'), 403)
  } finally {
    await fs.rm(mroot, { recursive: true, force: true })
  }
})

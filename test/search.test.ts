import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveInsideRoot } from '../src/server/browse.ts'
import { searchTree } from '../src/server/search.ts'

let outside: string
let root: string

before(async () => {
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-search-outside-'))
  await fs.writeFile(path.join(outside, 'Report.pdf'), 'secret')

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-search-root-'))
  await fs.writeFile(path.join(root, 'Report.pdf'), 'hi')
  await fs.mkdir(path.join(root, 'reports'))
  await fs.writeFile(path.join(root, 'reports', 'q1-report.txt'), 'q1')
  await fs.mkdir(path.join(root, 'reports', 'nested'))
  await fs.writeFile(path.join(root, 'reports', 'nested', 'deep-report.md'), 'deep')
  await fs.writeFile(path.join(root, 'unrelated.txt'), 'nope')
  await fs.symlink(path.join(root, 'Report.pdf'), path.join(root, 'link-inside-report.pdf'))
  await fs.symlink(path.join(outside, 'Report.pdf'), path.join(root, 'link-outside-report.pdf'))
  await fs.symlink(path.join(root, 'does-not-exist'), path.join(root, 'link-broken-report'))
  root = await fs.realpath(root)
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

test('finds matches by name anywhere in the tree, case-insensitively', async () => {
  const { hits, truncated } = await searchTree(root, root, { query: 'REPORT' })
  assert.equal(truncated, false)
  const names = hits.map(h => h.path).sort()
  assert.deepEqual(names, [
    'Report.pdf',
    'link-inside-report.pdf',
    path.join('reports'),
    path.join('reports', 'nested', 'deep-report.md'),
    path.join('reports', 'q1-report.txt')
  ].sort())
})

test('does not match unrelated names', async () => {
  const { hits } = await searchTree(root, root, { query: 'REPORT' })
  assert.ok(!hits.some(h => h.name === 'unrelated.txt'))
})

test('skips symlinks that escape the root, and broken symlinks', async () => {
  const { hits } = await searchTree(root, root, { query: 'report' })
  assert.ok(!hits.some(h => h.name === 'link-outside-report.pdf'))
  assert.ok(!hits.some(h => h.name === 'link-broken-report'))
})

test('filters by type', async () => {
  const dirsOnly = await searchTree(root, root, { query: 'report', type: 'dir' })
  assert.ok(dirsOnly.hits.every(h => h.type === 'dir'))
  assert.ok(dirsOnly.hits.some(h => h.name === 'reports'))

  const filesOnly = await searchTree(root, root, { query: 'report', type: 'file' })
  assert.ok(filesOnly.hits.every(h => h.type === 'file'))
  assert.ok(!filesOnly.hits.some(h => h.name === 'reports'))
})

test('can be scoped to a subdirectory', async () => {
  const scopeAbs = await resolveInsideRoot(root, 'reports')
  const { hits } = await searchTree(root, scopeAbs, { query: 'report' })
  const names = hits.map(h => h.name).sort()
  assert.deepEqual(names, ['deep-report.md', 'q1-report.txt'].sort())
})

test('reports directories with a null size and files with their byte size', async () => {
  const { hits } = await searchTree(root, root, { query: 'q1-report' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.type, 'file')
  assert.equal(hits[0]!.size, 2)
})

test('truncates once the result limit is hit', async () => {
  const { hits, truncated } = await searchTree(root, root, { query: 'report', limit: 2 })
  assert.equal(hits.length, 2)
  assert.equal(truncated, true)
})

test('truncates once the scan budget is exhausted, independent of the result limit', async () => {
  const { hits, truncated } = await searchTree(root, root, { query: 'nothing-matches-this', maxScanned: 1 })
  assert.equal(hits.length, 0)
  assert.equal(truncated, true)
})

test('an empty tree yields no hits and is not truncated', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-search-empty-'))
  try {
    const realEmpty = await fs.realpath(empty)
    const { hits, truncated } = await searchTree(realEmpty, realEmpty, { query: 'anything' })
    assert.deepEqual(hits, [])
    assert.equal(truncated, false)
  } finally {
    await fs.rm(empty, { recursive: true, force: true })
  }
})

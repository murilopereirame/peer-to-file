import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import { createCipherKeys } from '../src/server/cipherKeys.ts'
import { makeCipherStore } from '../src/server/cipherStore.ts'
import { createTorrentStore, pieceLengthFor } from '../src/server/torrents.ts'
import { CIPHER_ALGO } from '../src/server/cipher.ts'

const secret = crypto.randomBytes(32)
let dir: string

before(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-ck-'))) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function makeFile (name: string, bytes: number): Promise<{ abs: string, plain: Buffer }> {
  const plain = crypto.randomBytes(bytes)
  const abs = path.join(dir, name)
  await fs.writeFile(abs, plain)
  return { abs, plain }
}

function fullEncrypt (plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const c = crypto.createCipheriv(CIPHER_ALGO, key, iv)
  return Buffer.concat([c.update(plain), c.final()])
}

async function drain (stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

test('getKeys is deterministic per file identity', async () => {
  const ck = createCipherKeys(secret)
  const { abs } = await makeFile('keys.bin', 4096)
  const a = await ck.getKeys(abs)
  const b = await ck.getKeys(abs)
  assert.deepEqual(a.key, b.key)
  assert.deepEqual(a.iv, b.iv)
  assert.equal(a.size, 4096)
})

test('encryptedRange streams ciphertext byte-identical to a full encrypt', async () => {
  const ck = createCipherKeys(secret)
  const { abs, plain } = await makeFile('range.bin', 300 * 1024 + 7)
  const { key, iv, size } = await ck.getKeys(abs)
  const ref = fullEncrypt(plain, key, iv)

  // whole file
  assert.ok((await drain(ck.encryptedRange(abs, key, iv, 0, size - 1))).equals(ref))

  // assorted ranges, including unaligned starts and the final partial block
  const ranges: Array<[number, number]> = [[0, 15], [1, 100], [15, 4096], [16, 16], [17, 5000], [size - 1, size - 1], [size - 100, size - 1], [70000, 200000]]
  for (const [start, end] of ranges) {
    const got = await drain(ck.encryptedRange(abs, key, iv, start, end))
    assert.ok(got.equals(ref.subarray(start, end + 1)), `range [${start},${end}]`)
  }
})

test('cipher store serves pieces (and partial reads) identical to a full encrypt', async () => {
  const ck = createCipherKeys(secret)
  const size = 1024 * 1024 + 123
  const { abs, plain } = await makeFile('store.bin', size)
  const { key, iv } = await ck.getKeys(abs)
  const ref = fullEncrypt(plain, key, iv)
  const pieceLength = pieceLengthFor(size)
  const Store = makeCipherStore(abs, key, iv)
  const store = new Store(pieceLength, { length: size })

  const get = (index: number, opts: { offset?: number, length?: number }): Promise<Buffer> =>
    new Promise((resolve, reject) => (store as any).get(index, opts, (err: Error | null, buf?: Buffer) => err ? reject(err) : resolve(buf!)))

  const pieceCount = Math.ceil(size / pieceLength)
  // whole pieces, including the short last one
  for (let i = 0; i < pieceCount; i++) {
    const start = i * pieceLength
    const end = Math.min(start + pieceLength, size)
    const buf = await get(i, {})
    assert.ok(buf.equals(ref.subarray(start, end)), `piece ${i}`)
  }
  // partial read within a piece (WebTorrent requests these)
  const partial = await get(0, { offset: 100, length: 500 })
  assert.ok(partial.equals(ref.subarray(100, 600)), 'partial piece read')

  await new Promise<void>(r => (store as any).destroy(() => r()))
})

test('streaming torrent metadata matches the file-based infohash and is deterministic', async () => {
  const ck = createCipherKeys(secret)
  const size = 512 * 1024 + 77
  const { abs, plain } = await makeFile('meta.bin', size)
  const { key, iv } = await ck.getKeys(abs)
  const ref = fullEncrypt(plain, key, iv)

  // Reference: build a torrent the old way, from the ciphertext written to disk.
  const ctPath = path.join(dir, 'meta.ct')
  await fs.writeFile(ctPath, ref)
  const fileInfohash: string = await new Promise((resolve, reject) =>
    createTorrent(ctPath, { name: 'meta.bin', private: true, pieceLength: pieceLengthFor(size) }, (e, buf) =>
      e ? reject(e) : parseTorrent(buf).then(m => resolve(m.infoHash), reject)))

  const store = createTorrentStore(ck)
  const a = await store.getMeta(abs)
  const b = await store.getMeta(abs)
  assert.equal(a.meta.infoHash, fileInfohash, 'streamed infohash must equal file-based')
  assert.equal(a.meta.infoHash, b.meta.infoHash, 'infohash is deterministic / cached')
  assert.equal(a.meta.length, size)
  assert.equal(a.plainSha256, crypto.createHash('sha256').update(plain).digest('hex'), 'plaintext checksum')
})

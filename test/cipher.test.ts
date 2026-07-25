import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { deriveFileCipher, ctrCounter, encryptRange, DropBytes, CIPHER_ALGO } from '../src/server/cipher.ts'

const key = crypto.randomBytes(32)
const iv = crypto.randomBytes(16)

function fullEncrypt (plain: Buffer): Buffer {
  const c = crypto.createCipheriv(CIPHER_ALGO, key, iv)
  return Buffer.concat([c.update(plain), c.final()])
}

test('encryptRange reproduces the exact bytes of a full-file encrypt', () => {
  const N = 1024 * 1024 + 13 // spans many blocks, non-aligned tail
  const plain = crypto.randomBytes(N)
  const ref = fullEncrypt(plain)

  for (let i = 0; i < 1000; i++) {
    const start = Math.floor(Math.random() * N)
    const len = Math.min(N - start, Math.floor(Math.random() * 40000))
    const got = encryptRange(plain.subarray(start, start + len), key, iv, start)
    assert.ok(got.equals(ref.subarray(start, start + len)), `range [${start},${start + len}) mismatch`)
  }
})

test('encryptRange handles block-aligned, unaligned and single-byte offsets', () => {
  const plain = crypto.randomBytes(64)
  const ref = fullEncrypt(plain)
  const cases: Array<[number, number]> = [[0, 16], [1, 1], [15, 2], [16, 16], [16, 1], [17, 30], [63, 1], [0, 64]]
  for (const [start, len] of cases) {
    const got = encryptRange(plain.subarray(start, start + len), key, iv, start)
    assert.ok(got.equals(ref.subarray(start, start + len)), `offset ${start} len ${len}`)
  }
})

test('ctrCounter carries across byte boundaries (256, 65536, and the low 32 bits)', () => {
  // A base IV ending in zeros makes the carry easy to reason about.
  const base = Buffer.alloc(16)
  assert.equal(ctrCounter(base, 1).at(15), 1)
  assert.equal(ctrCounter(base, 255).at(15), 255)
  const c256 = ctrCounter(base, 256)
  assert.equal(c256.at(15), 0)
  assert.equal(c256.at(14), 1)
  const c65536 = ctrCounter(base, 65536)
  assert.equal(c65536.at(13), 1)
  assert.equal(c65536.at(14), 0)
  assert.equal(c65536.at(15), 0)
})

test('ctrCounter carry propagates through a rolling-over low byte', () => {
  const base = Buffer.alloc(16)
  base[15] = 0xff
  const c = ctrCounter(base, 1) // 0xff + 1 -> carry into byte 14
  assert.equal(c.at(15), 0)
  assert.equal(c.at(14), 1)
})

test('deriveFileCipher is deterministic and identity-specific', () => {
  const secret = crypto.randomBytes(32)
  const a1 = deriveFileCipher(secret, '/x:100:5')
  const a2 = deriveFileCipher(secret, '/x:100:5')
  const b = deriveFileCipher(secret, '/x:100:6')
  assert.deepEqual(a1.key, a2.key)
  assert.deepEqual(a1.iv, a2.iv)
  assert.equal(a1.key.length, 32)
  assert.equal(a1.iv.length, 16)
  assert.ok(!a1.key.equals(b.key), 'different identity must derive a different key')
  // A different master secret must derive a different key for the same identity.
  const other = deriveFileCipher(crypto.randomBytes(32), '/x:100:5')
  assert.ok(!a1.key.equals(other.key))
})

test('DropBytes drops exactly the first n bytes across chunk boundaries', async () => {
  const drop = new DropBytes(5)
  const out: Buffer[] = []
  drop.on('data', c => out.push(c as Buffer))
  drop.write(Buffer.from('abc'))
  drop.write(Buffer.from('defgh'))
  drop.end(Buffer.from('ij'))
  await new Promise(r => drop.on('end', r))
  assert.equal(Buffer.concat(out).toString(), 'fghij')
})

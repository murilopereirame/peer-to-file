// Piece-level repair of a saved desktop download (apps/desktop/electron/
// pieceRepair.cts), run against a real server: a saved file that is
// truncated, has damaged bytes or is missing gets fixed by re-fetching only
// the affected pieces from the webseed, and ends up matching the server's
// plaintext SHA-256.
//
// pieceRepair.cts is part of the Electron main-process build (CommonJS), which
// Node can't load from source, so it is compiled into a temp folder first.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { silentLogger } from '../src/server/log.ts'
import { testConfig } from './support.ts'

type FetchRange = (start: number, end: number, signal: AbortSignal) => Promise<Uint8Array>
interface RepairModule {
  parseTorrentLayout: (torrent: Uint8Array) => { pieceLength: number, length: number, pieceHashes: string[] }
  ctrXorAt: (data: Uint8Array, offset: number, key: Uint8Array, iv: Uint8Array) => Buffer
  webseedFetcher: (url: string) => FetchRange
  repairDownload: (
    req: { filePath: string, torrent: Uint8Array, key: Uint8Array, iv: Uint8Array, webseed: string },
    onProgress?: unknown, signal?: AbortSignal, fetchRange?: FetchRange
  ) => Promise<{ pieces: number, damaged: number[] }>
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const webcrypto = crypto.webcrypto
// A short last piece on purpose (not a whole number of pieces).
const content = crypto.randomBytes(3 * 1024 * 1024 + 123)

let tmp: string
let running: RunningServer
let repair: RepairModule
let meta: { webseed: string, torrentBase64: string, plainSha256: string }
let key: Buffer
let iv: Buffer
let torrent: Buffer
let pieceLength: number
let pieceCount: number
let out: string

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-repair-')))
  const outDir = path.join(tmp, 'build')
  execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), [
    '--ignoreConfig', path.join(repoRoot, 'apps/desktop/electron/pieceRepair.cts'),
    '--outDir', outDir, '--rootDir', path.join(repoRoot, 'apps/desktop/electron'),
    '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022',
    '--strict', '--skipLibCheck', '--types', 'node', '--typeRoots', path.join(repoRoot, 'node_modules/@types')
  ], { stdio: 'pipe' })
  repair = createRequire(import.meta.url)(path.join(outDir, 'pieceRepair.cjs')) as RepairModule

  const root = path.join(tmp, 'root')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'f.bin'), content)
  running = await startServer(testConfig({ root }), silentLogger)
  const base = `http://127.0.0.1:${running.config.port}`
  running.db.createUser('alice', 'correct horse battery')
  const headers = { Authorization: `Bearer ${running.db.createApiToken('alice', 'test')}` }

  // Fetch /api/torrent the way the app does and unwrap the transfer key.
  const info = await (await fetch(`${base}/api/info`, { headers })).json() as { ecdhPublicKey: string }
  const curve = { name: 'ECDH', namedCurve: 'P-256' }
  const keyPair = await webcrypto.subtle.generateKey(curve, true, ['deriveBits'])
  const serverKey = await webcrypto.subtle.importKey('raw', Buffer.from(info.ecdhPublicKey, 'base64'), curve, false, [])
  const bits = await webcrypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, keyPair.privateKey, 256)
  const hkdf = await webcrypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const wrapKey = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('p2f-key-wrap') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  )
  const ck = Buffer.from(await webcrypto.subtle.exportKey('raw', keyPair.publicKey)).toString('base64')
  const res = await fetch(`${base}/api/torrent?path=f.bin&ck=${encodeURIComponent(ck)}`, { headers })
  const body = await res.json() as typeof meta & { encKeyWrapped: string }
  meta = body
  const blob = Buffer.from(body.encKeyWrapped, 'base64')
  const keyMaterial = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, wrapKey, blob.subarray(12)))
  key = keyMaterial.subarray(0, 32)
  iv = keyMaterial.subarray(32, 48)
  torrent = Buffer.from(body.torrentBase64, 'base64')
  const layout = repair.parseTorrentLayout(torrent)
  pieceLength = layout.pieceLength
  pieceCount = layout.pieceHashes.length
  out = path.join(tmp, 'saved.bin')
})

after(async () => {
  await running?.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

const sha256 = (b: Uint8Array): string => crypto.createHash('sha256').update(b).digest('hex')

/** Runs a repair on whatever is at `out`, recording which pieces it fetched. */
async function repairAndCheck (expectDamaged: number[]): Promise<void> {
  const fetched: number[] = []
  const real = repair.webseedFetcher(meta.webseed)
  const result = await repair.repairDownload({ filePath: out, torrent, key, iv, webseed: meta.webseed }, undefined, undefined,
    async (start, end, signal) => { fetched.push(start / pieceLength); return await real(start, end, signal) })
  assert.deepEqual(result.damaged, expectDamaged, 'damaged pieces found')
  assert.deepEqual(fetched.sort((a, b) => a - b), expectDamaged, 'only the damaged pieces are fetched')
  assert.equal(sha256(await fs.readFile(out)), meta.plainSha256, 'repaired file matches the server')
}

test('the torrent layout and offset decryption match the server', async () => {
  const layout = repair.parseTorrentLayout(torrent)
  assert.equal(layout.length, content.length)
  assert.equal(layout.pieceHashes.length, Math.ceil(content.length / layout.pieceLength))
  // An offset that isn't on an AES block boundary.
  const res = await fetch(meta.webseed, { headers: { Range: 'bytes=5-1000' } })
  const cipher = Buffer.from(await res.arrayBuffer())
  assert.deepEqual(repair.ctrXorAt(content.subarray(5, 1001), 5, key, iv), cipher)
})

test('a truncated file gets only its missing tail re-fetched', async () => {
  await fs.writeFile(out, content.subarray(0, Math.floor(pieceLength * 4.5)))
  await repairAndCheck(Array.from({ length: pieceCount - 4 }, (_v, i) => i + 4))
})

test('damaged bytes inside the file get only their pieces re-fetched', async () => {
  const damaged = Buffer.from(content)
  damaged[pieceLength * 2 + 77]! ^= 0xff
  damaged.fill(0, pieceLength * 5 + 10, pieceLength * 6 + 20)
  await fs.writeFile(out, damaged)
  await repairAndCheck([2, 5, 6])
})

test('a short last piece is fixed', async () => {
  await fs.writeFile(out, content.subarray(0, content.length - 1))
  await repairAndCheck([pieceCount - 1])
})

test('a missing file is rebuilt from scratch', async () => {
  await fs.rm(out, { force: true })
  await repairAndCheck(Array.from({ length: pieceCount }, (_v, i) => i))
})

test('an intact file only loses trailing junk', async () => {
  await fs.writeFile(out, Buffer.concat([content, Buffer.from('junk')]))
  await repairAndCheck([])
})

test('data that fails its piece hash is never written', async () => {
  const truncated = content.subarray(0, pieceLength)
  await fs.writeFile(out, truncated)
  // Wrong bytes every time: the repair gives up (after its retries) with an error.
  await assert.rejects(
    repair.repairDownload({ filePath: out, torrent, key, iv, webseed: meta.webseed }, undefined, undefined,
      async (start, end) => Buffer.alloc(end - start + 1)),
    /hash check/
  )
  const after = await fs.readFile(out)
  assert.deepEqual(after.subarray(0, pieceLength), truncated, 'good pieces are left untouched')
})

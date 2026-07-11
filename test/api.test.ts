import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import parseTorrent from 'parse-torrent'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { silentLogger } from '../src/server/log.ts'

let root: string
let running: RunningServer
let base: string
const fileContent = crypto.randomBytes(64 * 1024)

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-api-')))
  await fs.writeFile(path.join(root, 'big.bin'), fileContent)
  await fs.mkdir(path.join(root, 'docs'))
  await fs.writeFile(path.join(root, 'docs', 'readme.md'), '# hi\n')

  running = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
    trackerPort: 0,
    publicHost: null,
    publicUrl: null,
    authEnabled: false,
    dbPath: ':memory:'
  }, silentLogger)
  base = `http://127.0.0.1:${running.config.port}`
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
})

test('GET /api/info identifies the server', async () => {
  const res = await fetch(`${base}/api/info`)
  assert.equal(res.status, 200)
  const body = await res.json() as any
  assert.equal(body.name, 'peer-to-file')
  assert.equal(typeof body.version, 'string')
  assert.equal(typeof body.webrtcSeeding, 'boolean')
})

test('GET /api/list returns the directory listing', async () => {
  const res = await fetch(`${base}/api/list?path=`)
  assert.equal(res.status, 200)
  const body = await res.json() as any
  assert.equal(body.path, '')
  assert.deepEqual(
    body.entries.map((e: { name: string, type: string }) => [e.name, e.type]),
    [['docs', 'dir'], ['big.bin', 'file']]
  )
})

test('GET /api/list rejects traversal', async () => {
  const res = await fetch(`${base}/api/list?path=${encodeURIComponent('../')}`)
  assert.equal(res.status, 403)
  const body = await res.json() as any
  assert.match(body.error, /escapes/)
})

test('GET /api/torrent returns consistent, webseed-carrying metadata', async () => {
  const res = await fetch(`${base}/api/torrent?path=big.bin`)
  assert.equal(res.status, 200)
  const body = await res.json() as any

  assert.equal(body.name, 'big.bin')
  assert.equal(body.length, fileContent.length)
  assert.match(body.infoHash, /^[0-9a-f]{40}$/)
  assert.deepEqual(body.announce, [`ws://127.0.0.1:${running.config.trackerPort}`])
  assert.ok(body.webseed.startsWith(`http://127.0.0.1:${running.config.port}/api/raw?path=`))
  assert.ok(body.magnet.startsWith(`magnet:?xt=urn:btih:${body.infoHash}`))

  // the .torrent must parse and agree with the JSON envelope
  const parsed = await parseTorrent(Buffer.from(body.torrentBase64, 'base64'))
  assert.equal(parsed.infoHash, body.infoHash)
  assert.equal(parsed.length, fileContent.length)
  assert.equal(parsed.private, true)
  assert.deepEqual(parsed.announce, body.announce)
  assert.deepEqual(parsed.urlList, [body.webseed])

  // metadata is cached: a second request returns the same infohash
  const again = await (await fetch(`${base}/api/torrent?path=big.bin`)).json() as any
  assert.equal(again.infoHash, body.infoHash)
})

test('GET /api/torrent on a directory is a 400', async () => {
  const res = await fetch(`${base}/api/torrent?path=docs`)
  assert.equal(res.status, 400)
})

test('GET /api/raw serves the file with Range support (webseed)', async () => {
  const whole = await fetch(`${base}/api/raw?path=big.bin`)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), fileContent)

  const res = await fetch(`${base}/api/raw?path=big.bin`, {
    headers: { Range: 'bytes=10-13' }
  })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 10-13/${fileContent.length}`)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fileContent.subarray(10, 14))
})

test('GET /api/raw rejects traversal and missing files', async () => {
  const evil = await fetch(`${base}/api/raw?path=${encodeURIComponent('../../etc/passwd')}`)
  assert.equal(evil.status, 403)
  const missing = await fetch(`${base}/api/raw?path=nope.bin`)
  assert.equal(missing.status, 404)
})

test('API responses carry permissive CORS headers', async () => {
  const res = await fetch(`${base}/api/info`)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})

test('serves the web client and the WebTorrent bundle', async () => {
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /peer-to-file/)

  const bundle = await fetch(`${base}/vendor/webtorrent.min.js`, { method: 'HEAD' })
  assert.equal(bundle.status, 200)
})

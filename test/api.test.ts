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
    dbPath: ':memory:',
    cacheDir: path.join(root, '.p2f-cache')
  }, silentLogger)
  base = `http://127.0.0.1:${running.config.port}`
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
})

// Test-side mirror of the client's ECDH key-wrap flow (packages/shared/src/
// browserCrypto.ts), using node:crypto's webcrypto instead of a browser, to
// exercise /api/torrent and /api/upload the same way a real client would —
// including unwrapping/wrapping the transfer key, not just asserting it's
// present.
const webcrypto = crypto.webcrypto

async function establishKeyWrap (serverPublicKeyBase64: string): Promise<{ wrapKey: CryptoKey, clientPublicKeyBase64: string }> {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const serverPublicKey = await webcrypto.subtle.importKey(
    'raw', Buffer.from(serverPublicKeyBase64, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )
  const sharedBits = await webcrypto.subtle.deriveBits({ name: 'ECDH', public: serverPublicKey }, keyPair.privateKey, 256)
  const hkdfKey = await webcrypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
  const wrapKey = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('p2f-key-wrap') },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
  const clientPublicKeyRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', keyPair.publicKey))
  return { wrapKey, clientPublicKeyBase64: clientPublicKeyRaw.toString('base64') }
}

async function unwrapKeyMaterial (wrapKey: CryptoKey, wrappedBase64: string): Promise<Buffer> {
  const blob = Buffer.from(wrappedBase64, 'base64')
  const nonce = blob.subarray(0, 12)
  const ciphertextAndTag = blob.subarray(12)
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, wrapKey, ciphertextAndTag)
  return Buffer.from(plain)
}

async function wrapKeyMaterial (wrapKey: CryptoKey, plaintext: Buffer): Promise<string> {
  const nonce = crypto.randomBytes(12)
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, wrapKey, Uint8Array.from(plaintext))
  return Buffer.concat([nonce, Buffer.from(ciphertext)]).toString('base64')
}

/** Fetches /api/torrent the way a real client does: establish a key wrap, unwrap the returned key+IV. */
async function fetchTorrentMeta (relPath: string): Promise<{ meta: any, key: Buffer, iv: Buffer }> {
  const info = await (await fetch(`${base}/api/info`)).json() as any
  const keyWrap = await establishKeyWrap(info.ecdhPublicKey)
  const res = await fetch(
    `${base}/api/torrent?path=${encodeURIComponent(relPath)}&ck=${encodeURIComponent(keyWrap.clientPublicKeyBase64)}`
  )
  const meta = await res.json() as any
  const keyMaterial = await unwrapKeyMaterial(keyWrap.wrapKey, meta.encKeyWrapped)
  return { meta, key: keyMaterial.subarray(0, 32), iv: keyMaterial.subarray(32, 48) }
}

/** Encrypts an upload payload the way a real client does, returning ready-to-send headers. */
async function encryptUpload (payload: Buffer): Promise<{ body: Buffer, headers: Record<string, string> }> {
  const info = await (await fetch(`${base}/api/info`)).json() as any
  const keyWrap = await establishKeyWrap(info.ecdhPublicKey)

  const key = crypto.randomBytes(32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv)
  const body = Buffer.concat([cipher.update(payload), cipher.final()])
  const plainSha256 = crypto.createHash('sha256').update(payload).digest('hex')
  const wrappedKey = await wrapKeyMaterial(keyWrap.wrapKey, Buffer.concat([key, iv]))

  return {
    body,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-P2F-Enc-Client-Pubkey': keyWrap.clientPublicKeyBase64,
      'X-P2F-Enc-Key-Wrapped': wrappedKey,
      'X-P2F-Plain-Sha256': plainSha256
    }
  }
}

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
  const { meta: body, key, iv } = await fetchTorrentMeta('big.bin')

  assert.equal(body.name, 'big.bin')
  assert.equal(body.length, fileContent.length)
  assert.match(body.infoHash, /^[0-9a-f]{40}$/)
  assert.deepEqual(body.announce, [`ws://127.0.0.1:${running.config.trackerPort}`])
  assert.ok(body.webseed.startsWith(`http://127.0.0.1:${running.config.port}/api/raw?path=`))
  assert.ok(body.magnet.startsWith(`magnet:?xt=urn:btih:${body.infoHash}`))

  // the transfer-encryption key/IV are ECDH-wrapped, not sent in the clear
  assert.equal(key.length, 32)
  assert.equal(iv.length, 16)

  // the .torrent must parse and agree with the JSON envelope
  const parsed = await parseTorrent(Buffer.from(body.torrentBase64, 'base64'))
  assert.equal(parsed.infoHash, body.infoHash)
  assert.equal(parsed.length, fileContent.length)
  assert.equal(parsed.private, true)
  assert.deepEqual(parsed.announce, body.announce)
  assert.deepEqual(parsed.urlList, [body.webseed])

  // metadata is cached: a second request returns the same infohash
  const { meta: again } = await fetchTorrentMeta('big.bin')
  assert.equal(again.infoHash, body.infoHash)
})

test('GET /api/torrent without ck (client ECDH public key) is a 400', async () => {
  const res = await fetch(`${base}/api/torrent?path=big.bin`)
  assert.equal(res.status, 400)
})

test('GET /api/torrent on a directory is a 400', async () => {
  const info = await (await fetch(`${base}/api/info`)).json() as any
  const keyWrap = await establishKeyWrap(info.ecdhPublicKey)
  const res = await fetch(
    `${base}/api/torrent?path=docs&ck=${encodeURIComponent(keyWrap.clientPublicKeyBase64)}`
  )
  assert.equal(res.status, 400)
})

test('GET /api/raw serves AES-256-CTR ciphertext with Range support (webseed)', async () => {
  const { key, iv } = await fetchTorrentMeta('big.bin')
  const decrypt = (buf: Buffer, offset: number): Buffer => {
    // AES-CTR at a byte offset: bump the counter by whole blocks, matching
    // the client-side offset-aware helper (packages/shared/browserCrypto.ts).
    const blockOffset = offset % 16
    const counter = Buffer.from(iv)
    let carry = Math.floor(offset / 16)
    for (let i = 15; i >= 0 && carry > 0; i--) {
      const sum = counter[i]! + (carry % 256)
      counter[i] = sum % 256
      carry = Math.floor(carry / 256) + Math.floor(sum / 256)
    }
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, counter)
    const padded = Buffer.concat([Buffer.alloc(blockOffset), buf])
    return Buffer.concat([decipher.update(padded), decipher.final()]).subarray(blockOffset)
  }

  const whole = await fetch(`${base}/api/raw?path=big.bin`)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  const wholeCipher = Buffer.from(await whole.arrayBuffer())
  // the wire must not carry plaintext — that's the whole point of this feature
  assert.notDeepEqual(wholeCipher, fileContent)
  assert.deepEqual(decrypt(wholeCipher, 0), fileContent)

  const res = await fetch(`${base}/api/raw?path=big.bin`, {
    headers: { Range: 'bytes=10-13' }
  })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 10-13/${fileContent.length}`)
  const rangeCipher = Buffer.from(await res.arrayBuffer())
  assert.deepEqual(decrypt(rangeCipher, 10), fileContent.subarray(10, 14))
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

test('POST /api/delete removes a file', async () => {
  await fs.writeFile(path.join(root, 'scratch.txt'), 'delete me')
  const res = await fetch(`${base}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'scratch.txt' })
  })
  assert.equal(res.status, 200)
  await assert.rejects(fs.stat(path.join(root, 'scratch.txt')))
})

test('POST /api/delete rejects traversal and missing files', async () => {
  const escape = await fetch(`${base}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '../escape.txt' })
  })
  assert.equal(escape.status, 403)

  const missing = await fetch(`${base}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'nope.bin' })
  })
  assert.equal(missing.status, 404)
})

test('POST /api/move renames and moves entries', async () => {
  await fs.writeFile(path.join(root, 'movable.txt'), 'move me')

  const rename = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'movable.txt', to: 'renamed.txt' })
  })
  assert.equal(rename.status, 200)
  const renameBody = await rename.json() as any
  assert.equal(renameBody.path, 'renamed.txt')

  const move = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'renamed.txt', to: 'docs/renamed.txt' })
  })
  assert.equal(move.status, 200)
  assert.equal(await fs.readFile(path.join(root, 'docs', 'renamed.txt'), 'utf8'), 'move me')

  // clean up so later tests still see the original docs/ listing
  await fs.rm(path.join(root, 'docs', 'renamed.txt'))
})

test('POST /api/move refuses to overwrite an existing entry', async () => {
  await fs.writeFile(path.join(root, 'src-move.txt'), 'a')
  const res = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'src-move.txt', to: 'big.bin' })
  })
  assert.equal(res.status, 409)
  await fs.rm(path.join(root, 'src-move.txt'))
})

test('POST /api/upload streams a file to disk', async () => {
  const payload = crypto.randomBytes(256 * 1024)
  const { body, headers } = await encryptUpload(payload)
  const res = await fetch(`${base}/api/upload?path=&name=${encodeURIComponent('uploaded.bin')}`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half'
  } as RequestInit)
  assert.equal(res.status, 201)
  const resBody = await res.json() as any
  assert.equal(resBody.path, 'uploaded.bin')
  assert.equal(resBody.size, payload.length)
  assert.deepEqual(await fs.readFile(path.join(root, 'uploaded.bin')), payload)
  await fs.rm(path.join(root, 'uploaded.bin'))
})

test('POST /api/upload rejects a bad plaintext checksum', async () => {
  const payload = crypto.randomBytes(1024)
  const { body, headers } = await encryptUpload(payload)
  headers['X-P2F-Plain-Sha256'] = crypto.randomBytes(32).toString('hex')
  const res = await fetch(`${base}/api/upload?path=&name=${encodeURIComponent('bad-checksum.bin')}`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half'
  } as RequestInit)
  assert.equal(res.status, 400)
  await assert.rejects(fs.access(path.join(root, 'bad-checksum.bin')))
})

test('POST /api/upload rejects missing encryption headers', async () => {
  const res = await fetch(`${base}/api/upload?path=&name=${encodeURIComponent('no-headers.bin')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: crypto.randomBytes(1024),
    duplex: 'half'
  } as RequestInit)
  assert.equal(res.status, 400)
})

test('POST /api/upload works for a .json file (not swallowed by the JSON body parser)', async () => {
  // A browser sets the upload's Content-Type from the File's own type, which
  // for a .json file is application/json — this must NOT be intercepted by
  // the same express.json() used by /api/setup, /api/login, /api/delete and
  // /api/move, or the raw body never reaches the upload handler.
  const payload = Buffer.from(JSON.stringify({ hello: 'world', n: 42 }))
  const { body, headers } = await encryptUpload(payload)
  headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}/api/upload?path=&name=${encodeURIComponent('data.json')}`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half'
  } as RequestInit)
  assert.equal(res.status, 201)
  const resBody = await res.json() as any
  assert.equal(resBody.size, payload.length)
  assert.deepEqual(await fs.readFile(path.join(root, 'data.json')), payload)
  await fs.rm(path.join(root, 'data.json'))
})

test('POST /api/upload rejects an invalid name and an existing target', async () => {
  const badName = await fetch(`${base}/api/upload?path=&name=${encodeURIComponent('../escape.bin')}`, {
    method: 'POST',
    ...await encryptUpload(Buffer.from('x')),
    duplex: 'half'
  } as RequestInit)
  assert.equal(badName.status, 400)

  const collision = await fetch(`${base}/api/upload?path=&name=${encodeURIComponent('big.bin')}`, {
    method: 'POST',
    ...await encryptUpload(Buffer.from('x')),
    duplex: 'half'
  } as RequestInit)
  assert.equal(collision.status, 409)
  // the original file must survive an attempted overwrite
  assert.deepEqual(await fs.readFile(path.join(root, 'big.bin')), fileContent)
})

test('download history works without auth as a single shared, unscoped list', async () => {
  const record = await fetch(`${base}/api/downloads/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'big.bin', name: 'big.bin', length: fileContent.length })
  })
  assert.equal(record.status, 201)

  const list = await (await fetch(`${base}/api/downloads/history`)).json() as any
  assert.deepEqual(list.entries.map((e: any) => e.name), ['big.bin'])

  const clear = await fetch(`${base}/api/downloads/history/clear`, { method: 'POST' })
  assert.equal(clear.status, 200)
  const after = await (await fetch(`${base}/api/downloads/history`)).json() as any
  assert.deepEqual(after.entries, [])
})

test('serves the web client and the WebTorrent bundle', async () => {
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /P2File/)

  const bundle = await fetch(`${base}/vendor/webtorrent.min.js`, { method: 'HEAD' })
  assert.equal(bundle.status, 200)
})

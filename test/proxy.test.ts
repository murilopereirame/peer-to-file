import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import parseTorrent from 'parse-torrent'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { silentLogger } from '../src/server/log.ts'
import { testConfig } from './support.ts'

// Reverse-proxy mode: P2F_PUBLIC_URL set, tracker reachable on the main
// HTTP port at /tracker, all handed-out URLs based on the public origin.

let root: string
let running: RunningServer
let base: string
let apiToken: string

const auth = (): Record<string, string> => ({ Authorization: `Bearer ${apiToken}` })

/** A throwaway ECDH (P-256) public key — /api/torrent requires one (see keyExchange.ts) but these tests don't unwrap the response's key material. */
async function clientPublicKey (): Promise<string> {
  const keyPair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', keyPair.publicKey)).toString('base64')
}

async function torrentMeta (): Promise<any> {
  const ck = await clientPublicKey()
  const res = await fetch(`${base}/api/torrent?path=file.bin&ck=${encodeURIComponent(ck)}`, { headers: auth() })
  assert.equal(res.status, 200)
  return await res.json()
}

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-proxy-')))
  await fs.writeFile(path.join(root, 'file.bin'), crypto.randomBytes(32 * 1024))

  running = await startServer(testConfig({
    root,
    publicUrl: 'https://files.example.com'
  }), silentLogger)
  base = `http://127.0.0.1:${running.config.port}`
  running.db.createUser('alice', 'correct horse battery')
  apiToken = running.db.createApiToken('alice', 'test')
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
})

test('metadata URLs use the public origin (wss + same-port tracker path)', async () => {
  const body = await torrentMeta()

  // announce/webseed use the public origin and now carry transfer tokens (F3)
  assert.ok(body.announce[0].startsWith(`wss://files.example.com/tracker?ih=${body.infoHash}&t=`))
  assert.ok(body.webseed.startsWith('https://files.example.com/api/raw?path=file.bin&t='))

  const parsed = await parseTorrent(Buffer.from(body.torrentBase64, 'base64'))
  assert.deepEqual(parsed.announce, body.announce)
  assert.deepEqual(parsed.urlList, [body.webseed])
})

test('the tracker answers announces on the main port at /tracker', async () => {
  const body = await torrentMeta()
  const { infoHash } = body
  // Reuse the infohash + token from the announce URL to reach the local port.
  const announce = new URL(body.announce[0])
  const localTracker = `ws://127.0.0.1:${running.config.port}/tracker?ih=${announce.searchParams.get('ih')}&t=${encodeURIComponent(announce.searchParams.get('t')!)}`

  const ws = new WebSocket(localTracker)
  const reply = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tracker reply')), 5000)
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        action: 'announce',
        info_hash: Buffer.from(infoHash, 'hex').toString('binary'),
        peer_id: Buffer.from('-P2FTEST0000000000AA', 'ascii').toString('binary'),
        uploaded: 0,
        downloaded: 0,
        left: 1,
        event: 'started',
        numwant: 0
      }))
    })
    ws.on('message', data => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()))
    })
  })
  ws.close()

  assert.equal(reply.action, 'announce')
  assert.equal(reply.info_hash, Buffer.from(infoHash, 'hex').toString('binary'))
  assert.equal(typeof reply.interval, 'number')
  assert.equal(reply['failure reason'], undefined)
})

test('non-tracker upgrade requests are rejected', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${running.config.port}/other`)
  const outcome = await new Promise<string>(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 5000)
    ws.on('open', () => { clearTimeout(timer); resolve('open') })
    ws.on('error', () => { clearTimeout(timer); resolve('rejected') })
    ws.on('unexpected-response', () => { clearTimeout(timer); resolve('rejected') })
  })
  ws.terminate()
  assert.equal(outcome, 'rejected')
})

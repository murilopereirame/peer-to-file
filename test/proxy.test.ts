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

// Reverse-proxy mode: P2F_PUBLIC_URL set, tracker reachable on the main
// HTTP port at /tracker, all handed-out URLs based on the public origin.

let root: string
let running: RunningServer
let base: string

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-proxy-')))
  await fs.writeFile(path.join(root, 'file.bin'), crypto.randomBytes(32 * 1024))

  running = await startServer({
    root,
    host: '127.0.0.1',
    port: 0,
    trackerPort: 0,
    publicHost: null,
    publicUrl: 'https://files.example.com',
    authEnabled: false,
    dbPath: ':memory:'
  }, silentLogger)
  base = `http://127.0.0.1:${running.config.port}`
})

after(async () => {
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
})

test('metadata URLs use the public origin (wss + same-port tracker path)', async () => {
  const res = await fetch(`${base}/api/torrent?path=file.bin`)
  assert.equal(res.status, 200)
  const body = await res.json() as any

  assert.deepEqual(body.announce, ['wss://files.example.com/tracker'])
  assert.equal(body.webseed, 'https://files.example.com/api/raw?path=file.bin')

  const parsed = await parseTorrent(Buffer.from(body.torrentBase64, 'base64'))
  assert.deepEqual(parsed.announce, ['wss://files.example.com/tracker'])
  assert.deepEqual(parsed.urlList, ['https://files.example.com/api/raw?path=file.bin'])
})

test('the tracker answers announces on the main port at /tracker', async () => {
  const res = await fetch(`${base}/api/torrent?path=file.bin`)
  const { infoHash } = await res.json() as any

  const ws = new WebSocket(`ws://127.0.0.1:${running.config.port}/tracker`)
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
  const failed = await new Promise<boolean>(resolve => {
    ws.on('open', () => resolve(false))
    ws.on('error', () => resolve(true))
  })
  assert.equal(failed, true)
})

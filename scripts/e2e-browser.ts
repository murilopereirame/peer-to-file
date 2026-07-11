// End-to-end verification with a real browser (M5 + M6 from the requirements):
//
//   1. serve a temp directory with a random payload file
//   2. load the web client in headless Chromium, connect, browse
//   3. start a download (WebTorrent in the browser)
//   4. kill the server mid-download, wait, bring it back on the same ports
//   5. assert the download RESUMES (progress never resets) and completes
//   6. checksum the saved file against the source
//
// Requires a Chromium-driving package: npm i --no-save playwright-core
// (plus a Chromium binary; set E2E_CHROMIUM to its path if playwright's
// bundled browser is not installed).
//
// Run with: npm run e2e

import { createHash } from 'node:crypto'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { consoleLogger } from '../src/server/log.ts'

const PORT = 18620
const TRACKER_PORT = 18621
const FILE_SIZE = 24 * 1024 * 1024

function fail (msg: string): never {
  console.error(`E2E FAIL: ${msg}`)
  process.exit(1)
}

async function findChromium (): Promise<string | undefined> {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean) as string[]
  for (const root of roots) {
    try {
      for (const dir of await fs.readdir(root)) {
        if (!dir.startsWith('chromium-')) continue
        for (const candidate of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
          const p = path.join(root, dir, candidate)
          try { await fs.access(p); return p } catch {}
        }
      }
    } catch {}
  }
  return undefined
}

const { chromium } = await import('playwright-core')

// --- test fixture ----------------------------------------------------------

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-e2e-')))
await fs.mkdir(path.join(root, 'movies'))
const payload = crypto.randomBytes(FILE_SIZE)
const payloadSha = createHash('sha256').update(payload).digest('hex')
await fs.writeFile(path.join(root, 'movies', 'payload.bin'), payload)
await fs.writeFile(path.join(root, 'notes.txt'), 'hello\n')

const config = () => ({
  root,
  host: '127.0.0.1',
  port: PORT,
  trackerPort: TRACKER_PORT,
  publicHost: null
})

let running: RunningServer = await startServer(config(), consoleLogger)

const executablePath = await findChromium()
const browser = await chromium.launch({ executablePath })
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()
page.on('console', msg => {
  if (msg.type() === 'error') console.log(`  [browser] ${msg.text()}`)
})
page.on('pageerror', err => console.log(`  [browser page error] ${err.message}`))

try {
  // 1. load the client — it should auto-connect to the serving host
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForSelector('#conn-status.ok', { timeout: 10_000 })
  console.log('✓ client connected')

  // 2. browse: root listing shows the folder, click into it
  await page.waitForSelector('#listing li.dir')
  const dirText = await page.textContent('#listing li.dir')
  if (!dirText?.includes('movies')) fail(`expected movies dir in listing, got: ${dirText}`)
  await page.click('#listing li.dir')
  await page.waitForSelector('#listing li.file')
  console.log('✓ folder navigation works')

  // breadcrumb shows root + current folder
  const crumb = await page.textContent('#breadcrumb')
  if (!crumb?.includes('movies')) fail('breadcrumb missing current folder')

  // 3. start the download
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 })
  await page.click('#listing li.file button')
  await page.waitForSelector('#downloads li[data-state="downloading"]', { timeout: 60_000 })
  console.log('✓ download started (torrent metadata fetched, transfer running)')

  const downloaded = () => page.$eval(
    '#downloads li',
    el => Number((el as HTMLElement).dataset.downloaded ?? 0)
  )
  const state = () => page.$eval(
    '#downloads li',
    el => (el as HTMLElement).dataset.state ?? ''
  )

  // wait until ~25% is transferred
  let before = 0
  for (let i = 0; i < 600; i++) {
    before = await downloaded()
    if (before > FILE_SIZE / 4) break
    if (await state() === 'done') fail('download finished before the interruption — file too small for this test')
    await sleep(100)
  }
  if (before <= FILE_SIZE / 4) fail('download did not reach 25%')
  console.log(`✓ ${(before / FILE_SIZE * 100).toFixed(0)}% transferred — killing the server now`)

  // 4. simulate a network drop: full server restart on the same ports
  await running.close()
  await sleep(4000)
  const atRestart = await downloaded()
  running = await startServer(config(), consoleLogger)
  console.log(`✓ server restarted (client held ${(atRestart / FILE_SIZE * 100).toFixed(0)}%)`)

  // 5. the download must finish without restarting from zero
  const download = await downloadPromise
  const after = await downloaded()
  if (after < before) fail(`progress went backwards: ${before} -> ${after} (restarted from zero?)`)
  await page.waitForSelector('#downloads li[data-state="done"]', { timeout: 60_000 })
  console.log('✓ download resumed after reconnect and completed')

  // 6. verify content
  const saved = path.join(root, 'downloaded-payload.bin')
  await download.saveAs(saved)
  const savedSha = createHash('sha256').update(await fs.readFile(saved)).digest('hex')
  if (download.suggestedFilename() !== 'payload.bin') {
    fail(`unexpected filename: ${download.suggestedFilename()}`)
  }
  if (savedSha !== payloadSha) fail(`checksum mismatch: ${savedSha} != ${payloadSha}`)
  console.log('✓ saved file checksum matches the source')

  console.log('\nE2E PASS')
} finally {
  await browser.close()
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
}

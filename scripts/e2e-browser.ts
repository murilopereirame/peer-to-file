// End-to-end verification with a real browser:
//
//   1. serve a temp directory with a random payload file (auth ON, no users)
//   2. load the web client in headless Chromium — expect the first-run
//      setup screen, create the admin account through it (this signs in)
//   3. log out and back in through the normal login form, to also cover
//      that path (including a wrong-password rejection)
//   4. browse into a folder (navigate-then-load UI) and start a download
//   5. pause the download and assert bandwidth actually stops, then resume
//   6. kill the server mid-download, bring it back on the same ports —
//      the transfer must resume, not restart
//   7. pause again, RELOAD THE PAGE — the download list and verified pieces
//      (OPFS) must survive; resume and let it finish
//   8. checksum the saved file against the source
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
const USER = 'e2e'
const PASSWORD = 'correct horse battery'

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
const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2f-e2e-db-'))
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
  publicHost: null,
  publicUrl: null,
  authEnabled: true,
  dbPath: path.join(dbDir, 'p2f.db')
})

let running: RunningServer = await startServer(config(), consoleLogger)
// no users pre-created — the browser drives the first-run setup screen below

const executablePath = await findChromium()
const browser = await chromium.launch({ executablePath })
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()
page.on('console', msg => {
  if (msg.type() === 'error') console.log(`  [browser] ${msg.text()}`)
})
page.on('pageerror', err => console.log(`  [browser page error] ${err.message}`))

// throttle the browser to 2 MB/s so the test can catch the download mid-flight
const cdp = await context.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 5,
  downloadThroughput: 2 * 1024 * 1024,
  uploadThroughput: 2 * 1024 * 1024
})

const downloaded = () => page.$eval(
  '#downloads li',
  el => Number((el as HTMLElement).dataset.downloaded ?? 0)
)
const progress = () => page.$eval(
  '#downloads li',
  el => Number((el as HTMLElement).dataset.progress ?? 0)
)
const state = () => page.$eval(
  '#downloads li',
  el => (el as HTMLElement).dataset.state ?? ''
)

async function waitForProgress (target: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await progress() >= target) return
    if (await state() === 'done') fail('download finished earlier than the test expected')
    await sleep(100)
  }
  fail(`download did not reach ${target * 100}% in time`)
}

try {
  // 1-2. load with no users yet, expect the first-run setup screen
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForSelector('#conn-status.ok', { timeout: 10_000 })
  await page.waitForSelector('#setup:not([hidden])', { timeout: 5_000 })
  console.log('✓ client connected, first-run setup required')

  await page.fill('#setup-user', USER)
  await page.fill('#setup-pass', PASSWORD)
  await page.fill('#setup-pass2', 'does not match')
  await page.click('#setup-form button')
  await page.waitForSelector('#setup-status.error', { timeout: 5_000 })
  console.log('✓ mismatched setup passwords rejected')

  await page.fill('#setup-pass2', PASSWORD)
  await page.click('#setup-form button')
  await page.waitForSelector('#browser:not([hidden])', { timeout: 10_000 })
  console.log('✓ admin account created via setup screen, signed in')

  // 3. log out and back in through the normal login form
  await page.click('#logout')
  await page.waitForSelector('#login:not([hidden])', { timeout: 5_000 })

  await page.fill('#login-user', USER)
  await page.fill('#login-pass', 'wrong password')
  await page.click('#login-form button')
  await page.waitForSelector('#login-status.error', { timeout: 5_000 })
  console.log('✓ wrong password rejected')

  await page.fill('#login-pass', PASSWORD)
  await page.click('#login-form button')
  await page.waitForSelector('#browser:not([hidden])', { timeout: 10_000 })
  console.log('✓ signed in')

  // 4. browse: root listing shows the folder, click into it
  await page.waitForSelector('#listing li.dir')
  await page.click('#listing li.dir')
  await page.waitForFunction(
    () => document.querySelector('#breadcrumb')?.textContent?.includes('movies') ?? false,
    undefined,
    { timeout: 10_000 }
  )
  await page.waitForSelector('#listing li.file')
  console.log('✓ folder navigation works')

  await page.click('#listing li.file button')
  await page.waitForSelector('#downloads li[data-state="downloading"]', { timeout: 60_000 })
  console.log('✓ download started')

  // 5. pause: bandwidth must actually stop
  await waitForProgress(0.1)
  await page.click('#downloads li button:has-text("Pause")')
  await page.waitForSelector('#downloads li[data-state="paused"]', { timeout: 5_000 })
  await sleep(2000) // let in-flight pieces land (generous for slow CI runners)
  const pausedAt = await downloaded()
  await sleep(2500)
  const stillPausedAt = await downloaded()
  if (stillPausedAt !== pausedAt) {
    fail(`paused download kept transferring: ${pausedAt} -> ${stillPausedAt}`)
  }
  console.log(`✓ pause stops bandwidth (held at ${(pausedAt / FILE_SIZE * 100).toFixed(0)}%)`)

  await page.click('#downloads li button:has-text("Resume")')
  await page.waitForSelector('#downloads li[data-state="downloading"]', { timeout: 15_000 })
  console.log('✓ resume works')

  // 6. simulate a network drop: full server restart on the same ports
  await waitForProgress(0.25)
  const beforeDrop = await downloaded()
  await running.close()
  await sleep(3000)
  running = await startServer(config(), consoleLogger)
  console.log(`✓ server restarted (client at ${(beforeDrop / FILE_SIZE * 100).toFixed(0)}%)`)

  await waitForProgress(0.4)
  if (await downloaded() < beforeDrop) fail('progress went backwards after the server restart')
  console.log('✓ download resumed after reconnect (no restart from zero)')

  // 7. pause, reload the page — state must survive via localStorage + OPFS
  await page.click('#downloads li button:has-text("Pause")')
  await page.waitForSelector('#downloads li[data-state="paused"]', { timeout: 5_000 })
  await sleep(800)
  const beforeReload = await progress()
  await page.reload()
  await page.waitForSelector('#browser:not([hidden])', { timeout: 15_000 }) // session cookie survives
  await page.waitForSelector('#downloads li[data-state="paused"]', { timeout: 20_000 })
  console.log('✓ page reloaded: still signed in, download restored (paused)')

  // verification of stored pieces is local — progress must come back on its own
  const verifyDeadline = Date.now() + 60_000
  let restored = 0
  while (Date.now() < verifyDeadline) {
    restored = await progress()
    if (restored >= beforeReload - 0.05) break
    await sleep(250)
  }
  if (restored < beforeReload - 0.05) {
    fail(`refresh lost progress: had ${(beforeReload * 100).toFixed(0)}%, restored ${(restored * 100).toFixed(0)}%`)
  }
  console.log(`✓ verified pieces survived the reload (${(restored * 100).toFixed(0)}% restored from OPFS)`)

  // 8. finish and checksum
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 })
  await page.click('#downloads li button:has-text("Resume")')
  const download = await downloadPromise
  await page.waitForSelector('#downloads li[data-state="done"]', { timeout: 60_000 })

  const savedFile = path.join(root, 'downloaded-payload.bin')
  await download.saveAs(savedFile)
  const savedSha = createHash('sha256').update(await fs.readFile(savedFile)).digest('hex')
  if (download.suggestedFilename() !== 'payload.bin') {
    fail(`unexpected filename: ${download.suggestedFilename()}`)
  }
  if (savedSha !== payloadSha) fail(`checksum mismatch: ${savedSha} != ${payloadSha}`)
  console.log('✓ download completed; checksum matches the source')

  console.log('\nE2E PASS')
} finally {
  await browser.close()
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(dbDir, { recursive: true, force: true })
}

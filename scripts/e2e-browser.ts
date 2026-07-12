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
// Playwright can't drive the native save-file OS dialog the File System
// Access API pops up, so force the client onto its next tier down: the
// service-worker-streamed download — no Blob ever built, which is also the
// path that actually matters for Safari (no File System Access API there at
// all). That still exercises a real `download` event Playwright can await.
await page.addInitScript(() => {
  // @ts-expect-error test-only override of a read/write-capable optional API
  delete window.showSaveFilePicker
})
page.on('console', msg => {
  if (msg.type() === 'error' || process.env.E2E_VERBOSE) console.log(`  [browser] ${msg.text()}`)
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
  // 1-2. load with no users yet, expect the first-run setup screen — the
  // client auto-detects the server (same origin), no address to type in
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForSelector('#setup:not([hidden])', { timeout: 10_000 })
  console.log('✓ client auto-connected, first-run setup required')

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

  // fixed "../" row at the top of the listing navigates back up
  await page.waitForSelector('#listing li.up')
  await page.click('#listing li.up')
  await page.waitForFunction(
    () => document.querySelector('#breadcrumb')?.textContent?.trim() === '⌂ root',
    undefined,
    { timeout: 10_000 }
  )
  await page.waitForSelector('#listing li.up', { state: 'detached', timeout: 5_000 })
  console.log('✓ "../" row navigates back up a folder')

  await page.click('#listing li.dir')
  await page.waitForSelector('#listing li.file')

  await page.click('#listing li.file button')
  await page.waitForSelector('#downloads li[data-state="downloading"]', { timeout: 60_000 })
  console.log('✓ download started')

  // details panel: info hash, elapsed time, at least one peer (the webseed —
  // no WebRTC in this environment, node-datachannel isn't installed)
  await page.click('#downloads li button:has-text("Details")')
  await page.waitForSelector('.dl-details:not([hidden])', { timeout: 5_000 })
  const infoHash = await page.getAttribute('#downloads li', 'data-infohash')
  if (!infoHash || !/^[0-9a-f]{40}$/.test(infoHash)) fail(`bad data-infohash: ${infoHash}`)
  await page.waitForFunction(
    (hash) => (document.querySelector('.dl-details')?.textContent ?? '').includes(hash),
    infoHash,
    { timeout: 5_000 }
  )
  const detailsText = await page.locator('.dl-details').innerText()
  if (!/Elapsed/.test(detailsText)) fail(`details panel missing elapsed time: ${detailsText}`)
  await page.waitForFunction(
    () => (document.querySelector('.dl-details')?.textContent ?? '').includes('webseed'),
    undefined,
    { timeout: 10_000 }
  )
  console.log('✓ details panel shows info hash, elapsed time and the webseed peer')

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
  const finishedInfoHash = await page.getAttribute('#downloads li', 'data-infohash')

  const savedFile = path.join(root, 'downloaded-payload.bin')
  await download.saveAs(savedFile)
  const savedSha = createHash('sha256').update(await fs.readFile(savedFile)).digest('hex')
  if (download.suggestedFilename() !== 'payload.bin') {
    fail(`unexpected filename: ${download.suggestedFilename()}`)
  }
  if (savedSha !== payloadSha) fail(`checksum mismatch: ${savedSha} != ${payloadSha}`)
  console.log('✓ download completed; checksum matches the source')

  // This save went through the service-worker-streamed tier (no
  // showSaveFilePicker in this test), which has no JS-visible "save
  // finished" signal — the OPFS piece store is reclaimed once every piece
  // has been read back out at least once (real completion), not on a fixed
  // timer. Regression check for the bug where a flat multi-minute timer
  // destroyed the store while a large/slow save was still streaming: this
  // must clear out well within the short post-read grace period, not stay
  // around waiting for a long fallback timer.
  const reapDeadline = Date.now() + 25_000
  let stillPresent = true
  while (Date.now() < reapDeadline) {
    const keys: string[] = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('p2f-downloads', { create: true }).catch(() => null)
      if (!dir) return []
      const names: string[] = []
      // @ts-expect-error async iteration on FileSystemDirectoryHandle
      for await (const [name] of dir) names.push(name)
      return names
    })
    if (finishedInfoHash && !keys.includes(finishedInfoHash)) { stillPresent = false; break }
    await sleep(500)
  }
  if (stillPresent) fail('completed download\'s OPFS piece store was not reaped promptly after streaming finished')
  console.log('✓ OPFS piece store reaped promptly once the streamed save actually finished')

  // 9. logs page — opened as its own tab, shares the session cookie
  const logsPage = await context.newPage()
  await logsPage.goto(`http://127.0.0.1:${PORT}/logs.html`)
  await logsPage.waitForSelector('#conn-status.ok', { timeout: 10_000 })
  await logsPage.waitForFunction(
    () => (document.querySelector('#log-list')?.textContent ?? '').includes('payload.bin'),
    undefined,
    { timeout: 10_000 }
  )
  const logsText = await logsPage.locator('#log-list').innerText()
  if (!/torrent/i.test(logsText)) fail(`logs page missing a torrent-kind entry: ${logsText}`)
  // filter by a kind guaranteed to be recent (the ring buffer only keeps the
  // latest ~500/200-per-fetch entries, so anything from early in this long
  // test — like the sign-in — may have already scrolled out, same as it
  // would for a real admin watching a busy server)
  await logsPage.selectOption('#kind-filter', 'torrent')
  await logsPage.waitForFunction(
    () => {
      const kinds = [...document.querySelectorAll('#log-list .log-kind')]
      return kinds.length > 0 && kinds.every(el => el.textContent === 'torrent')
    },
    undefined,
    { timeout: 5_000 }
  )
  console.log('✓ logs page shows server activity and filters by kind')
  await logsPage.close()

  // 10. stale-download reconciliation: a synthetic orphaned OPFS store (no
  // matching localStorage entry) and a pendingCleanup entry must both be
  // reaped the next time the app starts up, without touching the real
  // (already completed and forgotten) download from steps 1-8.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('p2f-downloads', { create: true })
    await dir.getDirectoryHandle('orphan-no-entry', { create: true })
    await dir.getDirectoryHandle('pending-cleanup-hash', { create: true })
    const saved = JSON.parse(localStorage.getItem('p2f-downloads') ?? '[]')
    saved.push({
      path: 'movies/payload.bin', name: 'payload.bin',
      infoHash: 'pending-cleanup-hash', lastActiveAt: Date.now(), pendingCleanup: true
    })
    localStorage.setItem('p2f-downloads', JSON.stringify(saved))
  })
  await page.reload()
  await page.waitForSelector('#browser:not([hidden])', { timeout: 15_000 })
  await sleep(1_000) // reconcileDownloads() runs before restoreDownloads(), give it a beat
  const leftoverKeys = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('p2f-downloads', { create: true }).catch(() => null)
    if (!dir) return []
    const keys: string[] = []
    // @ts-expect-error async iteration on FileSystemDirectoryHandle
    for await (const [name] of dir) keys.push(name)
    return keys
  })
  if (leftoverKeys.includes('orphan-no-entry') || leftoverKeys.includes('pending-cleanup-hash')) {
    fail(`stale/orphaned OPFS entries were not reaped: ${JSON.stringify(leftoverKeys)}`)
  }
  const savedList = await page.evaluate(() => localStorage.getItem('p2f-downloads'))
  if (savedList?.includes('pending-cleanup-hash')) fail('pendingCleanup entry was not dropped from localStorage')
  console.log('✓ orphaned and pending-cleanup OPFS stores are reaped on next startup')

  // 11. file management: upload, rename, move and delete
  const uploadPath = path.join(os.tmpdir(), 'p2f-e2e-upload.bin')
  const uploadPayload = crypto.randomBytes(64 * 1024)
  await fs.writeFile(uploadPath, uploadPayload)

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.browser-toolbar button:has-text("Upload")')
  ])
  await fileChooser.setFiles(uploadPath)
  await page.waitForSelector('#uploads li[data-state="done"]', { timeout: 30_000 })
  await page.waitForSelector('#listing li:has-text("p2f-e2e-upload.bin")', { timeout: 10_000 })
  console.log('✓ uploaded file appears in the listing')

  await page.click('#listing li:has-text("p2f-e2e-upload.bin") button:has-text("Rename")')
  await page.fill('.rename-input', 'e2e-renamed.bin')
  await page.keyboard.press('Enter')
  await page.waitForSelector('#listing li:has-text("e2e-renamed.bin")', { timeout: 10_000 })
  await page.waitForFunction(
    () => !(document.querySelector('#listing')?.textContent ?? '').includes('p2f-e2e-upload.bin'),
    undefined, { timeout: 5_000 }
  )
  console.log('✓ renamed a file in place')

  await page.click('#listing li:has-text("e2e-renamed.bin") button:has-text("Rename")')
  await page.fill('.rename-input', 'movies/e2e-renamed.bin')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    () => !(document.querySelector('#listing')?.textContent ?? '').includes('e2e-renamed.bin'),
    undefined, { timeout: 5_000 }
  )
  await page.click('#listing li.dir:has-text("movies")')
  await page.waitForSelector('#listing li:has-text("e2e-renamed.bin")', { timeout: 10_000 })
  console.log('✓ moved a file into a subfolder')

  page.once('dialog', dialog => { void dialog.accept() })
  await page.click('#listing li:has-text("e2e-renamed.bin") button:has-text("Delete")')
  await page.waitForFunction(
    () => !(document.querySelector('#listing')?.textContent ?? '').includes('e2e-renamed.bin'),
    undefined, { timeout: 10_000 }
  )
  console.log('✓ deleted a file (after confirmation)')
  await fs.rm(uploadPath, { force: true })

  console.log('\nE2E PASS')
} finally {
  await browser.close()
  await running.close()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(dbDir, { recursive: true, force: true })
}

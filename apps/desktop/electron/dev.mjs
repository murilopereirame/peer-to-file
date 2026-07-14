// Dev orchestrator: compiles the main/preload process once, starts the Vite
// dev server, waits for it to come up, then launches Electron pointed at it.
// A tiny hand-rolled script rather than `concurrently`/`wait-on` — the whole
// thing is ~30 lines and keeps the desktop app's dependency list free of
// dev-only orchestration packages.
import { execFileSync, spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const PORT = 1420

function waitForPort (port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) { reject(new Error(`timed out waiting for http://localhost:${port}`)); return }
        setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.electron.json'], { stdio: 'inherit' })

const vite = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:vite'], { stdio: 'inherit' })

let shuttingDown = false
function shutdown (code) {
  if (shuttingDown) return
  shuttingDown = true
  vite.kill()
  process.exit(code ?? 0)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
vite.on('exit', code => shutdown(code ?? 0))

await waitForPort(PORT)

const electron = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${PORT}` }
})
electron.on('exit', code => shutdown(code ?? 0))

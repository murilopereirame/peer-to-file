// WebTorrent's browser bundle is huge and full of Node-polyfill assumptions
// that don't play well with Vite's own bundler (this is the same reason the
// server's web client loads it as a pre-built script rather than an ESM
// import — see client/src/lib/loadWebTorrent.ts). Copy it straight from
// node_modules into public/ so Vite serves it byte-for-byte, unbundled.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// The app mark shown in the sidebar is the same PNG electron-builder packages
// as the window/desktop icon, so it is copied into public/ at build time
// rather than committed a second time under a different name.
const files = [
  ['node_modules/webtorrent/dist/webtorrent.min.js', 'public/vendor/webtorrent.min.js'],
  ['node_modules/webtorrent/dist/sw.min.js', 'public/sw.js'],
  ['icon-source.png', 'public/icon.png']
]

for (const [rel, destRel] of files) {
  const src = join(root, rel)
  const dest = join(root, destRel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`copied ${rel} -> ${destRel}`)
}

#!/usr/bin/env node
// Bumps the version across the desktop app and the shared package it
// consumes, in lockstep. Used by .github/workflows/apps-version-bump.yml —
// does not touch the original web app's root package.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const bumpType = process.argv[2]
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('usage: bump-version.mjs <patch|minor|major>')
  process.exit(1)
}

function bumpSemver (version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`not a plain semver version: ${version}`)
  let [, major, minor, patch] = match.map(Number)
  if (kind === 'major') { major++; minor = 0; patch = 0 } else if (kind === 'minor') { minor++; patch = 0 } else { patch++ }
  return `${major}.${minor}.${patch}`
}

function readJson (path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson (path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

const desktopPkgPath = join(root, 'apps/desktop/package.json')
const sharedPkgPath = join(root, 'packages/shared/package.json')

const desktopPkg = readJson(desktopPkgPath)
const newVersion = bumpSemver(desktopPkg.version, bumpType)

desktopPkg.version = newVersion
writeJson(desktopPkgPath, desktopPkg)

const sharedPkg = readJson(sharedPkgPath)
sharedPkg.version = newVersion
writeJson(sharedPkgPath, sharedPkg)

console.log(newVersion)

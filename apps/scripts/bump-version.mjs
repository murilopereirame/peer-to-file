#!/usr/bin/env node
// Bumps the version across every new-app package in lockstep (mobile,
// desktop, and the shared package they both consume) plus each platform's
// own build-number fields, which app stores/OSes require to move forward
// independently of the human-readable version string. Used by
// .github/workflows/apps-version-bump.yml — does not touch the original
// web app's root package.json.
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

const mobilePkgPath = join(root, 'apps/mobile/package.json')
const mobileAppJsonPath = join(root, 'apps/mobile/app.json')
const desktopPkgPath = join(root, 'apps/desktop/package.json')
const sharedPkgPath = join(root, 'packages/shared/package.json')

const mobilePkg = readJson(mobilePkgPath)
const newVersion = bumpSemver(mobilePkg.version, bumpType)

mobilePkg.version = newVersion
writeJson(mobilePkgPath, mobilePkg)

const mobileAppJson = readJson(mobileAppJsonPath)
mobileAppJson.expo.version = newVersion
mobileAppJson.expo.ios.buildNumber = String(Number(mobileAppJson.expo.ios.buildNumber) + 1)
mobileAppJson.expo.android.versionCode = Number(mobileAppJson.expo.android.versionCode) + 1
writeJson(mobileAppJsonPath, mobileAppJson)

const desktopPkg = readJson(desktopPkgPath)
desktopPkg.version = newVersion
writeJson(desktopPkgPath, desktopPkg)

const sharedPkg = readJson(sharedPkgPath)
sharedPkg.version = newVersion
writeJson(sharedPkgPath, sharedPkg)

console.log(newVersion)

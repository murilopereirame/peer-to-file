const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// @p2f/shared is a local `file:` dependency (see package.json), symlinked
// by npm into node_modules/@p2f/shared — standard node_modules resolution
// finds it there. It's watched too so editing the shared source live-reloads
// both apps without a publish/build step.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(workspaceRoot, 'packages/shared')]

module.exports = config

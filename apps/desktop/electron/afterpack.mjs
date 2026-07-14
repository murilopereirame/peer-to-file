/**
 * electron-builder afterPack hook.
 *
 * Deep ad-hoc code-signs the macOS app bundle when no Developer ID
 * certificate is available. electron-builder's own automatic signing only
 * covers the outer bundle, leaving nested frameworks/helpers inconsistently
 * signed — that mismatch, not just "unsigned", is what makes Gatekeeper
 * show the harsh "app is damaged and should be moved to the Trash" dialog
 * with no way to open it. A full `--deep` ad-hoc signature makes the whole
 * bundle internally consistent, which resolves that specific dialog.
 *
 * This does NOT satisfy Apple notarization — a quarantined (freshly
 * downloaded) copy still gets the milder "unidentified developer" Gatekeeper
 * prompt, bypassed via right-click → Open (or `xattr -cr`), same as any
 * unsigned/ad-hoc-signed app. See apps/README.md, "Opening the macOS build".
 */

import { execSync } from 'node:child_process'
import path from 'node:path'

/** @param {import('electron-builder').AfterPackContext} context */
export default async function afterPack (context) {
  if (context.electronPlatformName !== 'darwin') return

  const productName = context.packager.appInfo.productName
  const appBundle = path.join(context.appOutDir, `${productName}.app`)

  console.log(`[afterPack] Deep ad-hoc signing: ${appBundle}`)
  execSync(`codesign --deep --force --sign - "${appBundle}"`, { stdio: 'inherit' })
}

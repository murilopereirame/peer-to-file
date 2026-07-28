import { safeStorage } from 'electron'
import { JsonStore } from './store.cjs'

export interface StoredCredentials {
  username: string
  /** A long-lived refresh token (F9), not the password — the raw password is
   *  never persisted. Used to silently mint a fresh session on next launch. */
  refreshToken: string
}

// One JSON entry per server URL, so switching servers doesn't clobber a
// previously saved login — mirrors the previous Tauri build's one-keyring-
// entry-per-server-URL scheme, but the payload itself is encrypted with
// Electron's `safeStorage` (Keychain / DPAPI / libsecret under the hood,
// same OS-level backing the `keyring` crate used) before it ever touches
// disk, rather than being one more plaintext field in the settings file.
const credentialsStore = new JsonStore('credentials.json')

export function saveCredentials (server: string, username: string, refreshToken: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is unavailable on this machine')
  }
  const encrypted = safeStorage.encryptString(JSON.stringify({ username, refreshToken }))
  credentialsStore.set(server, encrypted.toString('base64'))
}

export function loadCredentials (server: string): StoredCredentials | null {
  const stored = credentialsStore.get<string>(server)
  if (!stored) return null
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(stored, 'base64'))
    return JSON.parse(decrypted) as StoredCredentials
  } catch {
    return null
  }
}

export function clearCredentials (server: string): void {
  credentialsStore.delete(server)
}

import * as SecureStore from 'expo-secure-store'

// Everything the app needs to remember lives in the OS keychain (iOS
// Keychain Services / Android Keystore-backed EncryptedSharedPreferences
// via expo-secure-store) — not just the password. It's all small strings
// well under SecureStore's ~2KB-per-key limit, and keeping it in one place
// means "log out" and "switch server" both have one obvious thing to clear.
const KEYS = {
  serverUrl: 'p2f.serverUrl',
  username: 'p2f.username',
  password: 'p2f.password',
  downloadDirUri: 'p2f.downloadDirUri',
  themeOverride: 'p2f.themeOverride'
} as const

async function get (key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key)
}

async function set (key: string, value: string | null): Promise<void> {
  if (value === null) {
    await SecureStore.deleteItemAsync(key)
  } else {
    await SecureStore.setItemAsync(key, value)
  }
}

export const storage = {
  getServerUrl: () => get(KEYS.serverUrl),
  setServerUrl: (v: string | null) => set(KEYS.serverUrl, v),

  getCredentials: async (): Promise<{ username: string, password: string } | null> => {
    const [username, password] = await Promise.all([get(KEYS.username), get(KEYS.password)])
    if (!username || !password) return null
    return { username, password }
  },
  setCredentials: async (username: string, password: string): Promise<void> => {
    await Promise.all([set(KEYS.username, username), set(KEYS.password, password)])
  },
  clearCredentials: async (): Promise<void> => {
    await Promise.all([set(KEYS.username, null), set(KEYS.password, null)])
  },

  getDownloadDirUri: () => get(KEYS.downloadDirUri),
  setDownloadDirUri: (v: string | null) => set(KEYS.downloadDirUri, v),

  getThemeOverride: () => get(KEYS.themeOverride) as Promise<'light' | 'dark' | null>,
  setThemeOverride: (v: 'light' | 'dark' | null) => set(KEYS.themeOverride, v),

  /** Full app "sign out and forget this server" reset. */
  clearAll: async (): Promise<void> => {
    await Promise.all(Object.values(KEYS).map(k => set(k, null)))
  }
}

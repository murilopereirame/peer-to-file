import type { Config } from '../src/server/config.ts'

/**
 * Builds a server Config for tests with sensible defaults, so individual tests
 * only specify what they care about (root, cacheDir, dbPath, publicUrl, ...).
 * Auth is always on now; there is no toggle.
 */
export function testConfig (overrides: Partial<Config> & Pick<Config, 'root' | 'cacheDir'>): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    trackerPort: 0,
    publicHost: null,
    publicUrl: null,
    dbPath: ':memory:',
    cacheMaxBytes: 0,
    secureCookies: 'off',
    trustProxy: false,
    ...overrides
  }
}

/** Log in and return the pieces a test needs: the access cookie + a CSRF header. */
export async function loginCookie (base: string, username: string, password: string): Promise<{ cookie: string, headers: Record<string, string> }> {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  return { cookie, headers: { Cookie: cookie, 'X-P2F-Csrf': '1' } }
}

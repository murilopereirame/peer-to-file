import { P2FClient, normalizeServerUrl } from '@p2f/shared'

/**
 * React Native's `fetch` is backed by native networking (NSURLSession on
 * iOS, OkHttp on Android), not a browser engine — it doesn't enforce CORS
 * and its cookie handling is a plain persistent per-host jar, so the
 * server's session cookie (set on /api/login) is captured and resent
 * automatically without us reading `Set-Cookie` ourselves (RN's fetch
 * follows the Fetch spec and hides that header from JS, same as a browser).
 */
export function createClient (serverUrl: string): P2FClient {
  return new P2FClient({ baseUrl: normalizeServerUrl(serverUrl), fetchImpl: fetch })
}

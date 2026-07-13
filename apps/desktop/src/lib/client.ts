import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { P2FClient, normalizeServerUrl } from '@p2f/shared'

/**
 * The webview's own `fetch` enforces real browser CORS — and the server
 * sends `Access-Control-Allow-Origin: *`, which per spec blocks *credentialed*
 * (cookie-carrying) cross-origin requests outright. Since the app's origin
 * (tauri://localhost / http://tauri.localhost) is never the same as the
 * user-entered server URL, plain `window.fetch` can't hold a session here.
 *
 * `@tauri-apps/plugin-http` routes requests through a Rust `reqwest` client
 * instead of the webview's networking stack, so none of that applies: no
 * CORS enforcement, and it keeps its own cookie jar for the life of the app
 * process (session persists across API calls, but not across app restarts —
 * hence the explicit keychain-backed auto-login in AppContext).
 */
export function createClient (serverUrl: string): P2FClient {
  return new P2FClient({ baseUrl: normalizeServerUrl(serverUrl), fetchImpl: tauriFetch })
}

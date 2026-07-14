import { P2FClient, normalizeServerUrl, type FetchLike } from '@p2f/shared'

/**
 * The renderer's own `fetch` enforces real browser CORS — and the server
 * sends `Access-Control-Allow-Origin: *`, which per spec blocks *credentialed*
 * (cookie-carrying) cross-origin requests outright. Since the app's origin
 * (the custom `p2file://` scheme, see electron/main.cts) is never the same
 * as the user-entered server URL, plain `window.fetch` can't hold a session
 * here.
 *
 * `ipcFetch` instead routes every request through the main process (see
 * electron/netFetch.cts), which runs Node's own `fetch` with its own
 * in-memory cookie jar — no CORS enforcement applies there, and the jar
 * persists for the life of the app process (but not across restarts, hence
 * the explicit keychain-backed auto-login in AppContext).
 */
export const ipcFetch: FetchLike = async (url, init) => {
  const headers: Record<string, string> = {}
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => { headers[key] = value })
  }

  let body: ArrayBuffer | string | undefined
  if (init?.body instanceof ArrayBuffer) body = init.body
  else if (typeof init?.body === 'string') body = init.body
  else if (init?.body) body = await new Response(init.body as BodyInit).arrayBuffer()

  const result = await window.p2f.fetch({ url, method: init?.method ?? 'GET', headers, body })
  if ('networkError' in result) throw new Error(result.networkError)
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers })
}

export function createClient (serverUrl: string): P2FClient {
  return new P2FClient({ baseUrl: normalizeServerUrl(serverUrl), fetchImpl: ipcFetch })
}

// Runs `fetch` in the main process (Node's own `fetch`/undici) instead of
// the renderer's — same reasoning as the previous Tauri build routing
// through `@tauri-apps/plugin-http`: the server sends
// `Access-Control-Allow-Origin: *`, which per spec blocks *credentialed*
// (cookie-carrying) cross-origin requests outright, and the renderer's
// origin (this app's custom `p2file://` scheme) is never the same as the
// user-entered server URL. A main-process fetch isn't a browser navigation
// context at all, so no CORS enforcement applies — it just needs its own
// cookie jar (Node's fetch keeps none by default) to stand in for the
// session cookie a real browser would hold automatically.

export interface FetchRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: ArrayBuffer | string
  /** Set to stream the body instead of handing it over in one piece, so the
   *  renderer can be told how much of it has gone out (uploads have no other
   *  progress signal here — see the `onProgress` parameter of performFetch). */
  progressId?: string
}

export interface FetchSuccess {
  status: number
  statusText: string
  ok: boolean
  headers: Array<[string, string]>
  body: ArrayBuffer
}

export interface FetchFailure {
  networkError: string
}

export type FetchResult = FetchSuccess | FetchFailure

// origin -> cookie name -> value. Deliberately coarse (no Path/Domain/
// Expires accounting): every request in this app goes to exactly one
// server origin at a time, so per-origin is all the precision that matters.
const cookieJar = new Map<string, Map<string, string>>()

function cookieHeaderFor (origin: string): string | undefined {
  const jar = cookieJar.get(origin)
  if (!jar || jar.size === 0) return undefined
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

function absorbSetCookie (origin: string, headers: Headers): void {
  const setCookies = headers.getSetCookie()
  if (setCookies.length === 0) return
  let jar = cookieJar.get(origin)
  if (!jar) { jar = new Map(); cookieJar.set(origin, jar) }
  for (const raw of setCookies) {
    const [pair, ...attrs] = raw.split(';')
    const eq = pair!.indexOf('=')
    if (eq === -1) continue
    const name = pair!.slice(0, eq).trim()
    const value = pair!.slice(eq + 1).trim()
    const expired = attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) ||
      attrs.some(a => /^\s*expires=/i.test(a) && new Date(a.split('=')[1] ?? '').getTime() < Date.now())
    if (expired) jar.delete(name); else jar.set(name, value)
  }
}

export function clearCookiesForOrigin (origin: string): void {
  cookieJar.delete(origin)
}

/** Read a single cookie value from the in-memory jar (e.g. the refresh token). */
export function getCookie (origin: string, name: string): string | undefined {
  return cookieJar.get(origin)?.get(name)
}

/** Seed a cookie into the jar (e.g. a persisted refresh token restored on launch). */
export function setCookie (origin: string, name: string, value: string): void {
  let jar = cookieJar.get(origin)
  if (!jar) { jar = new Map(); cookieJar.set(origin, jar) }
  jar.set(name, value)
}

/** How much of the body is handed to the socket at a time. Small enough that
 *  progress ticks read as a live rate, large enough not to add measurable
 *  overhead to a multi-gigabyte upload. */
const UPLOAD_CHUNK_BYTES = 256 * 1024

/**
 * Feeds `buffer` out in chunks, reporting how many bytes have been taken.
 *
 * This is the only upload progress signal the desktop client can have: its
 * requests are made here in the main process (see the header comment), and
 * Node's `fetch` — unlike the browser's XHR the web client uses — exposes no
 * upload progress events. Backpressure is what makes the number meaningful:
 * `pull` is only called again once the previous chunk has been written out,
 * so the rate derived from it tracks the socket rather than the loop.
 */
function progressStream (
  buffer: ArrayBuffer, onProgress: (sent: number, total: number) => void
): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(buffer)
  const total = bytes.byteLength
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull (controller) {
      if (sent >= total) { controller.close(); return }
      const end = Math.min(sent + UPLOAD_CHUNK_BYTES, total)
      controller.enqueue(bytes.subarray(sent, end))
      sent = end
      onProgress(sent, total)
    }
  })
}

export async function performFetch (
  req: FetchRequest, onProgress?: (sent: number, total: number) => void
): Promise<FetchResult> {
  const origin = new URL(req.url).origin
  const headers = new Headers(req.headers ?? {})
  const cookie = cookieHeaderFor(origin)
  if (cookie) headers.set('Cookie', cookie)

  // A streamed body goes out chunked (the /api/upload handler pipes the
  // request straight into the decipher and never reads Content-Length), so
  // nothing else has to change to get progress out of it.
  let requestBody: BodyInit | undefined = req.body
  let duplex: 'half' | undefined
  if (onProgress && req.body instanceof ArrayBuffer && req.body.byteLength > 0) {
    requestBody = progressStream(req.body, onProgress)
    duplex = 'half'
  }

  let res: Response
  try {
    res = await fetch(req.url, { method: req.method ?? 'GET', headers, body: requestBody, duplex } as RequestInit)
  } catch (err) {
    return { networkError: err instanceof Error ? err.message : String(err) }
  }

  absorbSetCookie(origin, res.headers)
  const body = await res.arrayBuffer()
  const headerPairs: Array<[string, string]> = []
  res.headers.forEach((value, key) => { if (key.toLowerCase() !== 'set-cookie') headerPairs.push([key, value]) })

  return { status: res.status, statusText: res.statusText, ok: res.ok, headers: headerPairs, body }
}

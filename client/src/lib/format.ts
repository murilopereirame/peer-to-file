export function errMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class HttpError extends Error {
  readonly status: number
  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function formatBytes (n: number): string {
  if (!Number.isFinite(n)) return '?'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = n
  let u = 0
  while (value >= 1024 && u < units.length - 1) { value /= 1024; u++ }
  return `${u === 0 ? value : value.toFixed(1)} ${units[u]}`
}

export function formatDuration (ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function normalizeServer (input: string): string {
  let addr = input.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(addr)) {
    // Default to the page's own scheme: on an https page (e.g. behind an
    // nginx TLS proxy) a http:// API call would be blocked as mixed content.
    const scheme = location.protocol === 'https:' ? 'https' : 'http'
    addr = `${scheme}://${addr}`
  }
  return addr
}

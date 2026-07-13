const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes (bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${UNITS[unit]}`
}

export function formatDuration (ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatDateTime (ms: number): string {
  return new Date(ms).toLocaleString()
}

export function errMessage (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Splits a `/`-joined relative path into breadcrumb segments. */
export function pathSegments (path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function joinPath (...segments: string[]): string {
  return segments.filter(Boolean).join('/').replace(/\/+/g, '/')
}

export function parentPath (path: string): string {
  const segs = pathSegments(path)
  segs.pop()
  return segs.join('/')
}

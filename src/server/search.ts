import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside } from './browse.ts'

export interface SearchHit {
  /** Path relative to the mount root, matching browse.ts's Listing.path convention. */
  path: string
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
}

export interface SearchOptions {
  /** Case-insensitive substring matched against each entry's name. */
  query: string
  /** Restrict results to this type only; both when omitted. */
  type?: 'dir' | 'file'
  /** Max hits to return. */
  limit?: number
  /** Safety valve so a pathologically large tree can't tie up the request
   *  forever — once this many entries have been examined, the search stops
   *  and reports itself truncated even if the hit limit wasn't reached. */
  maxScanned?: number
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** True when the walk stopped early (hit the result limit or the scan
   *  budget) rather than exhausting the whole tree — the result set may be
   *  incomplete. */
  truncated: boolean
}

export const DEFAULT_SEARCH_LIMIT = 200
export const MAX_SEARCH_LIMIT = 1000
const DEFAULT_MAX_SCANNED = 200_000

export function clampSearchLimit (limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), MAX_SEARCH_LIMIT)
}

/**
 * Recursively searches a directory tree (rooted at `root`, starting from
 * `scopeAbs`, both already resolved/validated by browse.ts) for entries whose
 * name contains `query`. Mirrors listDir's symlink handling: a symlink is
 * only followed when it resolves back inside `root`, and broken symlinks or
 * entries that vanish mid-walk are skipped rather than failing the search.
 *
 * Depth-first and sequential — simple to reason about and plenty fast for a
 * self-hosted tool's directory sizes; `maxScanned` bounds the worst case on
 * a huge tree instead of adding walk concurrency.
 */
export async function searchTree (root: string, scopeAbs: string, opts: SearchOptions): Promise<SearchOutcome> {
  const needle = opts.query.trim().toLowerCase()
  const limit = clampSearchLimit(opts.limit)
  const maxScanned = opts.maxScanned ?? DEFAULT_MAX_SCANNED

  const hits: SearchHit[] = []
  let scanned = 0
  let truncated = false

  async function walk (dirAbs: string): Promise<void> {
    let dirents
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return // vanished or unreadable mid-walk — skip it
    }

    for (const dirent of dirents) {
      if (truncated) return
      scanned++
      if (scanned > maxScanned) {
        truncated = true
        return
      }

      const entryAbs = path.join(dirAbs, dirent.name)
      let isDir = dirent.isDirectory()
      try {
        if (dirent.isSymbolicLink()) {
          const real = await fs.realpath(entryAbs)
          if (!isInside(root, real)) continue
          const st = await fs.stat(entryAbs)
          isDir = st.isDirectory()
          if (!isDir && !st.isFile()) continue
        } else if (!isDir && !dirent.isFile()) {
          continue // socket, device, etc. — not something a listing shows either
        }
      } catch {
        continue // broken symlink or entry vanished
      }

      if ((opts.type === undefined || opts.type === (isDir ? 'dir' : 'file')) &&
          dirent.name.toLowerCase().includes(needle)) {
        try {
          const st = await fs.stat(entryAbs)
          hits.push({
            path: path.relative(root, entryAbs),
            name: dirent.name,
            type: isDir ? 'dir' : 'file',
            size: isDir ? null : st.size,
            mtime: st.mtimeMs
          })
        } catch {
          continue // vanished between the check above and this stat
        }
        if (hits.length >= limit) {
          truncated = true
          return
        }
      }

      if (isDir) await walk(entryAbs)
      if (truncated) return
    }
  }

  await walk(scopeAbs)
  return { hits, truncated }
}

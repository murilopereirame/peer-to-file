import fs from 'node:fs/promises'
import path from 'node:path'

export class BrowseError extends Error {
  readonly status: number

  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
}

export interface Listing {
  path: string
  entries: DirEntry[]
}

function isInside (root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/**
 * Resolve a client-supplied relative path to an absolute path that is
 * guaranteed to live inside `root`. `root` must already be an absolute,
 * symlink-resolved (realpath) directory.
 *
 * Rejects `..` escapes, absolute paths and symlinks that point outside the
 * root. Throws BrowseError(404) if the path does not exist.
 */
export async function resolveInsideRoot (root: string, relPath: unknown = ''): Promise<string> {
  if (typeof relPath !== 'string') {
    throw new BrowseError(400, 'path must be a string')
  }
  if (relPath.includes('\0')) {
    throw new BrowseError(400, 'invalid path')
  }
  // An absolute path would win over `root` in path.resolve — strip leading
  // slashes so the input is always treated as relative to the root.
  const relative = relPath.replace(/^[/\\]+/, '')
  const abs = path.resolve(root, relative)
  if (!isInside(root, abs)) {
    throw new BrowseError(403, 'path escapes the shared root')
  }

  let real: string
  try {
    real = await fs.realpath(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new BrowseError(404, 'no such file or directory')
    }
    throw err
  }
  if (!isInside(root, real)) {
    throw new BrowseError(403, 'path escapes the shared root')
  }
  return real
}

/**
 * List a directory inside the root. Symlinks pointing outside the root,
 * broken symlinks and special files (sockets, devices, ...) are omitted.
 */
export async function listDir (root: string, relPath: unknown = ''): Promise<Listing> {
  const abs = await resolveInsideRoot(root, relPath)
  const stat = await fs.stat(abs)
  if (!stat.isDirectory()) {
    throw new BrowseError(400, 'not a directory')
  }

  const dirents = await fs.readdir(abs, { withFileTypes: true })
  const entries: DirEntry[] = []
  for (const dirent of dirents) {
    const entryPath = path.join(abs, dirent.name)
    try {
      if (dirent.isSymbolicLink()) {
        const real = await fs.realpath(entryPath)
        if (!isInside(root, real)) continue
      }
      const st = await fs.stat(entryPath)
      if (st.isDirectory()) {
        entries.push({ name: dirent.name, type: 'dir', size: null, mtime: st.mtimeMs })
      } else if (st.isFile()) {
        entries.push({ name: dirent.name, type: 'file', size: st.size, mtime: st.mtimeMs })
      }
    } catch {
      // broken symlink or file vanished mid-listing — skip it
    }
  }

  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)
  )

  return { path: path.relative(root, abs), entries }
}

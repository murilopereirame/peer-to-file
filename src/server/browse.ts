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

export function isInside (root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/** A single path segment: no separators, no `.`/`..`, no null bytes. */
export function isValidEntryName (name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' &&
    !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

async function mapLimit<T, R> (
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
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

function splitParentAndName (relPath: unknown): { parentRel: string, name: string } {
  if (typeof relPath !== 'string') {
    throw new BrowseError(400, 'path must be a string')
  }
  if (relPath.includes('\0')) {
    throw new BrowseError(400, 'invalid path')
  }
  const trimmed = relPath.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '')
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return {
    parentRel: lastSep === -1 ? '' : trimmed.slice(0, lastSep),
    name: lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1)
  }
}

/** Shared by resolveNewPathInsideRoot and resolveUploadTarget: validate an already-split parent+name pair. */
async function resolveDestination (root: string, parentRel: unknown, name: string): Promise<string> {
  if (!isValidEntryName(name)) {
    throw new BrowseError(400, 'invalid file name')
  }
  const parentAbs = await resolveInsideRoot(root, parentRel)
  const stat = await fs.stat(parentAbs)
  if (!stat.isDirectory()) {
    throw new BrowseError(400, 'destination folder does not exist')
  }
  return path.join(parentAbs, name)
}

/**
 * Resolve a client-supplied relative path for a target that does not exist
 * yet (a move/rename destination): the parent directory must already exist
 * inside the root, and the final path segment must be a plain name with no
 * separators or traversal tricks. Unlike resolveInsideRoot, this never
 * touches the target itself (it may not exist), only its parent.
 */
export async function resolveNewPathInsideRoot (root: string, relPath: unknown): Promise<string> {
  const { parentRel, name } = splitParentAndName(relPath)
  return resolveDestination(root, parentRel, name)
}

/**
 * Same idea as resolveNewPathInsideRoot, but for an upload's destination
 * folder and file name, which arrive as two already-separate query
 * parameters rather than one combined path — concatenating them into a
 * single string just to re-split it would misparse an empty name (e.g.
 * `path=sub&name=` naively becomes "sub/", which trims to "sub" and reads
 * as a file named "sub" in the root instead of an invalid name inside sub/).
 */
export async function resolveUploadTarget (root: string, destDirRel: unknown, name: unknown): Promise<string> {
  if (typeof name !== 'string') {
    throw new BrowseError(400, 'invalid file name')
  }
  return resolveDestination(root, destDirRel, name)
}

/**
 * Resolve a client-supplied relative path to an *existing* entry inside root
 * without following a symlink at the final path segment. The containing
 * directory is still validated the normal way (symlinked intermediate
 * directories are fine — that's how browsing into them already works), but
 * the leaf itself is left exactly as found. This matters for mutations:
 * deleting or moving a symlink must act on the link, not silently follow it
 * and act on whatever it points to (which resolveInsideRoot's realpath
 * would otherwise resolve to).
 */
async function resolveEntryInsideRoot (root: string, relPath: unknown): Promise<string> {
  const { parentRel, name } = splitParentAndName(relPath)
  if (name === '') return resolveInsideRoot(root, parentRel) // '' (or an all-".." path) means the root itself
  if (!isValidEntryName(name)) {
    throw new BrowseError(400, 'invalid file name')
  }
  const parentAbs = await resolveInsideRoot(root, parentRel)
  const abs = path.join(parentAbs, name)
  try {
    await fs.lstat(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new BrowseError(404, 'no such file or directory')
    }
    throw err
  }
  return abs
}

/** Rethrows filesystem permission errors as a clean 403; anything else passes through unchanged. */
export function throwIfPermissionError (err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
    throw new BrowseError(403, 'permission denied — the shared directory is not writable')
  }
  throw err
}

/** Deletes a file, directory (recursively) or symlink (just the link) inside the root. */
export async function deleteEntry (root: string, relPath: unknown): Promise<{ abs: string, rel: string, wasDir: boolean }> {
  const abs = await resolveEntryInsideRoot(root, relPath)
  if (abs === root) {
    throw new BrowseError(400, 'cannot delete the shared root')
  }
  const st = await fs.lstat(abs)
  try {
    await fs.rm(abs, { recursive: true, force: false })
  } catch (err) {
    throwIfPermissionError(err)
  }
  return { abs, rel: path.relative(root, abs), wasDir: st.isDirectory() }
}

/**
 * Moves (or renames) a file, directory or symlink inside the root. Refuses
 * to overwrite an existing entry — though, like a plain `mv`, that check
 * and the rename itself are not one atomic step, so a concurrent request
 * racing for the exact same destination path could still overwrite it; on a
 * single-admin tool that's an acceptable, narrow window.
 */
export async function moveEntry (
  root: string, fromRelPath: unknown, toRelPath: unknown
): Promise<{ fromAbs: string, fromRel: string, toAbs: string, toRel: string }> {
  const fromAbs = await resolveEntryInsideRoot(root, fromRelPath)
  if (fromAbs === root) {
    throw new BrowseError(400, 'cannot move the shared root')
  }
  const toAbs = await resolveNewPathInsideRoot(root, toRelPath)
  if (isInside(fromAbs, toAbs)) {
    throw new BrowseError(400, 'cannot move a folder into itself')
  }
  const exists = await fs.lstat(toAbs).then(() => true, () => false)
  if (exists) {
    throw new BrowseError(409, 'a file or folder already exists at the destination')
  }
  try {
    await fs.rename(fromAbs, toAbs)
  } catch (err) {
    throwIfPermissionError(err)
  }
  return { fromAbs, fromRel: path.relative(root, fromAbs), toAbs, toRel: path.relative(root, toAbs) }
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

  // Stat entries concurrently (bounded) — sequential stats made large
  // directories noticeably slow to open, especially on network filesystems.
  const results = await mapLimit(dirents, 64, async (dirent): Promise<DirEntry | null> => {
    const entryPath = path.join(abs, dirent.name)
    try {
      if (dirent.isSymbolicLink()) {
        const real = await fs.realpath(entryPath)
        if (!isInside(root, real)) return null
      }
      const st = await fs.stat(entryPath)
      if (st.isDirectory()) {
        return { name: dirent.name, type: 'dir', size: null, mtime: st.mtimeMs }
      }
      if (st.isFile()) {
        return { name: dirent.name, type: 'file', size: st.size, mtime: st.mtimeMs }
      }
      return null
    } catch {
      // broken symlink or file vanished mid-listing — skip it
      return null
    }
  })
  const entries = results.filter((e): e is DirEntry => e !== null)

  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)
  )

  return { path: path.relative(root, abs), entries }
}

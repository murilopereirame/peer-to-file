import { mkdir, open, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/**
 * On-disk piece cache for in-progress downloads, in a folder the user can
 * choose (Settings → "Download cache folder"). The renderer's FsChunkStore
 * (src/lib/fsChunkStore.ts) forwards every WebTorrent chunk-store call here
 * over IPC, since only the main process has real filesystem access.
 *
 * Layout: <dir>/p2f-parts/<infoHash>/<pieceIndex>. Everything lives under the
 * `p2f-parts` subfolder so pointing the cache at an existing folder never
 * mixes our files with the user's, and so cleanup never touches anything else.
 */

const SUBDIR = 'p2f-parts'
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/

function keyDir (dir: string, key: string): string {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('cache folder must be an absolute path')
  if (!KEY_RE.test(key)) throw new Error('invalid cache key')
  return join(dir, SUBDIR, key)
}

function piecePath (dir: string, key: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error('invalid piece index')
  return join(keyDir(dir, key), String(index))
}

// Serializes operations on the same piece file, so a read can never observe
// a half-written piece and two writes can never interleave — the same
// guarantee the OPFS store gets from its exclusive sync access handles.
const locks = new Map<string, Promise<unknown>>()
function withLock<T> (path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(path, next)
  void next.finally(() => { if (locks.get(path) === next) locks.delete(path) }).catch(() => {})
  return next
}

export async function putPiece (dir: string, key: string, index: number, buf: Uint8Array): Promise<void> {
  const path = piecePath(dir, key, index)
  await withLock(path, async () => {
    await mkdir(keyDir(dir, key), { recursive: true })
    // flush: fsync before resolving, so a piece WebTorrent believes is
    // stored survives a crash or power loss and is valid to resume from.
    await writeFile(path, buf, { flush: true })
  })
}

export async function getPiece (
  dir: string, key: string, index: number, offset: number, length: number | undefined, expectedLength: number
): Promise<Uint8Array> {
  const path = piecePath(dir, key, index)
  return await withLock(path, async () => {
    const fh = await open(path, 'r')
    try {
      const { size } = await fh.stat()
      if (size !== expectedLength) throw new Error(`chunk ${index} is incomplete`)
      const end = length !== undefined ? offset + length : size
      const out = new Uint8Array(end - offset)
      await fh.read(out, 0, out.byteLength, offset)
      return out
    } finally {
      await fh.close()
    }
  })
}

/** Deletes pieces [fromIndex, toIndex) — frees space as the finished file is
 * assembled (see the drain logic in FsChunkStore). */
export async function removePieces (dir: string, key: string, fromIndex: number, toIndex: number): Promise<void> {
  for (let i = fromIndex; i < toIndex; i++) {
    const path = piecePath(dir, key, i)
    await withLock(path, async () => { await unlink(path).catch(() => {}) })
  }
}

export async function removeKey (dir: string, key: string): Promise<void> {
  await rm(keyDir(dir, key), { recursive: true, force: true })
}

export async function listKeys (dir: string): Promise<string[]> {
  if (typeof dir !== 'string' || !isAbsolute(dir)) return []
  try {
    const entries = await readdir(join(dir, SUBDIR), { withFileTypes: true })
    return entries.filter(e => e.isDirectory() && KEY_RE.test(e.name)).map(e => e.name)
  } catch {
    return []
  }
}

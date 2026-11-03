import { createCipheriv, createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'

/**
 * Repairs a saved download in place, re-fetching only the pieces that are
 * wrong.
 *
 * The torrent's piece hashes cover the AES-256-CTR *ciphertext*, and the saved
 * file is the plaintext. CTR is length-preserving and seekable, so each piece
 * of the saved file can be re-encrypted on its own and hashed against the
 * torrent. That finds exactly which pieces are missing or damaged. Those
 * pieces alone are then fetched from the server's webseed with HTTP Range
 * requests (the same ciphertext the swarm carries), checked against their
 * hash, decrypted, and written back at their offset.
 */

export interface TorrentLayout {
  pieceLength: number
  length: number
  /** SHA-1 of each piece's ciphertext, hex. */
  pieceHashes: string[]
}

export interface RepairRequest {
  filePath: string
  /** The raw .torrent file. */
  torrent: Uint8Array
  /** AES-256-CTR key (32 bytes) and base IV (16 bytes). */
  key: Uint8Array
  iv: Uint8Array
  /** Webseed URL (/api/raw with a transfer token) serving the ciphertext. */
  webseed: string
}

export interface RepairResult {
  pieces: number
  /** Indices of the pieces that were missing or damaged (and re-fetched). */
  damaged: number[]
}

export type RepairPhase = 'verifying' | 'downloading'
export type RepairProgress = (phase: RepairPhase, done: number, total: number) => void
export type FetchRange = (start: number, end: number, signal: AbortSignal) => Promise<Uint8Array>

// --- .torrent parsing --------------------------------------------------------

type BValue = number | Uint8Array | BValue[] | Map<string, BValue>

function decodeBencode (buf: Uint8Array): BValue {
  let pos = 0
  const text = (from: number, to: number): string => Buffer.from(buf.subarray(from, to)).toString('latin1')
  const readUntil = (ch: number): string => {
    const end = buf.indexOf(ch, pos)
    if (end === -1) throw new Error('malformed torrent')
    const s = text(pos, end)
    pos = end + 1
    return s
  }
  const next = (): BValue => {
    const c = buf[pos]
    if (c === 0x69) { // i<n>e
      pos++
      const n = Number(readUntil(0x65))
      if (!Number.isSafeInteger(n)) throw new Error('malformed torrent')
      return n
    }
    if (c === 0x6c) { // l...e
      pos++
      const list: BValue[] = []
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) throw new Error('malformed torrent')
        list.push(next())
      }
      pos++
      return list
    }
    if (c === 0x64) { // d...e
      pos++
      const dict = new Map<string, BValue>()
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) throw new Error('malformed torrent')
        const k = next()
        if (!(k instanceof Uint8Array)) throw new Error('malformed torrent')
        dict.set(Buffer.from(k).toString('utf8'), next())
      }
      pos++
      return dict
    }
    if (c !== undefined && c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const len = Number(readUntil(0x3a))
      if (!Number.isSafeInteger(len) || pos + len > buf.length) throw new Error('malformed torrent')
      const out = buf.subarray(pos, pos + len)
      pos += len
      return out
    }
    throw new Error('malformed torrent')
  }
  return next()
}

export function parseTorrentLayout (torrent: Uint8Array): TorrentLayout {
  const root = decodeBencode(torrent)
  const info = root instanceof Map ? root.get('info') : undefined
  if (!(info instanceof Map)) throw new Error('torrent has no info dictionary')
  if (info.has('files')) throw new Error('multi-file torrents are not supported')
  const pieceLength = info.get('piece length')
  const length = info.get('length')
  const pieces = info.get('pieces')
  if (typeof pieceLength !== 'number' || pieceLength <= 0 || typeof length !== 'number' || length < 0 ||
    !(pieces instanceof Uint8Array) || pieces.length % 20 !== 0) {
    throw new Error('malformed torrent')
  }
  const pieceHashes: string[] = []
  for (let i = 0; i < pieces.length; i += 20) pieceHashes.push(Buffer.from(pieces.subarray(i, i + 20)).toString('hex'))
  if (pieceHashes.length !== Math.ceil(length / pieceLength)) throw new Error('torrent piece count does not match its length')
  return { pieceLength, length, pieceHashes }
}

// --- AES-256-CTR at an arbitrary offset --------------------------------------

/** Base IV + `blocks`, as a 128-bit big-endian counter (what Node's CTR does). */
function counterAt (iv: Uint8Array, blocks: number): Buffer {
  const out = Buffer.from(iv)
  let carry = BigInt(blocks)
  for (let i = 15; i >= 0 && carry > 0n; i--) {
    const sum = BigInt(out[i]!) + (carry & 0xffn)
    out[i] = Number(sum & 0xffn)
    carry = (carry >> 8n) + (sum >> 8n)
  }
  return out
}

/** Encrypts or decrypts (same operation) `data` sitting at byte `offset` of the file. */
export function ctrXorAt (data: Uint8Array, offset: number, key: Uint8Array, iv: Uint8Array): Buffer {
  const skip = offset % 16
  const cipher = createCipheriv('aes-256-ctr', key, counterAt(iv, Math.floor(offset / 16)))
  if (skip) cipher.update(Buffer.alloc(skip))
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function sha1Hex (data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex')
}

function pieceRange (layout: TorrentLayout, index: number): { start: number, size: number } {
  const start = index * layout.pieceLength
  return { start, size: Math.min(layout.pieceLength, layout.length - start) }
}

// --- verify + repair -----------------------------------------------------------

/** Indices of pieces of the saved (plaintext) file at `filePath` that don't
 * match the torrent. A missing file has every piece missing. */
export async function findDamagedPieces (
  filePath: string, layout: TorrentLayout, key: Uint8Array, iv: Uint8Array,
  onProgress: RepairProgress = () => {}, signal?: AbortSignal
): Promise<number[]> {
  const total = layout.pieceHashes.length
  let fh: FileHandle
  try {
    fh = await open(filePath, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return layout.pieceHashes.map((_h, i) => i)
    throw err
  }
  const damaged: number[] = []
  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(layout.pieceLength)
    for (let i = 0; i < total; i++) {
      signal?.throwIfAborted()
      const { start, size: pieceSize } = pieceRange(layout, i)
      if (start + pieceSize > size) {
        damaged.push(i)
      } else {
        const { bytesRead } = await fh.read(buf, 0, pieceSize, start)
        const plain = buf.subarray(0, bytesRead)
        if (bytesRead !== pieceSize || sha1Hex(ctrXorAt(plain, start, key, iv)) !== layout.pieceHashes[i]) damaged.push(i)
      }
      if (i % 16 === 15 || i === total - 1) onProgress('verifying', i + 1, total)
    }
  } finally {
    await fh.close()
  }
  return damaged
}

const FETCH_ATTEMPTS = 4
const PARALLEL_FETCHES = 4

/** Re-fetches `damaged` pieces, verifies each against its hash, decrypts it
 * and writes it into the file at its offset. Leaves the file at exactly the
 * torrent's length. */
export async function rewritePieces (
  filePath: string, layout: TorrentLayout, key: Uint8Array, iv: Uint8Array, damaged: number[],
  fetchRange: FetchRange, onProgress: RepairProgress = () => {}, signal: AbortSignal = new AbortController().signal
): Promise<void> {
  let fh: FileHandle
  try {
    fh = await open(filePath, 'r+')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    fh = await open(filePath, 'w+')
  }
  // One piece failing for good stops the others too.
  const stop = new AbortController()
  const onAbort = (): void => { stop.abort(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    let done = 0
    let cursor = 0
    onProgress('downloading', 0, damaged.length)
    const worker = async (): Promise<void> => {
      try {
        while (cursor < damaged.length) {
          stop.signal.throwIfAborted()
          const index = damaged[cursor++]!
          const { start, size } = pieceRange(layout, index)
          const cipher = await fetchVerifiedPiece(index, start, size, layout.pieceHashes[index]!, fetchRange, stop.signal)
          const plain = ctrXorAt(cipher, start, key, iv)
          await fh.write(plain, 0, plain.length, start)
          onProgress('downloading', ++done, damaged.length)
        }
      } catch (err) {
        stop.abort(err)
        throw err
      }
    }
    // allSettled, so no worker is still writing once the file is closed.
    const results = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL_FETCHES, damaged.length) }, worker))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw stop.signal.reason ?? failed.reason
    await fh.truncate(layout.length)
    await fh.sync()
  } finally {
    signal.removeEventListener('abort', onAbort)
    await fh.close()
  }
}

async function abortableDelay (ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchVerifiedPiece (
  index: number, start: number, size: number, hash: string, fetchRange: FetchRange, signal: AbortSignal
): Promise<Uint8Array> {
  let lastErr: unknown
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    signal.throwIfAborted()
    if (attempt > 0) await abortableDelay(1000 * 2 ** (attempt - 1), signal)
    try {
      const data = await fetchRange(start, start + size - 1, signal)
      if (data.length !== size) throw new Error(`piece ${index}: got ${data.length} bytes, expected ${size}`)
      if (sha1Hex(data) !== hash) throw new Error(`piece ${index} failed its hash check`)
      return data
    } catch (err) {
      if (signal.aborted) throw err
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`could not fetch piece ${index}`)
}

/** Range fetch against the webseed (/api/raw), which authorizes by the
 * transfer token in its URL — no cookies needed. */
export function webseedFetcher (url: string): FetchRange {
  return async (start, end, signal) => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal })
    if (res.status !== 206) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`server answered HTTP ${res.status} to a range request`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }
}

export async function repairDownload (
  req: RepairRequest, onProgress: RepairProgress = () => {}, signal: AbortSignal = new AbortController().signal,
  fetchRange: FetchRange = webseedFetcher(req.webseed)
): Promise<RepairResult> {
  if (req.key.length !== 32 || req.iv.length !== 16) throw new Error('invalid transfer key')
  const layout = parseTorrentLayout(req.torrent)
  const damaged = await findDamagedPieces(req.filePath, layout, req.key, req.iv, onProgress, signal)
  if (damaged.length > 0) {
    await rewritePieces(req.filePath, layout, req.key, req.iv, damaged, fetchRange, onProgress, signal)
  } else {
    // Every piece is right; only stray bytes past the end can be wrong.
    const fh = await open(req.filePath, 'a')
    try { await fh.truncate(layout.length) } finally { await fh.close() }
  }
  return { pieces: layout.pieceHashes.length, damaged }
}

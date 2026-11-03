/**
 * infoHash -> listener told every time a torrent's file iterator hands a
 * chunk covering file bytes [start, end) to whatever is consuming the file
 * (see ensureFileDecryptionPatched in browserCrypto.ts).
 *
 * The chunk stores use this to decide which pieces a save has finished with
 * (see their startDraining()). It used to be inferred from the store's own
 * `get()` calls, but WebTorrent also calls `get()` to serve pieces to other
 * peers. Serving a far-ahead piece to a peer then looked like "the save has
 * read this far", and the store deleted pieces the save had not read yet. The
 * save stream hit the missing piece and ended early without an error, so the
 * file was saved truncated.
 *
 * Kept in its own dependency-free module so the stores can import it without
 * pulling in the browser-only crypto code.
 */
export const transferReadProgress = new Map<string, (start: number, end: number) => void>()

/**
 * Tracks how far a sequential read from byte 0 has got, ignoring reads that
 * don't continue it (a peer, a ranged request, a re-read). `advance` returns
 * the number of whole pieces now behind the read, i.e. pieces safe to free.
 */
export class SequentialReadCursor {
  private consumed = 0
  private readonly chunkLength: number
  private readonly length: number

  constructor (chunkLength: number, length: number) {
    this.chunkLength = chunkLength
    this.length = length
  }

  advance (start: number, end: number): number {
    if (start <= this.consumed && end > this.consumed) this.consumed = Math.min(end, this.length)
    return this.piecesBehind()
  }

  piecesBehind (): number {
    if (this.consumed >= this.length) return Math.ceil(this.length / this.chunkLength)
    return Math.floor(this.consumed / this.chunkLength)
  }
}

// Minimal shape of the bits of WebTorrent's browser API this app actually
// uses — loaded at runtime from public/vendor/webtorrent.min.js (see
// webtorrent.ts) and exposed as a global, same technique as the browser
// web client (client/src/lib/webtorrent-types.d.ts) but written
// independently for this app.

declare global {
  interface WTFile {
    name: string
    length: number
    type: string
    streamURL: string
    stream: () => ReadableStream<Uint8Array>
  }

  interface WTWire {
    type?: string
    remoteAddress?: string
    remotePort?: number
    downloadSpeed: () => number
  }

  interface WTTorrent {
    infoHash: string
    files: WTFile[]
    length: number
    downloaded: number
    progress: number
    downloadSpeed: number
    numPeers: number
    paused: boolean
    destroyed: boolean
    wires: WTWire[]
    pause: () => void
    resume: () => void
    destroy: (opts?: { destroyStore?: boolean }, cb?: () => void) => void
    addWebSeed: (url: string) => void
    removePeer: (id: string) => void
    on: (event: 'done' | 'error', cb: (err?: unknown) => void) => void
  }

  interface WTServer {
    listen: (port: number, cb: () => void) => void
  }

  interface WebTorrentClient {
    add: (
      torrentIdOrBuffer: Uint8Array | string,
      opts: Record<string, unknown>,
      cb: (torrent: WTTorrent) => void
    ) => void
    /** Resolves the existing torrent for this id (matched by infoHash), or
     * null — used to clear out a leftover from a previous attempt (done,
     * cancelled, or failed) before re-adding, since `add()` otherwise hands
     * back that same stale torrent instead of a fresh one for a duplicate
     * infoHash (see Client.prototype.add's onInfoHash dedup check). */
    get: (torrentId: string) => Promise<WTTorrent | null>
    /** Removes and destroys the torrent for this id; rejects if none exists. */
    remove: (torrentId: string, opts?: { destroyStore?: boolean }) => Promise<void>
    createServer: (opts: { controller: ServiceWorkerRegistration }, kind: 'browser') => WTServer
    on: (event: 'error', cb: (err: unknown) => void) => void
  }

  interface WebTorrentConstructor {
    new (opts?: Record<string, unknown>): WebTorrentClient
  }

  interface Window {
    WebTorrent: WebTorrentConstructor
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<{
      createWritable: () => Promise<WritableStream<Uint8Array>>
      getFile: () => Promise<File>
    }>
  }
}

export {}

// Ambient types for the WebTorrent browser bundle, loaded as `window.WebTorrent`
// by a classic script in index.html (see the comment there), and for the two
// browser APIs used by the three-tier save in downloadManager.ts that aren't
// (yet) part of TS's bundled DOM lib.

export interface WTFile {
  name: string
  length: number
  type?: string
  /** Only valid once a WTServer has been created on the client (streamed downloads). */
  streamURL: string
  stream (): ReadableStream<Uint8Array>
  [Symbol.asyncIterator] (): AsyncIterableIterator<Uint8Array>
}

export interface WTWire {
  type: string // 'webrtc' | 'webSeed' | 'tcpIncoming' | ...
  remoteAddress?: string
  remotePort?: number
  peerId?: string
  destroy (): void
  downloadSpeed (): number
  uploadSpeed (): number
}

export interface WTTorrent {
  infoHash: string
  name: string
  progress: number
  downloaded: number
  length: number
  downloadSpeed: number
  timeRemaining: number
  numPeers: number
  done: boolean
  paused: boolean
  destroyed: boolean
  files: WTFile[]
  wires: WTWire[]
  on (event: string, fn: (...args: unknown[]) => void): void
  addWebSeed (url: string): void
  removePeer (peerOrId: string): void
  pause (): void
  resume (): void
  destroy (opts?: { destroyStore?: boolean }, cb?: () => void): void
}

export interface WTServer {
  listen (port: number, cb: () => void): void
}

declare class WebTorrentClient {
  constructor (opts?: object)
  add (
    torrent: Uint8Array,
    opts: object,
    ontorrent: (torrent: WTTorrent) => void
  ): WTTorrent
  on (event: string, fn: (...args: unknown[]) => void): void
  createServer (opts: { controller: ServiceWorkerRegistration }, force: 'browser' | 'node'): WTServer
}

// File System Access API — not yet in TS's bundled DOM lib.
export interface FileSystemWritableFileStream extends WritableStream {
  write (data: BufferSource | Blob | string): Promise<void>
  close (): Promise<void>
}
export interface FileSystemFileHandle {
  createWritable (): Promise<FileSystemWritableFileStream>
}

declare global {
  interface Window {
    WebTorrent: typeof WebTorrentClient
    showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>
  }
}

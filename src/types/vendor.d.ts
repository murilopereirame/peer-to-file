// Pragmatic type declarations for dependencies that ship without types.

declare module 'create-torrent' {
  interface CreateTorrentOptions {
    name?: string
    comment?: string
    createdBy?: string
    creationDate?: number
    private?: boolean
    pieceLength?: number
    announceList?: string[][]
    urlList?: string[]
  }

  function createTorrent (
    input: string,
    opts: CreateTorrentOptions,
    callback: (err: Error | null, torrent: Buffer) => void
  ): void

  export default createTorrent
}

declare module 'parse-torrent' {
  export interface ParsedTorrent {
    infoHash: string
    name: string
    length: number
    pieceLength: number
    lastPieceLength: number
    pieces: string[]
    files: Array<{ path: string, name: string, length: number, offset: number }>
    announce: string[]
    urlList: string[]
    private?: boolean
    created?: Date
    createdBy?: string
    comment?: string
    info: Record<string, unknown>
    infoBuffer: Uint8Array
  }

  export default function parseTorrent (
    input: Uint8Array | string
  ): Promise<ParsedTorrent>

  export function toMagnetURI (parsed: Partial<ParsedTorrent>): string
  export function toTorrentFile (parsed: Partial<ParsedTorrent>): Uint8Array
}

declare module 'bittorrent-tracker/server' {
  import type { EventEmitter } from 'node:events'
  import type { Server as HttpServer } from 'node:http'

  interface TrackerServerOptions {
    http?: boolean
    udp?: boolean
    ws?: boolean
    stats?: boolean
    trustProxy?: boolean
    interval?: number
  }

  export default class TrackerServer extends EventEmitter {
    constructor (opts?: TrackerServerOptions)
    http: HttpServer | null
    listen (port: number, hostname?: string, onlistening?: () => void): void
    close (callback?: () => void): void
    onWebSocketConnection (socket: unknown, opts?: { trustProxy?: boolean }): void
  }
}

declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events'

  interface WebTorrentOptions {
    dht?: boolean
    lsd?: boolean
    utp?: boolean
    natUpnp?: boolean
    natPmp?: boolean
    torrentPort?: number
    maxConns?: number
  }

  interface AddTorrentOptions {
    path?: string
    announce?: string[]
    skipVerify?: boolean
  }

  export interface NodeTorrent extends EventEmitter {
    infoHash: string
    name: string
    magnetURI: string
    progress: number
    uploaded: number
    numPeers: number
  }

  export default class WebTorrent extends EventEmitter {
    constructor (opts?: WebTorrentOptions)
    add (
      torrent: Uint8Array | string,
      opts?: AddTorrentOptions,
      ontorrent?: (torrent: NodeTorrent) => void
    ): NodeTorrent
    destroy (callback?: (err: Error | null) => void): void
  }
}

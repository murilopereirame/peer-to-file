# peer-to-file

A minimal self-hosted P2P file browser. A server runs next to your files; you open a web
page, type the server's IP, browse the file tree and download files with **chunked,
resumable** transfers powered by [WebTorrent](https://webtorrent.io). Built for two peers
on a trusted network (e.g. a WireGuard tunnel) — no accounts, no discovery, no public
trackers, no install on the client side.

## ⚠️ Security model — read this first

**There is no authentication.** The VPN is the trust boundary: anyone who can reach the
server's ports can browse and download everything under the shared root.

- The server binds to `127.0.0.1` by default. Set `P2F_HOST` to your **VPN interface IP**
  (e.g. your WireGuard address like `10.0.0.1`), never to a publicly routable address.
- With Docker, either use host networking and bind to the VPN IP (recommended, see
  `docker-compose.yml`), or publish the container ports on the VPN IP only
  (`"10.0.0.1:8000:8000"`).
- Path traversal is blocked (`../`, absolute paths, symlinks pointing outside the root),
  and the shared volume should still be mounted read-only.

## How it works

```
┌────────────── Server A (Docker) ──────────────┐      ┌───── Browser ─────┐
│  Express HTTP API           :8000             │      │                   │
│    /api/list      directory listings          │◄────►│  static web page  │
│    /api/torrent   on-demand .torrent + magnet │      │  (served by :8000)│
│    /api/raw       HTTP webseed (Range)        │      │                   │
│  bittorrent-tracker (WebSocket)  :8001        │◄────►│  WebTorrent       │
│  WebTorrent seeder (WebRTC data channels)     │◄═══►│  (browser build)  │
└───────────────────────────────────────────────┘ data └───────────────────┘
```

Clicking **Download**:

1. The client fetches `/api/torrent?path=...`. The server hashes the file **on demand**
   (no pre-generated `.torrent` files), caches the metadata, and returns a full `.torrent`
   (plus a magnet URI) whose announce URL points at the **embedded tracker** and whose
   `url-list` points at `/api/raw` as a BEP-19 HTTP webseed.
2. The same request starts the server-side WebTorrent client seeding that file.
3. The browser adds the torrent: it meets the seeder through the embedded WebSocket
   tracker and pulls pieces over **WebRTC data channels**, with the **HTTP webseed as a
   second source/fallback** — both go through WebTorrent's chunking and per-piece SHA-1
   verification.
4. On completion the file is handed to the browser's normal save-file flow.

No DHT, no PEX, no public trackers: torrents are flagged `private` and both sides only
announce to the embedded tracker. STUN/TURN are not used — on a VPN, host candidates are
enough.

### Resumability

- **Network drop mid-download (tab stays open):** nothing restarts. The tracker
  connection re-announces with backoff, the WebRTC channel is re-established, and the
  client re-attaches the webseed if all sources died. Already-verified pieces are kept;
  only missing pieces are requested. This holds across a full server restart too, because
  torrent metadata is deterministic — the infohash for an unchanged file is stable.
- **Closing the tab** loses in-progress state (v1 keeps pieces in memory; persisting to
  IndexedDB is a stretch goal).

## Quick start

### Docker Compose (recommended)

Edit `docker-compose.yml` (VPN IP + directory to share), then:

```sh
docker compose up -d --build
```

Open `http://<vpn-ip>:8000` from the client machine, and that's it — the page connects to
the server it was loaded from automatically. You can also host the `public/` bundle
anywhere else and point it at the server's `ip:port` (CORS is open).

### Bare Node (≥ 22.18)

```sh
npm ci
npm run build          # compiles the browser client (public/app.js)
P2F_ROOT=/srv/files P2F_HOST=10.0.0.1 npm start
```

The server runs TypeScript directly via Node's native type stripping — no build step for
the backend.

## Configuration

| Variable           | Default     | Meaning                                                        |
| ------------------ | ----------- | -------------------------------------------------------------- |
| `P2F_ROOT`         | `./data`    | Directory to share (mounted read-only in Docker as `/data`)     |
| `P2F_HOST`         | `127.0.0.1` | Bind address — **set this to your VPN IP**                      |
| `P2F_PORT`         | `8000`      | HTTP port: API, webseed and the web client                      |
| `P2F_TRACKER_PORT` | `8001`      | Embedded WebSocket tracker port                                 |
| `P2F_PUBLIC_HOST`  | *(unset)*   | Host override for tracker/webseed URLs handed to clients (only needed behind port remapping; normally derived from each request's `Host` header) |

## Development

```sh
npm ci
npm run check   # typecheck server + client
npm test        # API + path-safety tests (node:test)
npm run e2e     # real-browser end-to-end incl. kill-server-mid-download resume check
                # (needs: npm i --no-save playwright-core, and a Chromium binary)
```

## Design decisions (v1)

- **Client served by the server process** — one container, one origin, zero setup; a
  separate static host still works via CORS.
- **Embedded `bittorrent-tracker` over custom WebRTC signaling** — boring, maintained,
  and it's what WebTorrent already speaks; not worth replacing for a fixed 2-peer setup.
- **Webseed alongside WebRTC** — the `url-list` fallback costs nothing, uses the same
  verified-chunk machinery, and keeps downloads working even where the Node WebRTC
  native module (`node-datachannel`) can't be installed. If that module fails to load,
  the server logs a warning and runs webseed-only.
- **No auth token** — out of scope for v1 (stretch goal: shared secret as cheap insurance
  against VPN misconfiguration).

## Limitations (v1)

- Completed downloads are assembled in browser memory before saving — very large files
  (multi-GB) are constrained by browser RAM.
- First download of a file waits for the server to hash it (~disk read speed); metadata
  is cached afterwards.
- Download-only (no uploads), no previews, no sync, no multi-peer swarming.

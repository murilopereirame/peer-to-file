# peer-to-file

[![CI](https://github.com/murilopereirame/peer-to-file/actions/workflows/ci.yml/badge.svg)](https://github.com/murilopereirame/peer-to-file/actions/workflows/ci.yml)

A minimal self-hosted P2P file browser. A server runs next to your files; you open a web
page, type the server's IP, browse the file tree and download files with **chunked,
resumable** transfers powered by [WebTorrent](https://webtorrent.io). Built for two peers
on a trusted network (e.g. a WireGuard tunnel) — no accounts, no discovery, no public
trackers, no install on the client side.

## ⚠️ Security model — read this first

**Authentication is on by default** (`P2F_AUTH=on`): every endpoint requires a login
session, an API token, or — for the transfer URLs WebTorrent uses — a signed, expiring
transfer token. Defense in depth still applies:

- The server binds to `127.0.0.1` by default. Set `P2F_HOST` to your **VPN interface IP**
  (e.g. your WireGuard address like `10.0.0.1`) rather than a publicly routable address.
- With Docker, either use host networking and bind to the VPN IP (recommended, see
  `docker-compose.yml`), or publish the container ports on the VPN IP only
  (`"10.0.0.1:8000:8000"`).
- Path traversal is blocked (`../`, absolute paths, symlinks pointing outside the root),
  and the shared volume should still be mounted read-only.
- `P2F_AUTH=off` restores the original no-auth mode for pure-VPN setups — then the VPN is
  the only trust boundary.
- Traffic is plain HTTP unless you terminate TLS in front (see the nginx section); on a
  WireGuard tunnel the transport is already encrypted.

### Setting up users and tokens

Users live in a SQLite database (Node's built-in `node:sqlite` — no native modules).
Passwords are stored as scrypt hashes, tokens and session ids as SHA-256 hashes.

```sh
# bare metal                             # docker
node src/server/cli.ts add-user alice   docker compose exec peer-to-file \
                                          node src/server/cli.ts add-user alice
```

The CLI also manages API tokens for scripts / non-browser clients:

```sh
node src/server/cli.ts add-token alice backup-script   # prints the token once
curl -H "Authorization: Bearer p2f_..." "http://10.0.0.1:8000/api/list?path="
```

`list-users`, `del-user`, `list-tokens`, `del-token` complete the set.

### How the P2P transfer stays authenticated

Cookies and headers don't reach WebTorrent's internal HTTP/WebSocket calls, so
`/api/torrent` embeds short-lived HMAC-signed tokens directly in the URLs it hands out:
the webseed URL carries a token bound to that one file path, and the tracker URL a token
that only opens the signaling channel. Both expire after 48 h; a page refresh fetches
fresh ones. With auth on, the standalone tracker port is not opened at all — the tracker
is only reachable through the token-gated `/tracker` path on the main port.

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

### Resumability, pause and cancel

- **Network drop mid-download (tab stays open):** nothing restarts. The tracker
  connection re-announces with backoff, the WebRTC channel is re-established, and the
  client re-attaches the webseed if all sources died. Already-verified pieces are kept;
  only missing pieces are requested. This holds across a full server restart too, because
  torrent metadata is deterministic — the infohash for an unchanged file is stable.
- **Refreshing or closing the tab:** verified pieces are persisted in the browser's
  origin-private file system (OPFS) and the download list in localStorage. On the next
  visit the client re-adds the downloads, re-verifies the stored pieces locally and
  continues from where it stopped — including the paused/running state.
- **Pause** stops all transfer connections (zero bandwidth, not just "no new peers");
  **Resume** re-attaches the sources. **Cancel** discards the download and its stored
  pieces.

## Quick start

### Docker Compose (recommended)

Edit `docker-compose.yml` (VPN IP + directory to share), then:

```sh
docker compose up -d --build
```

Open `http://<vpn-ip>:8000` from the client machine, and that's it — the page connects to
the server it was loaded from automatically. You can also host the `public/` bundle
anywhere else and point it at the server's `ip:port` (CORS is open).

Create the first user, then sign in on the page:

```sh
docker compose exec peer-to-file node src/server/cli.ts add-user alice
```

### Bare Node (≥ 22.18)

```sh
npm ci
npm run build          # compiles the browser client (public/app.js)
node src/server/cli.ts add-user alice
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
| `P2F_PUBLIC_URL`   | *(unset)*   | Public origin when behind a reverse proxy, e.g. `https://files.example.com` — see below |
| `P2F_AUTH`         | `on`        | `on` requires login/tokens on every endpoint; `off` restores the VPN-only trust model |
| `P2F_DB`           | `./p2f.db`  | SQLite database for users/sessions/API tokens (`/config/p2f.db` in Docker) |

## Behind a reverse proxy (nginx)

Set `P2F_PUBLIC_URL` to the public origin and bind the app to localhost:

```sh
P2F_HOST=127.0.0.1 P2F_PUBLIC_URL=https://files.example.com
```

In this mode the tracker WebSocket is served **on the main HTTP port at `/tracker`**, and
all URLs handed to clients (announce, webseed, magnet) use the public origin with the
right schemes (`https`/`wss` — plain `http`/`ws` would be blocked as mixed content on an
HTTPS page). nginx therefore needs exactly one upstream and two location blocks: a
WebSocket-upgrade one for `/tracker` and a plain one for everything else. A complete,
commented example lives in [`docs/nginx.example.conf`](docs/nginx.example.conf).

The same security rule applies one layer up: TLS is not authentication. Bind the nginx
listener to the VPN IP, or add auth (basic auth, client certs) at the proxy.

The separate tracker port (`P2F_TRACKER_PORT`) keeps running for direct/VPN access but
does not need to be exposed through the proxy.

## Development

```sh
npm ci
npm run check   # typecheck server + client
npm test        # API + auth + path-safety tests (node:test)
npm run e2e     # real-browser end-to-end: login, pause/resume, server-restart
                # resume, page-reload resume (OPFS), checksum
                # (needs: npm i --no-save playwright, and a Chromium binary)
```

CI (GitHub Actions, `.github/workflows/ci.yml`) runs the same three layers on every pull
request: typecheck + tests on Node 22 and 24, the browser end-to-end, and a Docker image
build.

## Design decisions (v1)

- **Client served by the server process** — one container, one origin, zero setup; a
  separate static host still works via CORS.
- **Embedded `bittorrent-tracker` over custom WebRTC signaling** — boring, maintained,
  and it's what WebTorrent already speaks; not worth replacing for a fixed 2-peer setup.
- **Webseed alongside WebRTC** — the `url-list` fallback costs nothing, uses the same
  verified-chunk machinery, and keeps downloads working even where the Node WebRTC
  native module (`node-datachannel`) can't be installed. If that module fails to load,
  the server logs a warning and runs webseed-only.
- **Built-in `node:sqlite` over better-sqlite3/sqlcipher** — zero native dependencies.
  The database stores only scrypt password hashes and SHA-256 token/session hashes, so
  at-rest encryption of the DB adds little; if you need it, put `P2F_DB` on an encrypted
  volume (sqlcipher would require a native build of a different driver).

## Limitations

- Completed downloads are assembled into a Blob for the browser save dialog — very large
  files (multi-GB) are constrained by browser memory at that final step (pieces
  themselves are stored in OPFS, not RAM).
- First download of a file waits for the server to hash it (~disk read speed); metadata
  is cached afterwards.
- Transfer tokens expire after 48 h; a download paused longer than that resumes with
  fresh tokens on the next page load (or after re-clicking Download).
- Download-only (no uploads), no previews, no sync, no multi-peer swarming.

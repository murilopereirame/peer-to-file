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

**First run**: with no users in the database yet, opening the web client shows a
one-time **setup screen** instead of a login form — pick a username and password there
and that becomes the admin account. `POST /api/setup` is the endpoint behind it; it
works exactly once (it 409s the moment any account exists, whether created through the
screen or the CLI below), so there is no standing "create a user" endpoint left over
for an attacker to hit.

Additional accounts, or headless/scripted setup, go through the CLI:

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
4. On completion the file is streamed to disk without ever being held in memory as a
   single Blob — see "Saving without running out of memory" below.

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
- **Abandoned downloads get reclaimed automatically.** Cancelling, or finishing and
  saving, always frees the piece store right away. A tab closed mid-download and never
  reopened has no such trigger, so on every startup the client also: drops (and deletes
  the on-disk pieces for) any download untouched for 14+ days, and removes any OPFS
  piece store that isn't tracked by a known download at all (leftover from a save that
  finished with no completion signal to act on immediately — see below — or any other
  edge case). Nothing is silently accumulated forever.

### Saving without running out of memory

A completed download is written to disk one of three ways, tried in order, so that a
huge file is never held in memory all at once:

1. **File System Access API** (Chrome, Edge, …): streams straight from the on-disk piece
   store to a file you choose, with a small, bounded memory footprint.
2. **WebTorrent's own service worker**, for browsers without that API (this is what
   actually matters for **Safari**, whose lack of the File System Access API combined
   with a small Blob size limit is the classic way a large download used to OOM there):
   streams the file to the browser's native download mechanism — no Blob is ever built.
3. **A Blob built from the file's individual pieces**, only if neither of the above is
   available (see below) — this is the one path whose memory use still scales with file
   size, but even it skips the extra full-copy step a naive Blob build does.

Both (1) and (2) need a **secure context** — HTTPS, or `localhost` — which a plain-HTTP
VPN deployment (this project's default) doesn't have. On such a deployment every save
falls back to (3). If you want large-file downloads to use the memory-safe path, put the
server behind the [nginx + `P2F_PUBLIC_URL` reverse-proxy setup](#behind-a-reverse-proxy-nginx)
described below (self-signed certificates are fine — once you've accepted the browser's
warning once, the origin counts as secure).

### Download details

Click a download row's **Details** button for its info hash, elapsed time, and the
active peer list (type, address if known — WebRTC addresses are best-effort, since
they're not always exposed — and current speed per peer).

### Activity logs

The **View logs** link (top right, once connected) opens a dedicated tab showing recent
server activity: connections, tracker announces, torrent metadata requests, and webseed
hits, each with a timestamp and, where available, the remote IP. It polls
`GET /api/logs` (same auth as everything else) and filters by kind. The log is an
in-memory ring buffer (~500 entries) — a restart clears it; this is for "what's
happening / just happened", not a persisted audit trail.

## Quick start

### Docker Compose (recommended)

Edit `docker-compose.yml` (VPN IP + directory to share), then:

```sh
docker compose up -d --build
```

Open `http://<vpn-ip>:8000` from the client machine, and that's it — the page connects to
the server it was loaded from automatically. You can also host the `public/` bundle
anywhere else and point it at the server's `ip:port` (CORS is open).

The first visit shows a **setup screen** since no account exists yet — pick a username
and password there to create the admin account (see "Setting up users and tokens" above
for the CLI alternative).

### Bare Node (≥ 22.18)

```sh
npm ci
npm run build          # compiles the browser client (public/app.js)
P2F_ROOT=/srv/files P2F_HOST=10.0.0.1 npm start
```

Then open the page and use the setup screen as above.

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
- **Root entrypoint that drops to `node`** — the container starts as root only long
  enough to fix ownership of a bind-mounted `/config` (Docker auto-creates a missing
  bind-mount host directory as root, which the app's non-root user then can't write
  into), then `exec`s the actual server as `node` via `gosu`. Named volumes don't need
  this (Docker seeds them from the image, already owned by `node`), but bind mounts —
  `./config:/config`, the common case — do.
- **WebTorrent's own service worker for streamed saves, not a bespoke one** — it already
  implements exactly this (stream a torrent's data to a native download with no Blob),
  is what the library's own examples use, and is one less thing to maintain. The one
  non-obvious rule when using it: the anchor that triggers the download must **not**
  carry the HTML `download` attribute — the service worker's response already sets
  `Content-Disposition: attachment`, and setting both makes Chromium cancel the download
  outright (two competing "force download" signals on the same navigation).

## Limitations

- Large-file downloads only avoid an in-memory Blob when the page is loaded over a
  secure context (HTTPS or `localhost`) — see "Saving without running out of memory".
  A plain-HTTP VPN deployment (this project's default) falls back to a Blob, whose
  memory use scales with file size.
- First download of a file waits for the server to hash it (~disk read speed); metadata
  is cached afterwards.
- Transfer tokens expire after 48 h; a download paused longer than that resumes with
  fresh tokens on the next page load (or after re-clicking Download).
- The activity log is in-memory and unauthenticated requests aren't attributed to a
  user (only an IP) — it's an operational aid, not a security audit trail.
- Download-only (no uploads), no previews, no sync, no multi-peer swarming.

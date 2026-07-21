# peer-to-file

[![CI](https://github.com/murilopereirame/peer-to-file/actions/workflows/ci.yml/badge.svg)](https://github.com/murilopereirame/peer-to-file/actions/workflows/ci.yml)

A minimal self-hosted P2P file browser. A server runs next to your files; you open the
page it serves and immediately get a browsable file tree with **chunked, resumable**
downloads and uploads powered by [WebTorrent](https://webtorrent.io). Built for two peers
on a trusted network (e.g. a WireGuard tunnel) — no accounts, no discovery, no public
trackers, no install on the client side.

## ⚠️ Security model — read this first

**Authentication is always on**: every endpoint requires a login session, an API token,
or — for the transfer URLs WebTorrent uses — a signed, expiring transfer token. There is
no way to disable it. Defense in depth still applies:

- The server binds to `127.0.0.1` by default. Set `P2F_HOST` to your **VPN interface IP**
  (e.g. your WireGuard address like `10.0.0.1`) rather than a publicly routable address.
- With Docker, either use host networking and bind to the VPN IP (recommended, see
  `docker-compose.yml`), or publish the container ports on the VPN IP only
  (`"10.0.0.1:8000:8000"`).
- Path traversal is blocked (`../`, absolute paths, symlinks pointing outside the root).
  The shared volume is mounted **read-only by default** (`docker-compose.yml`), which
  disables delete/rename/move/upload entirely (they fail with a permission error) — the
  safest option if you only need browsing and downloads. Mount it read-write only if you
  want file management too, and only after you're satisfied with the auth/network
  boundary above: with write access, anyone who can authenticate can delete or overwrite
  anything under the shared root.
- Sessions are short-lived: a **48 h access cookie** is renewed by a longer-lived,
  single-use **refresh cookie** (rotated on each use, scoped to `/api/refresh`).
  API tokens for scripts default to a **90-day** lifetime (`--ttl` to change). Passwords
  are a minimum of 12 characters, and repeated failed logins are rate-limited per IP
  (each failure also logs a `p2f auth-fail ip=… user="…"` line you can wire to fail2ban).
- Cookie-authenticated state-changing requests require an `X-P2F-Csrf` header the bundled
  clients send automatically — CSRF defense-in-depth on top of `SameSite=Lax` cookies.
- HTTP traffic itself is plain unless you terminate TLS in front (see the nginx section);
  on a WireGuard tunnel the transport is already encrypted. **File content is encrypted
  regardless**, independent of TLS/VPN — see "Transfer encryption" below.

### Transfer encryption

File contents are encrypted end-to-end between the server and the app doing the transfer
(AES-256-CTR), so the wire never carries plaintext even on a deployment with no TLS and no
VPN — a defense-in-depth layer on top of, not a replacement for, the network boundary
above. The server can still read files (it already does, to hash and serve them), so this
is not zero-knowledge storage: an operator with access to the server can read the shared
files, same as today.

- **Downloads**: the server encrypts each shared file once per version into a ciphertext
  cache (`P2F_CACHE_DIR`, default `./p2f-cache`) with a key deterministically derived from
  a per-server secret plus the file's identity — deterministic so an unchanged file
  produces the same ciphertext (and BitTorrent infohash) across server restarts, keeping
  the existing resume behavior intact. Both the HTTP webseed and WebRTC peers serve this
  ciphertext; BitTorrent's own per-piece SHA-1 verification runs against it unchanged. The
  web and desktop clients decrypt transparently as they save.
- **Uploads**: the client generates a fresh one-time key per upload and encrypts the file
  before it leaves the device, plus a plaintext SHA-256 the server verifies after
  decrypting — closing the integrity gap CTR alone doesn't cover (uploads had no integrity
  check at all before this).
- **The transfer key itself never crosses the wire in the clear.** Sending it as plain
  JSON/headers alongside the ciphertext would let anyone who can merely observe the wire
  (the exact case this feature targets on a no-TLS deployment) recover it trivially,
  defeating the point. Instead, each transfer wraps the key under a secret derived from
  ECDH (P-256) between the server's stable keypair and a fresh, per-transfer ephemeral
  keypair the client generates — recovering the key from captured traffic alone would
  require solving the discrete-log problem, not just reading bytes off the wire. This
  protects against a passive observer; it isn't a substitute for authenticating the network
  path itself (that's what TLS/VPN are for) against an *active* attacker who can tamper
  with traffic in real time.
- `P2F_CACHE_DIR` is deliberately outside `P2F_ROOT`, so it stays writable even when the
  shared root is mounted read-only.

### Setting up users and tokens

Users live in a SQLite database (Node's built-in `node:sqlite` — no native modules).
Passwords are stored as scrypt hashes, tokens and session ids as SHA-256 hashes.

**First run**: with no users in the database yet, opening the web client shows a
one-time **setup screen** instead of a login form — enter the **setup token** printed in
the server log at first boot (`first-run setup token: …`), then pick a username and
password and that becomes the admin account. `POST /api/setup` is the endpoint behind it;
it requires that token while open and works exactly once (it 409s the moment any account
exists, whether created through the screen or the CLI below), so there is no standing
"create a user" endpoint — and no unauthenticated first-boot window — for an attacker to
hit.

Additional accounts, or headless/scripted setup, go through the CLI:

```sh
# bare metal                             # docker
node src/server/cli.ts add-user alice   docker compose exec peer-to-file \
                                          node src/server/cli.ts add-user alice
```

The CLI also manages API tokens for scripts / non-browser clients:

```sh
node src/server/cli.ts add-token alice backup-script            # 90-day token, printed once
node src/server/cli.ts add-token alice ci --ttl 30d             # custom lifetime
node src/server/cli.ts add-token alice forever --ttl never      # non-expiring
curl -H "Authorization: Bearer p2f_..." "http://10.0.0.1:8000/api/list?path="
```

Tokens default to a 90-day lifetime; `--ttl` accepts `90d`/`12h`/`30m` or `never`.
`list-users`, `del-user`, `list-tokens`, `del-token` complete the set.

### How the P2P transfer stays authenticated

Cookies and headers don't reach WebTorrent's internal HTTP/WebSocket calls, so
`/api/torrent` embeds short-lived HMAC-signed tokens directly in the URLs it hands out:
the webseed URL carries a token bound to that one file path, and the tracker URL a token
bound to that one torrent's infohash. Both expire after 6 h; a page refresh (or resuming
a long-paused download) fetches fresh ones. The tracker is only ever reachable through the
token-gated `/tracker` path on the main port — no standalone, unauthenticated tracker port
is opened. A client that can carry a `Sec-WebSocket-Protocol` may pass the tracker token
there (`p2f.<token>`) instead of the query string, keeping it out of proxy access logs.

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

Path (2) has no JS-visible signal for when the browser actually finishes writing the
file, so the on-disk piece store it streams from is kept around until every piece has
been read back out at least once (real completion), not reclaimed on a fixed timer —
otherwise a large or slow save could have its pieces deleted out from under it mid-
stream, which shows up to the user as the browser abruptly stopping/failing the
download partway through.

All OPFS piece reads/writes run in a dedicated worker via `FileSystemSyncAccessHandle`
rather than the main-thread `createWritable()` stream. A sync access handle holds an
exclusive lock on its file for its whole open/write-or-read/flush/close lifetime, so two
operations can never race the same file, and a write is guaranteed durably flushed
before `close()` returns — WebKit's async OPFS writes have been observed to leave a
piece readable-but-truncated under concurrent access, which surfaced as path (2)
streaming a 0-byte file on Safari with no error anywhere.

### Download details

Click a download row's **Details** button for its info hash, elapsed time, average
speed (total downloaded ÷ elapsed time — a wall-clock average, so it includes any time
spent paused, same as "Elapsed"), and the active peer list (type, address if known —
WebRTC addresses are best-effort, since they're not always exposed — and current speed
per peer).

Downloading a file you've already fully downloaded (still showing **done** in the list)
re-queues it in place — no need to **Clear** the old row first.

### Download history

A **Download history** card lists every file this browser has finished saving, with its
size and completion time — a simple "what did I already grab" record, separate from the
live in-progress **Downloads** list above it. It's server-persisted (`download_history`
table in the same SQLite database as users/sessions) and scoped to the signed-in user.
**Clear history** wipes your own entries — it only touches this list, not anything on disk
or the file's own availability.

### Activity logs

The **View logs** link (top right, once connected) opens a dedicated tab showing recent
server activity: connections, tracker announces, torrent metadata requests, and webseed
hits, each with a timestamp and, where available, the remote IP. It polls
`GET /api/logs` (same auth as everything else) and filters by kind. The log is an
in-memory ring buffer (~500 entries) — a restart clears it; this is for "what's
happening / just happened", not a persisted audit trail. **Download logs** exports the
currently filtered view as a `.txt` file (client-side only — nothing new to fetch).

### Managing files

Every listing row has a **Download** button (files only) and a kebab (**⋮**) menu with
**Rename**, **Move** and **Delete**. Folders/toolbar have an **Upload** button
(drag-and-drop onto the file listing works too, dropping into whichever folder is
currently open) — uploads get their own card below the browser, separate from the file
listing, so a batch of in-flight uploads doesn't push the listing itself around.

- **Rename** turns the entry's name into an inline text field; submitting a bare name
  renames it in place via `POST /api/move`, which refuses to overwrite an existing entry.
- **Move** opens a small modal with its own folder browser (breadcrumb + subfolder
  navigation, starting in the entry's current folder) — pick a destination and confirm
  with **Move here**. Also goes through `POST /api/move`, which refuses to move a folder
  into its own subtree.
- **Delete** asks for confirmation, then recursively removes the file or folder via
  `POST /api/delete`. There is no trash/undo — deletion is immediate and permanent.
- **Upload** streams each selected (or dropped) file straight to disk via
  `POST /api/upload` — never buffered whole in memory, written to a temp file first and
  atomically renamed into place, so an aborted upload can't leave a partial file visible
  in listings or clobber an existing one of the same name. Progress is shown per file in
  the **Uploads** card; the listing refreshes automatically as each upload completes.

All of these are gated by the same session/token authentication as everything else, and
every mutation (delete, move, upload) is recorded in the activity log. They also require
the shared directory to be writable — the default Docker Compose setup mounts it
read-only, which disables them cleanly (a permission error, not a crash); see the
security note above before switching to a read-write mount.

## Quick start

### Docker Compose (recommended)

Edit `docker-compose.yml` (VPN IP + directory to share), then:

```sh
docker compose up -d --build
```

Open `http://<vpn-ip>:8000` from the client machine, and that's it — the page always talks
to the origin it was loaded from, so there's nothing to type or configure client-side.
(The API itself still carries permissive CORS headers, e.g. for scripting against it from
elsewhere — see "Setting up users and tokens" above — but the bundled web client no longer
offers a way to point at a different server.)

The first visit shows a **setup screen** since no account exists yet — pick a username
and password there to create the admin account (see "Setting up users and tokens" above
for the CLI alternative).

### Bare Node (≥ 22.18)

```sh
npm ci
npm run build          # builds the React client (client/dist/)
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
| `P2F_TRACKER_PORT` | `8001`      | Legacy tracker port — no longer opened (the tracker is served only at `/tracker` on the main port); kept for compatibility |
| `P2F_PUBLIC_HOST`  | *(unset)*   | Host override for tracker/webseed URLs handed to clients (only needed behind port remapping; normally derived from each request's `Host` header) |
| `P2F_PUBLIC_URL`   | *(unset)*   | Public origin when behind a reverse proxy, e.g. `https://files.example.com` — see below |
| `P2F_DB`           | `./p2f.db`  | SQLite database for users/sessions/API tokens/download history (`/config/p2f.db` in Docker) |
| `P2F_CACHE_DIR`    | `./p2f-cache` | Ciphertext cache for transfer encryption (`/config/cache` in Docker) — see "Transfer encryption" below |
| `P2F_CACHE_MAX_BYTES` | `8589934592` | Soft cap (bytes) on the ciphertext cache; least-recently-used entries are evicted over it (`0` disables). Default 8 GiB |
| `P2F_SECURE_COOKIES` | `auto`    | Mark auth cookies `Secure`: `auto` (derive from the effective scheme), `on`, or `off` |
| `P2F_TRUST_PROXY`  | `off`       | Trust `X-Forwarded-*` from a front proxy (needed for correct client IPs / `Secure` behind nginx) |

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

Behind a TLS-terminating proxy, also set `P2F_TRUST_PROXY=on` (so client IPs in the
activity log and the `Secure`-cookie decision honor `X-Forwarded-*`). If the proxy
terminates HTTPS but you don't set `P2F_PUBLIC_URL` to an `https://` origin, set
`P2F_SECURE_COOKIES=on` explicitly so session cookies are still marked `Secure`.

The tracker is served only on the main HTTP port at `/tracker`; no standalone tracker port
is opened, so nothing extra needs exposing through the proxy.

## Development

```sh
npm ci
npm run check   # typecheck server + client + OPFS worker
npm test        # API + auth + path-safety tests (node:test)
npm run e2e     # real-browser end-to-end: login, pause/resume, server-restart
                # resume, page-reload resume (OPFS), checksum
                # (needs: npm i --no-save playwright, and a Chromium binary)
```

CI (GitHub Actions, `.github/workflows/ci.yml`) runs the same three layers on every pull
request: typecheck + tests on Node 22 and 24, the browser end-to-end, and a Docker image
build.

## Design decisions (v1)

- **Client-side React (Vite), no SSR** — the app's actual work (WebTorrent, OPFS, the
  service worker stream, the File System Access API) only runs in the browser, so
  server-rendering it would add a framework without removing any client-side code. There's
  no SEO or slow-network case either: this is a VPN-bound internal tool, always opened
  already authenticated to a known server. `client/` is a plain Vite + React + TypeScript
  project with two HTML entry points (the browser and the logs page); it builds to
  `client/dist/`, which the server serves as static files exactly like the old vanilla-JS
  client did.
- **Client served by the server process, same-origin only** — one container, one origin,
  zero setup or configuration: the page always talks to the origin it was loaded from,
  with no server address for a user to find or type in.
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
- Transfer tokens expire after 6 h; a download paused longer than that resumes with
  fresh tokens on the next page load (or after re-clicking Download).
- The activity log is in-memory and unauthenticated requests aren't attributed to a
  user (only an IP) — it's an operational aid, not a security audit trail.
- No previews, no sync, no multi-peer swarming.

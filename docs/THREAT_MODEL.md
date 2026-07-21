# peer-to-file — Threat Model & Remediation Plan

> Status: initial review, 2026-07. Covers the server (`src/server/`), the shared
> crypto helpers (`packages/shared/`), the web client (`client/`) and the Electron
> desktop app (`apps/desktop/`). This is a living document — revisit it whenever the
> trust boundary (auth, network exposure, number of users) changes.

## 1. Overview

peer-to-file is a self-hosted, two-peer file browser. A server process runs next to a
directory of files and serves a browsable tree; a browser (or the desktop app) downloads
files over WebTorrent (WebRTC data channels, with an HTTP webseed fallback) and can
upload / delete / move / rename them. It is explicitly designed for **two peers on a
trusted network** (e.g. a WireGuard tunnel), with authentication on by default and
application-layer encryption of file contents on top of whatever transport security the
deployment provides.

The purpose of this document is to make the trust boundaries explicit, enumerate what an
attacker in each position can do, and record the gaps found in the current code together
with a prioritised plan to close them.

## 2. Methodology

STRIDE-oriented review of each component and trust boundary, driven by a read of the
actual source rather than the README's claims. Findings are rated by likelihood ×
impact **within the project's stated deployment model** (VPN-bound, small number of
trusted users). A finding rated "Low" here may be "High" if the operator ignores the
network-boundary guidance and exposes the server publicly — that misconfiguration is
itself the largest single risk (see F0).

## 3. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Shared file contents | `P2F_ROOT` on disk | The whole point of the app; confidentiality + integrity. |
| Write access to `P2F_ROOT` | Filesystem (rw mount only) | Delete/move/upload can destroy or plant data. |
| User credentials | scrypt hashes in SQLite (`P2F_DB`) | Account takeover. |
| Session ids / API tokens | SHA-256 hashes in SQLite; raw value in client cookie / desktop keychain | Impersonation. |
| Transfer-token HMAC secret | `meta.transfer_secret` (SQLite, hex) | Forge webseed/tracker tokens. |
| Cipher master secret | `meta.cipher_secret` (SQLite) | Derive every file's transfer-encryption key. |
| Server ECDH private key | `meta.ecdh_private_key` (SQLite) | Unwrap transfer keys off the wire. |
| Ciphertext cache | `P2F_CACHE_DIR` on disk | A second at-rest copy of every downloaded file (encrypted). |
| Activity log | In-memory ring buffer | Usernames, IPs, file paths, infohashes. |

Note that the SQLite database is the crown jewels: it holds the three long-lived secrets
(`transfer_secret`, `cipher_secret`, `ecdh_private_key`) in plaintext. Anyone who can read
`P2F_DB` can forge transfer tokens and decrypt captured transfer traffic. This is by
design (`node:sqlite`, no at-rest encryption — see README "Design decisions"), so the DB
file's filesystem permissions are part of the trust boundary.

## 4. Trust boundaries & data flow

```
                    ┌─────────────────────── trust boundary: the network ───────────────────────┐
                    │                                                                            │
  [ Browser / ]     │   :8000  HTTP  ── /api/*      (session cookie | Bearer token)              │
  [ Desktop   ] ────┼────────────────── /api/raw    (path-bound transfer token, PRE-auth gate)   │
  [ app       ]     │          WS    ── /tracker    (tracker transfer token)                     │
                    │          WebRTC── data channels (peer-matched via tracker)                 │
                    │                                                                            │
                    └────────────────────────────────────────────────────────────────────────────┘
                                                   │
                      ┌────────────────────────────┴───────────────────────────┐
                      │ Server process (drops from root → node in Docker)        │
                      │   express app  ── browse.ts (path-traversal gate)        │
                      │   cipherCache  ── AES-256-CTR at-rest/in-transit copy     │
                      │   AuthDb       ── SQLite: users, sessions, tokens, secrets│
                      │   seeder       ── WebTorrent (WebRTC), reads ciphertext   │
                      │   FS access    ── P2F_ROOT (ro or rw), P2F_CACHE_DIR (rw) │
                      └──────────────────────────────────────────────────────────┘
```

Boundaries, from outermost in:

1. **The network** (VPN / TLS). The project's primary defence. If this holds, an
   external attacker cannot reach the ports at all. If it does *not* hold, everything
   below has to stand on its own — which is what most of the findings are about.
2. **Authentication** (`P2F_AUTH=on`). Session cookie, Bearer token, or a signed
   transfer token in a URL. `P2F_AUTH=off` removes this boundary entirely.
3. **Path containment** (`browse.ts`). Keeps all filesystem access inside `P2F_ROOT`.
4. **Process isolation** (Docker non-root, read-only mount). Limits blast radius of a
   compromise of the process itself.

There is **no authorization boundary between authenticated users**: every account can
read, write (rw mount), and audit everything. That is intentional for the two-peer model
but is a boundary that silently disappears the moment a third account exists (see F4).

## 5. Threat enumeration by boundary

### 5.1 External attacker with network access but no credentials (auth ON)

- Cannot reach `/api/*` gated routes — the auth middleware (`app.ts:216`) 401s them.
- **Can** reach the three pre-auth routes: `/api/info`, `/api/login`, `/api/setup`,
  `/api/raw`, and the service-worker keepalive/cancel stubs.
  - `/api/info` leaks version, whether WebRTC seeding is up, the ECDH public key, and
    whether setup is still pending — low sensitivity, but it is an unauthenticated
    fingerprinting surface.
  - `/api/login` is a brute-force target (F1).
  - `/api/setup` is a race-to-own-the-instance if an attacker reaches a freshly
    deployed server before the operator completes setup (F1a).
  - `/api/raw` requires a valid path-bound transfer token *or* a session — a token leak
    exposes exactly one file for 48h (F3).
- Can attempt to connect to `/tracker` — rejected without a valid tracker token
  (`index.ts:138`). A leaked tracker token grants swarm signaling for 48h (F3).

### 5.2 Passive network observer (no TLS/VPN, e.g. shared LAN)

- Sees HTTP metadata: paths, filenames, sizes, infohashes, usernames in URLs/JSON.
- **Cannot** read file contents: transfers carry AES-256-CTR ciphertext and the key is
  ECDH-wrapped (`keyExchange.ts`), so recovering it requires solving ECDH. This is the
  transfer-encryption feature working as intended.
- **Can** capture a session cookie or Bearer token if the deployment is plain HTTP and
  the cookie lacks `Secure` (F6) — that is full account takeover, and it is *not*
  mitigated by transfer encryption (which only covers file bytes, not the auth
  credential). Plain HTTP without a VPN is the documented worst case; the point here is
  that transfer encryption does **not** make plain HTTP safe for the auth layer.

### 5.3 Active network attacker (MITM, no TLS)

- Explicitly out of scope per the README, and correctly so: CTR ciphertext is malleable
  and the upload integrity SHA travels in cleartext (F7), so an active attacker can
  tamper. TLS/VPN is the only defence against this and the docs say so. Recorded as F7
  for completeness and as an argument for moving the SHA under the authenticated GCM blob.

### 5.4 Authenticated but malicious/curious user

- Full read of every file under `P2F_ROOT`; full write if the mount is rw.
- Can read the global activity log (`/api/logs`) — other users' IPs, usernames, paths
  (F4).
- Can exhaust CPU/disk: `/api/torrent` hashes + encrypts arbitrary files into the cache
  with no size cap or eviction; no endpoint is rate-limited (F2).
- No privilege escalation path *within* the app is needed because there are no
  privilege levels — every user already has everything.

### 5.5 Attacker who has compromised the server process / host

- Reads plaintext files (the server already does, to hash/serve them — not
  zero-knowledge, documented).
- Reads the SQLite secrets → can forge tokens and decrypt captured transfers.
- Docker non-root + read-only mount limit persistence and tampering of the shared data,
  which is the main value of that hardening.

### 5.6 Malicious web page in the user's browser (CSRF / drive-by)

- State-changing endpoints are cookie-authable POSTs. `SameSite=Lax` blocks the cookie
  on cross-site POSTs, so classic CSRF is largely mitigated — but there is no
  defence-in-depth CSRF token and CORS is wildcard (F5).

## 6. Findings

Severity is relative to the intended (VPN-bound, few trusted users) deployment.

| ID | Severity | Title |
| --- | --- | --- |
| F0 | High (if misconfigured) | Security collapses to a single network boundary; easy to misdeploy |
| F1 | Medium | No brute-force / rate limiting on login; 8-char password floor |
| F1a | Low | First-run `/api/setup` is a race to claim the admin account |
| F2 | Medium | No rate limiting or resource caps → CPU/disk exhaustion |
| F3 | Medium | Tracker transfer token is unscoped and long-lived; tokens ride in URLs |
| F4 | Low–Medium | No per-user authorization; global log/file access for every account |
| F5 | Low | No anti-CSRF token; wildcard CORS on `/api` |
| F6 | Low | `Secure` cookie flag only set when `P2F_PUBLIC_URL` is https |
| F7 | Low | Upload integrity SHA is cleartext & unauthenticated; CTR is malleable |
| F8 | Low | scrypt cost below current guidance; download integrity via SHA-1 |
| F9 | Low | API tokens never expire; no bulk session revocation |
| F10 | Info | `P2F_AUTH=off` removes all auth incl. transfer/tracker tokens |
| F11 | Info | No `npm audit`/Dependabot in CI; large transitive dependency tree |
| F12 | Low | `req.ip` used without `trust proxy`; audit IPs wrong behind a proxy |

### Detail

**F0 — One boundary, easy to knock over.** *(app-wide; `README.md`, `docker-compose.yml`)*
The entire model assumes the network boundary holds. Auth-off is a supported mode; the
Docker compose file ships bound to a placeholder `10.0.0.1` with a comment, not a
fail-closed default; the standalone tracker port (`8001`) is opened only when auth is off
but is otherwise a second listener to reason about. The dominant real-world risk is an
operator binding to `0.0.0.0` on a public host, or forgetting to change the VPN IP. The
code warns in logs but does not refuse to start in obviously-dangerous configurations.

**F1 — Login brute force.** *(`app.ts:166`, `db.ts:139`)* `/api/login` applies a fixed
300 ms delay on failure and nothing else: no per-IP or per-account rate limit, no
lockout, no exponential backoff. Passwords need only 8 characters (`db.ts:139`). scrypt
makes each guess cost ~tens of ms of CPU, which is real but not a substitute for rate
limiting — an attacker on the VPN (or on a mis-exposed instance) can grind. There is also
no CAPTCHA/second factor, appropriate for the threat model, but it raises the bar on
getting rate limiting right.

**F1a — Setup race.** *(`app.ts:148`)* Between first deploy and the operator completing
setup, whoever POSTs `/api/setup` first becomes admin. On a correctly VPN-bound host the
window is small and trusted; on a mis-exposed host it is a takeover. Consider a one-time
setup token printed to the server log, or binding setup to loopback.

**F2 — Resource exhaustion.** *(`app.ts:423`, `cipherCache.ts`)* `/api/torrent` for a
not-yet-cached file streams the whole file through SHA + AES-256-CTR into
`P2F_CACHE_DIR`. There is no cap on cache size and no eviction — an authenticated user
can force the cache to grow to the sum of every file they request, filling the disk (the
cache is deliberately outside the possibly-read-only root, so it *is* writable). No
endpoint is rate-limited; `/api/list` on a huge directory and repeated `/api/torrent`
calls are cheap to issue and expensive to serve.

**F3 — Transfer/tracker tokens.** *(`auth.ts:114`–`122`, `app.ts:437`)* Two token
scopes: `raw:<path>` (bound to one file — good) and `tracker` (bound to nothing —
opens the signaling channel for the whole server). Both live 48 h and are embedded in
URLs (`/api/raw?...&t=`, `ws://.../tracker?t=`). URLs leak through browser history,
`Referer`, and any intermediary/proxy logs. A captured tracker token gives 48 h of swarm
access; a captured raw token gives 48 h of access to one file. The TTL is long precisely
to outlive slow downloads, which trades off against leak exposure.

**F4 — Flat authorization.** *(`app.ts:216`–`306`, `browse.ts`)* Authentication is the
only gate; there are no roles or per-user scoping of files. `/api/logs` returns the
global activity log (every user's IP, username, paths) to any authenticated caller.
Delete/move/upload act on the whole tree. This is fine for two trusted peers and
explicitly the design, but nothing in the code stops a third, less-trusted account from
seeing and doing everything — the security model degrades silently as users are added.

**F5 — CSRF / CORS.** *(`app.ts:102`–`118`)* `Access-Control-Allow-Origin: *` on `/api`,
reflecting requested headers. Cookies are `SameSite=Lax`, which blocks them on
cross-site POST, so state-changing CSRF is largely prevented — but there is no CSRF token
as defence-in-depth, and the wildcard CORS means any origin can call the API with a
Bearer token or read unauthenticated responses. Low risk given Lax cookies; worth a token
and a tighter CORS default.

**F6 — Cookie `Secure` flag.** *(`app.ts:89`)* `Secure` is added only when
`config.publicUrl` starts with `https:`. An operator who terminates TLS at a proxy but
does not set `P2F_PUBLIC_URL` (or sets it to the internal http origin) gets a session
cookie with no `Secure` flag, which can then be sent over plain HTTP.

**F7 — Upload integrity header.** *(`app.ts:366`–`395`)* The transfer key is GCM-wrapped
(authenticated), but the plaintext SHA-256 the server verifies against arrives as a
cleartext, unauthenticated header (`X-P2F-Plain-Sha256`), and the body is malleable CTR.
Against a passive observer this is fine; against an active MITM the integrity check adds
nothing (rewrite both). Consistent with the documented "no active-attacker" stance, but
the SHA belongs inside the authenticated GCM blob so the check means something whenever
the key exchange succeeds.

**F8 — Crypto cost/primitive choices.** *(`db.ts:39`)* scrypt `N=16384` is below current
OWASP guidance (`N=2^17`); cheap to raise. Download integrity relies on BitTorrent's
per-piece SHA-1 (weak, and only covers ciphertext-in-transit) plus the client-side
plaintext SHA-256 compare — acceptable, but SHA-1's presence should be understood as
transit-corruption detection, not an integrity guarantee against an adversary.

**F9 — Token/session lifecycle.** *(`db.ts:223`)* API tokens never expire and there is no
"revoke all my sessions" or token last-used surfaced to end users (only via CLI). Long
tails of live credentials with no rotation story.

**F10 — Auth-off.** *(`auth.ts:67`, `config.ts:33`)* `P2F_AUTH=off` makes
`verifyRawToken`/`verifyTrackerToken` return `true` unconditionally and opens the
standalone tracker port. Entirely by design for pure-VPN setups, recorded so it is not
forgotten: in this mode the network is the *only* boundary and every finding above that
starts with "authenticated" becomes "anyone on the network".

**F11 — Dependency hygiene.** *(`package.json`, `.github/workflows/ci.yml`)* WebTorrent,
bittorrent-tracker, express and ws bring large transitive trees. CI runs typecheck/tests
but no `npm audit`, and there is no Dependabot/renovate config in the repo. Known-CVE
drift is invisible.

**F12 — Proxy-aware client IP.** *(`app.ts`, activity logging)* Express `trust proxy` is
not set, so `req.ip` is the socket peer. Behind the documented nginx setup every logged
IP becomes the proxy's, degrading the (already non-authoritative) activity log and
breaking any future IP-based rate limiting.

## 7. What the code already gets right

Worth stating so the plan does not regress it:

- **Path traversal** is handled carefully: leading-slash stripping, `..` rejection,
  `realpath` containment checks, and — importantly — mutations use `lstat`/no-follow so
  deleting or moving a symlink acts on the link, not its target (`browse.ts`).
- **Secrets at rest**: passwords are scrypt, sessions/tokens are SHA-256, compared with
  `timingSafeEqual` (`db.ts`, `auth.ts`).
- **Transfer-key confidentiality**: ECDH-wrapped keys mean a passive observer of plain
  HTTP cannot recover file contents — a genuinely useful defence-in-depth layer
  (`keyExchange.ts`).
- **Upload safety**: streamed to a temp file, published with `fs.link` (EEXIST-safe, no
  silent overwrite), integrity-checked before publish (`app.ts:361`).
- **CTR keystream**: unique key+IV per file identity via HKDF salt, so no keystream reuse
  across files/versions (`cipherCache.ts`).
- **Deployment hardening**: non-root process via gosu, read-only mount by default,
  `x-powered-by` disabled, HttpOnly + SameSite=Lax cookies.

## 8. Remediation plan

Prioritised in three waves. Each item lists the target file(s) and a concrete change.
None of the P0/P1 items require architectural change; they harden the existing shape.

### P0 — do first (cheap, closes the widest gaps)

1. **Rate-limit auth and cap abuse (F1, F2).**
   - Add a small in-memory sliding-window limiter (no new dependency needed) keyed by IP
     for `/api/login` (e.g. 10 attempts / 5 min → 429) and a global token-bucket for
     `/api/torrent` and `/api/upload`. Keep it in `app.ts` as middleware.
   - Raise the password floor to 12 chars in `db.ts:139` and document it.
   - *Effort: ~half a day. Add tests in `test/auth.test.ts`.*

2. **Cap the ciphertext cache (F2).**
   - Add a max-size (env `P2F_CACHE_MAX_BYTES`, sane default) and LRU eviction to
     `cipherCache.ts`, evicting by last access. Never evict an entry with an in-flight
     seeder reference.
   - *Effort: ~1 day. New test in `test/`.*

3. **Fail closed on obviously-dangerous config (F0).**
   - In `config.ts`/`index.ts`: if `authEnabled === false` **and** the bind host is a
     wildcard (`0.0.0.0`/`::`) with no `P2F_PUBLIC_URL`, refuse to start unless an
     explicit `P2F_I_UNDERSTAND_NO_AUTH=1` override is set (upgrade today's log warning to
     a hard stop). Keep the compose default fail-closed.
   - *Effort: ~half a day.*

### P1 — next (meaningful hardening)

4. **Scope and shorten tracker tokens (F3).**
   - Bind the tracker token to the requesting infohash (add it to the signed scope in
     `auth.ts` and check it in the `/tracker` upgrade handler in `index.ts`). Lower the
     TTL and let the client silently re-mint on expiry (it already refetches
     `/api/torrent`). Consider moving tokens out of query strings into a short-lived
     `Sec-WebSocket-Protocol`/subprotocol value where feasible to keep them out of proxy
     logs.
   - *Effort: ~1–2 days; touches client re-mint logic.*

5. **Fix the `Secure` cookie decision (F6).**
   - Set `Secure` whenever the effective external scheme is https — derive it from
     `P2F_PUBLIC_URL` **or** `X-Forwarded-Proto` (after enabling `trust proxy`), and add
     a `P2F_SECURE_COOKIES` override. Default to on unless explicitly plain-HTTP VPN.
   - *Effort: ~half a day.*

6. **Enable `trust proxy` correctly (F12).**
   - `app.set('trust proxy', ...)` gated on a config flag so `req.ip` and forwarded
     scheme are correct behind the documented nginx proxy, without trusting the header on
     a direct-bind deployment.
   - *Effort: ~2 hours.*

7. **Move the upload SHA under the authenticated blob (F7).**
   - Include the plaintext SHA-256 inside the ECDH/GCM-wrapped payload instead of the
     cleartext `X-P2F-Plain-Sha256` header (`app.ts`, `packages/shared/src/browserCrypto.ts`).
     Then a passed integrity check actually attests something whenever key-exchange
     succeeded. Document that this still does not defeat an active MITM without TLS.
   - *Effort: ~1 day; client + server + test.*

8. **CSRF defence-in-depth + CORS tightening (F5).**
   - Add a double-submit CSRF token for cookie-authenticated POSTs, or require a custom
     header (e.g. `X-Requested-With`) that the wildcard CORS does not auto-allow for
     credentialed requests. Narrow default `Access-Control-Allow-Origin` to same-origin,
     with an opt-in env for the cross-origin-client use case.
   - *Effort: ~1 day.*

### P2 — hygiene & longer-horizon

9. **Dependency scanning (F11).** Add `npm audit --omit=dev` (non-blocking at first) to
   CI and a Dependabot config. *Effort: ~2 hours.*

10. **Bump scrypt cost (F8).** Raise `N` toward `2^17` with a stored-parameter migration
    path (the hash string already encodes N/r/p, so old hashes keep verifying and can be
    upgraded on next login). *Effort: ~half a day.*

11. **Credential lifecycle (F9).** Add API-token expiry (optional TTL) and a
    "revoke all sessions" action; surface token last-used in the UI. *Effort: ~1 day.*

12. **Setup hardening (F1a).** Gate `/api/setup` behind a one-time token printed to the
    server log on first boot, or restrict it to loopback. *Effort: ~half a day.*

13. **Introduce a minimal role split (F4)** *(only if multi-user beyond two peers becomes
    a goal):* a read-only vs read-write role, and restrict `/api/logs` to an admin role.
    Until then, document loudly that every account is effectively admin. *Effort: larger;
    defer unless the use case appears.*

### Documentation follow-ups (independent of code)

- Add a "deploying safely" checklist to the README that an operator can tick off (bind
  IP, mount mode, TLS/`Secure`, cache dir permissions, DB file permissions).
- State explicitly that `P2F_DB` holds long-lived secrets in plaintext and must be
  permissioned accordingly.

## 9. Residual risk (accepted by design)

These are conscious trade-offs, not gaps to fix — listed so they are not mistaken for
oversights:

- The server can read plaintext files (not zero-knowledge storage).
- No protection against an **active** on-path attacker without TLS/VPN.
- Flat trust among authenticated users in the intended two-peer model.
- In-memory activity log is operational, not an audit trail.
- `P2F_AUTH=off` intentionally reduces the trust boundary to the network alone.

# peer-to-file desktop app

A native desktop client for the peer-to-file server, for people who'd rather
not open a browser (Windows/macOS/Linux, via [Electron](https://electronjs.org)).

**This is a separate, additional client.** The original browser web app in
`client/` and the server in `src/server/` are unchanged — you still need a
running peer-to-file server (see the repo root README) for the app to talk
to. Nothing here touches that server's code or API; the app is a pure
consumer of the existing HTTP API.

```
apps/
  desktop/   Electron app — Windows, macOS, Linux
  scripts/   version-bump helper used by CI
packages/
  shared/    API client, types and theme tokens used by the app
```

## Real P2P transfers

The browser web client downloads files via real WebTorrent peer-to-peer
transfer (WebRTC + an HTTP webseed fallback), using browser-only tech —
service workers, the File System Access API. Electron wraps a real Chromium
renderer, so `apps/desktop` runs that exact same WebTorrent client and gets
real P2P transfer, same as the web app:

- The renderer is served from a custom `p2file://` scheme (registered
  `standard`/`secure`/`allowServiceWorkers` in `electron/main.cts`) rather
  than `file://`, so it qualifies as a secure context for both the service
  worker (streamed saves) and the File System Access API
  (`showSaveFilePicker`), exactly like the browser app's own origin does.
- The main process's `session.on('will-download', …)` hook
  (`electron/main.cts`) redirects a finished download into your configured
  default download folder instead of Electron's own default Downloads dir
  or a native Save As prompt.

## Authentication

The server's only client-facing auth flow is a login endpoint that sets a
session cookie — there's no self-serve "give me an API token" endpoint (API
tokens are CLI-provisioned only), and CORS (`Access-Control-Allow-Origin: *`)
blocks credentialed cookie requests from a renderer whose origin will never
match the user's server URL. The app works around this without needing any
server change: every API call is routed through the **main process**
(`electron/netFetch.cts`), which runs Node's own `fetch` with an in-memory
per-origin cookie jar — no CORS enforcement applies there, since it isn't a
browser navigation context.

The cookie jar doesn't survive an app restart, so the app additionally saves
the username/password using Electron's `safeStorage` API (Keychain /
Credential Manager / Secret Service under the hood — the same OS-level
backing a Rust `keyring` crate would use) and silently re-logs in with it
whenever a request comes back 401. That's what satisfies "auto login when
needed" and "disconnect" — logging out clears both the server session and
the stored credentials.

## Settings

The Settings screen covers:

- **Server URL** — re-enter/change it without losing your other settings.
- **Default download folder** — a real, user-chosen folder, redirected into
  via the `will-download` hook described above.
- **Theme** — System / Light / Dark, backed by the same color tokens in
  `packages/shared/src/theme.ts`.

A small colored dot + label (Settings screen and the main header) shows
connected/disconnected — the app polls `/api/info` every ~10s.

## Developing

```sh
cd apps/desktop
npm install
npm run dev     # starts the Vite dev server, then launches Electron once it's up
```

`npm run build` produces a native installer (`.dmg`, `.exe`, `.deb`/
`.AppImage`) under `release/`, via `electron-builder`. App icons for every
platform are generated automatically from the single `icon-source.png` at
build time — no separate icon-generation step needed.

### Shared code (`packages/shared`)

Plain TypeScript, no build step — the app consumes it directly from source
via a `file:` dependency (`npm install` symlinks it into
`node_modules/@p2f/shared`). Edit it once, both this app and the browser
client (`client/`) see the change.

## CI/CD

Two ad-hoc (`workflow_dispatch`-only) GitHub Actions workflows, neither of
which runs automatically on push/PR:

- **`.github/workflows/apps-build.yml`** — builds unsigned Electron desktop
  bundles for macOS/Windows/Linux, uploaded as workflow artifacts. Trigger it
  from the Actions tab: pick a **branch** (a text input — branch name, tag,
  or commit SHA; defaults to `main`) to build from. These are dev/sideload
  builds — real signing (Apple Developer ID + notarization, Windows
  Authenticode) needs your own credentials wired in as repo secrets, which
  isn't set up here; macOS bundles instead get a *deep* ad-hoc signature via
  an `afterPack` hook (`electron/afterpack.mjs`) — see "Opening the macOS
  build" below for exactly what that does and doesn't fix.
- **`.github/workflows/apps-version-bump.yml`** — bumps `apps/desktop` and
  `packages/shared` versions together (patch/minor/major, your choice at
  trigger time), and pushes a commit + `apps-vX.Y.Z` tag. Doesn't touch the
  root project's own version.

### Opening the macOS build

Two separate Gatekeeper checks apply to a downloaded macOS app, and it's
worth telling them apart:

1. **"Is the code signature internally consistent?"** electron-builder's own
   automatic signing only covers the outer `.app` bundle, leaving nested
   frameworks/helpers (the Electron Framework, helper processes, ...)
   inconsistently signed relative to it — and *that* mismatch, not simply
   "unsigned", is what produces the harsh, unrecoverable **"P2File is
   damaged and can't be opened"** dialog (not an actual corrupted download).
   `electron/afterpack.mjs` fixes this specifically, by re-signing the whole
   bundle as one unit with `codesign --deep --force --sign -` (ad-hoc — no
   certificate needed) after electron-builder packs it.
2. **"Was this quarantined download notarized by Apple?"** Downloading a
   file through a browser (including GitHub's own artifact download) adds a
   quarantine flag, and *no* ad-hoc signature — deep or otherwise — satisfies
   Apple's notarization requirement for a quarantined app. This is real
   notarization territory, which needs a paid Apple Developer account's
   certificate that isn't configured here. It shows as the milder
   **"P2File" can't be opened because Apple cannot check it for malicious
   software** dialog, which — unlike "damaged" — has a normal **Open
   Anyway** path.

So after the `afterPack` fix, opening the build is a right-click → **Open**
→ **Open** again in the confirmation dialog (works on most macOS versions).
If you still see "damaged" rather than "unidentified developer"/"cannot be
checked", fall back to:

```sh
xattr -cr /Applications/P2File.app   # after copying it out of the mounted .dmg
```

Real notarization (removing the prompt entirely) needs your own Apple
Developer credentials wired in as repo secrets — not something CI can do
without them.

## Known limitations (v1)

- Downloads don't persist an in-progress transfer across quitting the app
  entirely — pause/resume/cancel all work fine while the app is running,
  same as the web client, but closing the app and reopening it starts a
  re-download rather than resuming mid-file. (Pieces *are* held in the same
  OPFS store the web client uses, but for space rather than persistence:
  only a store the app owns can free pieces one at a time while the final
  file is being written. Whatever a previous session left behind is wiped on
  startup.)
- Uploads read the whole file into memory before sending (there's no
  signed-token/streamed upload path the way there is for downloads) — fine
  for the file sizes this project targets, but worth knowing before
  uploading something enormous.

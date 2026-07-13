# peer-to-file native apps

Native clients for the peer-to-file server, for people who'd rather not open a
browser: a desktop app (Windows/macOS/Linux, via [Tauri](https://tauri.app))
and a mobile app (iOS/Android, via [Expo](https://expo.dev)/React Native).

**These are separate, additional clients.** The original browser web app in
`client/` and the server in `src/server/` are unchanged — you still need a
running peer-to-file server (see the repo root README) for either app to
talk to. Nothing here touches that server's code or API; both apps are pure
consumers of the existing HTTP API.

```
apps/
  mobile/    Expo (React Native) app — iOS + Android
  desktop/   Tauri app — Windows, macOS, Linux
  scripts/   version-bump helper used by CI
packages/
  shared/    API client, types and theme tokens used by both apps
```

## Why two different transports

The browser web client downloads files via real WebTorrent peer-to-peer
transfer (WebRTC + an HTTP webseed fallback), using browser-only tech —
service workers, OPFS, the File System Access API. That doesn't exist
uniformly across native runtimes:

- **Desktop (Tauri)** wraps a real OS webview (WebView2 / WKWebView /
  WebKitGTK), which *is* a browser engine, so `apps/desktop` runs the actual
  WebTorrent client and gets real P2P transfer, same as the web app. A
  native `on_download` hook (`src-tauri/src/main.rs`) redirects the
  webview's download into your configured default download folder instead
  of the OS's own Downloads dir.
- **Mobile (Expo/React Native)** has no DOM, no service worker, and no
  production-grade WebRTC torrent engine available — building one from
  scratch was out of scope. `apps/mobile` instead downloads/uploads over
  the server's plain HTTP endpoints (`/api/raw` webseed with Range support
  for resumable downloads, `/api/upload` for uploads) — the same fallback
  path the server already exposes for exactly this kind of client. Every
  *feature* is still there (browse, download, upload, rename, move, delete,
  history, logs) — only the download's transport differs.

Both apps are otherwise at feature parity with the web client, plus the
things a native app needs that a same-origin web page doesn't: a server
address field, persistent login, a connection indicator, and a settings
screen.

## Authentication

The server's only client-facing auth flow is a login endpoint that sets a
session cookie — there's no self-serve "give me an API token" endpoint (API
tokens are CLI-provisioned only), and CORS (`Access-Control-Allow-Origin: *`)
blocks credentialed cookie requests from a webview whose origin will never
match the user's server URL. Both apps work around this without needing any
server change:

- **Desktop** routes all API calls through `@tauri-apps/plugin-http`, which
  executes them via a Rust `reqwest` client rather than the webview's own
  networking stack — no CORS enforcement applies, and it keeps its own
  cookie jar for the life of the app process.
- **Mobile** uses React Native's own `fetch`, which (unlike a browser or
  webview) doesn't enforce CORS at all.

Neither cookie jar survives an app restart, so both apps additionally save
the username/password in the OS keychain (`expo-secure-store` on mobile, the
Rust `keyring` crate — Keychain / Credential Manager / Secret Service — on
desktop) and silently re-login with it whenever a request comes back 401.
That's what satisfies "auto login when needed" and "disconnect" — logging
out clears both the server session and the stored credentials.

## Settings

Both apps have a Settings screen for:

- **Server URL** — re-enter/change it without losing your other settings.
- **Default download folder** — a real, user-chosen folder on desktop and
  Android (Storage Access Framework); iOS apps can't be granted free access
  to an arbitrary folder, so downloads land in the app's own Documents
  folder, which is visible from the Files app.
- **Theme** — System / Light / Dark, backed by the same color tokens in
  `packages/shared/src/theme.ts` on both platforms.

A small colored dot + label (Settings screen and the main header) shows
connected/disconnected — the apps poll `/api/info` every ~10s.

## Developing

### Mobile (`apps/mobile`)

```sh
cd apps/mobile
npm install
npx expo run:android   # or: npx expo run:ios  (needs Xcode, macOS only)
```

This runs `expo prebuild` under the hood the first time, generating the
native `ios/`/`android/` projects locally and building through Gradle/Xcode
directly — **no EAS Build, no Expo account needed.** Those generated
folders are gitignored; CI (and your own machine) regenerates them fresh
every time from `app.json`.

### Desktop (`apps/desktop`)

```sh
cd apps/desktop
npm install
npm run dev     # tauri dev — needs the Rust toolchain (https://rustup.rs)
                # and, on Linux, libwebkit2gtk-4.1-dev + friends (see
                # .github/workflows/apps-build.yml for the exact apt list)
```

`npm run build` produces a native installer (`.dmg`, `.msi`/`.exe`, `.deb`/
`.AppImage`) under `src-tauri/target/release/bundle/`. App icons are
generated from the single `icon-source.png` via `npm run icons`
(`predev`/`prebuild` run this automatically).

### Shared code (`packages/shared`)

Plain TypeScript, no build step — both apps consume it directly from source
via a `file:` dependency (`npm install` symlinks it into each app's
`node_modules/@p2f/shared`). Edit it once, both apps see the change.

## CI/CD

Two ad-hoc (`workflow_dispatch`-only) GitHub Actions workflows, neither of
which runs automatically on push/PR:

- **`.github/workflows/apps-build.yml`** — builds an unsigned Android debug
  APK, an unsigned iOS Simulator build, and Tauri desktop bundles for
  macOS/Windows/Linux, uploaded as workflow artifacts. Trigger it from the
  Actions tab: pick a **branch** (a text input — branch name, tag, or commit
  SHA; defaults to `main`) to build from, and toggle which platforms to
  build. These are dev/sideload builds — real signing (Android keystore,
  Apple Developer ID + notarization, Windows Authenticode) needs your own
  credentials wired in as repo secrets, which isn't set up here; macOS
  bundles are ad-hoc signed (`signingIdentity: "-"` in `tauri.conf.json`)
  so they at least *open* on Apple Silicon — see "Opening the macOS build"
  below.
- **`.github/workflows/apps-version-bump.yml`** — bumps `apps/mobile`,
  `apps/desktop` and `packages/shared` versions together (patch/minor/major,
  your choice at trigger time), plus each platform's own build-number
  fields (iOS `buildNumber`, Android `versionCode`), and pushes a commit +
  `apps-vX.Y.Z` tag. Doesn't touch the root project's own version.

### Opening the macOS build

The `.dmg` from `apps-build.yml` is **ad-hoc signed, not Apple-notarized**
(that needs a paid Apple Developer account's certificate, which isn't
configured here) — macOS Gatekeeper will still refuse to open it normally.
Downloading it through a browser (including GitHub's own artifact download)
adds a quarantine flag that, combined with no notarization, is exactly what
produces the misleading **"P2File is damaged and can't be opened"** dialog
(not an actual corruption — this is Gatekeeper's message for
"unnotarized + quarantined", regardless of the app being ad-hoc signed).

To open it anyway:

```sh
xattr -cr /Applications/P2File.app   # after copying it out of the mounted .dmg
```

or right-click the app → **Open** → **Open** again in the confirmation
dialog (works on most macOS versions; if you still see "damaged" rather
than "unidentified developer", use the `xattr` command instead). This is a
one-time step per download — it's inherent to distributing an unsigned/
non-notarized app, not something CI can fix without your own Apple
Developer credentials.

## Known limitations (v1)

- Mobile downloads/uploads are plain HTTP, not P2P — see "Why two different
  transports" above.
- Desktop downloads don't persist an in-progress transfer across quitting
  the app entirely (no OPFS-equivalent piece store) — pause/resume/cancel
  all work fine while the app is running, same as the web client, but
  closing the app and reopening it starts a re-download rather than
  resuming mid-file.
- Uploads on both platforms read the whole file into memory before sending
  (there's no signed-token/streamed upload path the way there is for
  downloads) — fine for the file sizes this project targets, but worth
  knowing before uploading something enormous from a memory-constrained
  device.

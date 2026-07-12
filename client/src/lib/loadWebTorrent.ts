// The WebTorrent browser bundle is ESM and huge (bundles crypto/stream
// polyfills for the browser) — served pre-built from node_modules by the
// server (see src/server/app.ts) rather than routed through Vite. Loaded at
// runtime with a plain `import()` against an absolute URL so the bundler
// doesn't try to resolve it at build time, and exposed as `window.WebTorrent`
// (see webtorrent-types.d.ts) for downloadManager.ts to pick up.
let loaded: Promise<void> | null = null

// A non-literal specifier keeps TS from trying (and failing) to resolve this
// as a real module path at build time — it's only ever a runtime URL.
async function importVendorBundle (path: string): Promise<{ default: typeof window.WebTorrent }> {
  return import(/* @vite-ignore */ path)
}

export function loadWebTorrent (): Promise<void> {
  loaded ??= importVendorBundle('/vendor/webtorrent.min.js').then(mod => {
    window.WebTorrent = mod.default
  })
  return loaded
}

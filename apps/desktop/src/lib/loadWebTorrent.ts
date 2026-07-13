let loaded: Promise<void> | null = null

// Non-literal specifier so the bundler doesn't try (and fail) to resolve
// this as a real module at build time — it's only ever a runtime URL served
// from public/vendor (see scripts/copy-vendor.mjs).
async function importVendorBundle (path: string): Promise<{ default: typeof window.WebTorrent }> {
  return import(/* @vite-ignore */ path)
}

export function loadWebTorrent (): Promise<void> {
  loaded ??= importVendorBundle('/vendor/webtorrent.min.js').then(mod => {
    window.WebTorrent = mod.default
  })
  return loaded
}

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative asset base so the built `dist/index.html` works when served from
// the custom `p2file://app/` scheme in production (see electron/main.cts) —
// an absolute `/assets/...` base would resolve against the scheme's root
// fine too, but relative keeps this buildable as a plain static site for
// local inspection as well.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 1420,
    strictPort: true
  }
})

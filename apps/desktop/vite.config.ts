import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri-specific tuning per https://v2.tauri.app/start/frontend/vite/ —
// fixed dev port matching tauri.conf.json's devUrl, and don't let Vite's
// own error overlay/HMR fight with the webview.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG
  }
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client is built as a static single-page app and served by the Express
// server from client/dist — see src/server/app.ts. `npm run dev:client`
// proxies API/tracker/vendor requests to a server running separately on
// :8000 (`npm start`) for fast-refresh development.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/vendor': 'http://localhost:8000',
      '/sw.js': 'http://localhost:8000',
      '/tracker': { target: 'ws://localhost:8000', ws: true }
    }
  }
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: Vite serves the client on :5173 and proxies WebSocket traffic to the
// game server on :8177. Prod: `npm run build` then `npm start` — the game
// server serves dist/ itself, so client and WS share one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8177',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})

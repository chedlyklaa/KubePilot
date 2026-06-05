import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Required for SSE — disable proxy timeout so long-running streams
        // (minikube start can take 5+ minutes) are not killed mid-flight.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
})

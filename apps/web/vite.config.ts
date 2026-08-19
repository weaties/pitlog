import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // SPEC §6.1: the pit client is the same web app as an installable PWA.
      registerType: 'autoUpdate',
      workbox: {
        // Single static shell; API calls are never cached by the service
        // worker. Offline reads/writes go through @pitlog/sync + IndexedDB so
        // the queue is inspectable, not hidden inside Workbox.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      },
      manifest: {
        name: 'PitLog',
        short_name: 'PitLog',
        description: 'Endurance race logging and pit-wall management',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
    }),
  ],
  server: { port: 5173 },
  preview: { port: 5173 },
})

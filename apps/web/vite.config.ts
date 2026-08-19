import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // One .env at the repo root for the whole monorepo, so the web app and the
  // API cannot disagree about which API URL is in play.
  envDir: '../..',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // SPEC §6.1: the pit client is the same web app as an installable PWA.
      //
      // 'prompt', not 'autoUpdate'. autoUpdate activates a new service worker
      // and reloads the page as soon as a deploy lands, which mid-race means
      // the pit wall blanks while someone is mid-entry — the exact "stranded
      // on a half-updated shell" failure #25 exists to prevent. The crew is
      // asked instead, and can say "not now" until the car is on track.
      registerType: 'prompt',
      workbox: {
        // Single static shell; API calls are never cached by the service
        // worker. Offline reads/writes go through @pitlog/sync + IndexedDB so
        // the queue is inspectable, not hidden inside Workbox.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Nothing under /api is ever served from the cache. Offline reads come
        // from IndexedDB where they are inspectable and mergeable; a stale API
        // response hidden inside Workbox is a bug you cannot see.
        runtimeCaching: [],
      },
      manifest: {
        name: 'PitLog',
        short_name: 'PitLog',
        description: 'Endurance race logging and pit-wall management',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        start_url: '/',
        // Installability is not decoration: without these the browser silently
        // refuses to offer "Add to Home Screen", and the pit client is only
        // usable offline once it is installed.
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: { port: 5173 },
  // A separate port from dev so the offline browser test can run against a
  // real build with a real service worker, without stopping the dev server.
  preview: { port: 4173 },
})

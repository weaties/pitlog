import { serve } from '@hono/node-server'
import 'dotenv/config'
import { createApp } from './app.js'
import { loadEnv } from './env.js'

const env = loadEnv()
const app = createApp({ appOrigin: env.APP_ORIGIN })

serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  // biome-ignore lint/suspicious/noConsole: process startup banner
  console.log(`pitlog api listening on http://localhost:${info.port}`)
})

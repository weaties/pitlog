import { serve } from '@hono/node-server'
import { createDb } from '@pitlog/db'
import { createApp } from './app.js'
import { loadEnv } from './env.js'

const env = loadEnv()
const { db } = createDb({ databaseUrl: env.DATABASE_URL })

const app = createApp({
  db,
  appOrigin: env.APP_ORIGIN,
  apiOrigin: `http://localhost:${env.API_PORT}`,
  mailTransport: env.MAIL_TRANSPORT,
  secureCookies: env.NODE_ENV === 'production',
})

serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  // biome-ignore lint/suspicious/noConsole: process startup banner
  console.log(`pitlog api listening on http://localhost:${info.port}`)
})

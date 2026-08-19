import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'
import { requireDatabaseUrl } from './load-env.js'

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')

// max: 1 — a migration runner must not hold a pool open, or the process hangs.
const { db, close } = createDb({ databaseUrl: requireDatabaseUrl(), max: 1 })

try {
  await migrate(db, { migrationsFolder })
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('migrations applied')
} finally {
  await close()
}

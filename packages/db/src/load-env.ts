import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

/**
 * Loads the repo-root `.env`.
 *
 * The db scripts run with cwd = `packages/db`, so plain `dotenv/config` would
 * look in the wrong place and produce a confusing "DATABASE_URL is required"
 * when the file is sitting right there at the root. One `.env` for the whole
 * monorepo is deliberate: the API, the migrator, and the seeder must agree on
 * which database they are pointing at.
 */
export function loadRootEnv(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  config({ path: resolve(root, '.env'), quiet: true })
}

/** The database URL, or a clear failure naming how to fix it. */
export function requireDatabaseUrl(): string {
  loadRootEnv()
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env (or run `make dev`).')
  }
  return url
}

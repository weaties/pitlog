import { defineConfig } from 'drizzle-kit'
import { requireDatabaseUrl } from './src/load-env.js'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: requireDatabaseUrl() },
  // Migrations are forward-only and committed to git. Never edit a migration
  // that has already been applied anywhere — add a new one.
  strict: true,
  verbose: true,
})

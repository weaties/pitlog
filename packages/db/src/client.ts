import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

export interface DbOptions {
  databaseUrl: string
  /** Keep this at 1 for CLI scripts (migrate/seed) so the process can exit. */
  max?: number
  /** Swallow Postgres NOTICE output. The seed's `truncate ... cascade` emits
   *  one notice per reached table, which buries the actual progress log. */
  quiet?: boolean
}

/**
 * Opens a Drizzle client over postgres.js.
 *
 * Callers own the lifetime: hold one per process and `close()` it on shutdown.
 * Every query in the app must be scoped by `team_id` — see the `data-model`
 * skill; there is no ambient tenant in this client by design, so forgetting the
 * scope is visible in the query rather than hidden in a wrapper.
 */
export function createDb(options: DbOptions) {
  const sql = postgres(options.databaseUrl, {
    max: options.max ?? 10,
    ...(options.quiet ? { onnotice: () => {} } : {}),
  })
  const db = drizzle(sql)
  return { db, sql, close: () => sql.end({ timeout: 5 }) }
}

export type Db = ReturnType<typeof createDb>['db']

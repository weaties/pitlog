import { z } from 'zod'

/**
 * Process configuration. Parsed once at startup so a missing or malformed
 * variable fails the boot rather than the first request that needs it.
 */
const envSchema = z.object({
  DATABASE_URL: z.url(),
  API_PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  /** 32+ bytes of entropy. Signs session cookies and hashes magic-link tokens. */
  AUTH_SECRET: z.string().min(32),
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment:\n${issues}\n\nSee .env.example.`)
  }
  return parsed.data
}

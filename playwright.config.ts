import { defineConfig, devices } from '@playwright/test'

const WEB_PORT = 5173
/** A production build with a live service worker, for the offline test. */
const PREVIEW_PORT = 4173
const API_PORT = Number(process.env.API_PORT ?? 8787)

/**
 * Browser smoke tests. Deliberately thin — they prove the app boots, a user can
 * log in, and the shell renders. Behavioural depth belongs in Vitest against
 * the domain packages, which run in milliseconds.
 *
 * Assumes a migrated + seeded database is reachable at DATABASE_URL
 * (`make up && make migrate && make seed`). CI does this in the smoke job.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Serial in CI: one Postgres, one seeded dataset.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run start -w @pitlog/api',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -w @pitlog/web',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The service worker only exists in a build, and "does it open with the
      // network off" is the one claim the PWA has to make (#25). Testing it
      // against the dev server would prove nothing.
      command: 'npm run build -w @pitlog/web && npm run preview -w @pitlog/web',
      url: `http://localhost:${PREVIEW_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})

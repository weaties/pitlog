import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests only. Browser smoke tests live in tests/e2e and run under Playwright.
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    environment: 'node',
  },
})

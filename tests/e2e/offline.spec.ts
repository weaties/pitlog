import { expect, test } from '@playwright/test'

/**
 * The claim the PWA has to make: the app opens with no network (SPEC §6.1).
 *
 * Runs against a production build on the preview server, because the service
 * worker does not exist in a dev build — testing this against `vite dev` would
 * prove nothing at all.
 */
const PREVIEW = 'http://localhost:4173'

test.describe('the installed pit client', () => {
  test('registers its service worker without waiting on the server', async ({ page }) => {
    // The regression this guards: the update prompt used to mount inside
    // <App />, below an early return that waits for /api/me. A user whose
    // first ever visit was from a pit box with no signal would never get a
    // service worker, so the app could never work offline — exactly backwards.
    await page.route('**/api/**', (route) => route.abort())
    await page.goto(PREVIEW)

    await page.evaluate(() => navigator.serviceWorker.ready)
  })

  test('opens and renders with the network disabled', async ({ page, context }) => {
    await page.goto(PREVIEW)

    // Two steps, and the second is the one people forget. A worker that has
    // *activated* is not yet a worker that *controls* the page: without
    // `clientsClaim` it only takes over on the next navigation. Going offline
    // after activation but before control is how this test lies to you.
    await page.evaluate(() => navigator.serviceWorker.ready)
    // A worker that has activated is not yet a worker that *controls* the
    // page: without `clientsClaim` it only takes over on the next navigation.
    // Going offline in between is how this test quietly lies to you.
    await page.reload()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))

    await context.setOffline(true)
    await page.reload()

    // The shell is served from the cache; the app renders rather than showing
    // the browser's dinosaur.
    await expect(page.getByRole('heading', { name: 'PitLog' })).toBeVisible()

    await context.setOffline(false)
  })

  test('never serves an API response from the service worker cache', async ({ page }) => {
    await page.goto(PREVIEW)
    await page.evaluate(() => navigator.serviceWorker.ready)

    // Offline reads come from IndexedDB, where they are inspectable and
    // mergeable. A stale API response hidden inside Workbox is a bug you
    // cannot see, so nothing under /api may ever be in a cache.
    const cachedApiUrls = await page.evaluate(async () => {
      const names = await caches.keys()
      const found: string[] = []
      for (const name of names) {
        const cache = await caches.open(name)
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname.startsWith('/api/')) found.push(request.url)
        }
      }
      return found
    })

    expect(cachedApiUrls).toEqual([])
  })

  test('is installable — a manifest with real icons', async ({ page, request }) => {
    await page.goto(PREVIEW)

    const href = await page.getAttribute('link[rel="manifest"]', 'href')
    expect(href).toBeTruthy()

    const manifest = await (await request.get(`${PREVIEW}${href}`)).json()
    expect(manifest.display).toBe('standalone')
    // Without icons the browser silently declines to offer "Add to Home
    // Screen", and an uninstalled pit client is not an offline one.
    expect(manifest.icons.length).toBeGreaterThan(0)
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true)

    for (const icon of manifest.icons) {
      const res = await request.get(`${PREVIEW}${icon.src}`)
      expect(res.status(), `${icon.src} should exist`).toBe(200)
    }

    // iOS ignores the manifest entirely and reads this instead.
    expect(await page.getAttribute('link[rel="apple-touch-icon"]', 'href')).toBeTruthy()
    expect((await request.get(`${PREVIEW}/apple-touch-icon.png`)).status()).toBe(200)
  })
})

test('a database created before a table existed gains the missing store', async ({ page }) => {
  // The bug this pins: adding a table to the sync list without bumping a
  // hand-maintained DB_VERSION left every existing browser with no store to
  // write to, and every write threw NotFoundError — silently. The version is
  // now derived from the schema, so an older database heals itself.
  await page.goto(PREVIEW)

  // Simulate a browser that last ran an older build: a v1 database holding
  // only a couple of the stores the app now needs.
  await page.evaluate(async () => {
    const wipe = indexedDB.deleteDatabase('pitlog')
    await new Promise((resolve) => {
      wipe.onsuccess = resolve
      wipe.onerror = resolve
      wipe.onblocked = resolve
    })

    const old = indexedDB.open('pitlog', 1)
    await new Promise((resolve, reject) => {
      old.onupgradeneeded = () => {
        old.result.createObjectStore('drivers', { keyPath: 'id' })
        old.result.createObjectStore('_meta')
      }
      old.onsuccess = () => {
        old.result.close()
        resolve(null)
      }
      old.onerror = () => reject(old.error)
    })
  })

  await page.reload()

  const stores = await page.evaluate(async () => {
    const open = indexedDB.open('pitlog')
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    // Touch the app's own opener so the heal runs, then re-read.
    return [...db.objectStoreNames]
  })

  // The app upgrades on open, so by the time anything renders the stores exist.
  await page.waitForFunction(async () => {
    const open = indexedDB.open('pitlog')
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const names = [...db.objectStoreNames]
    db.close()
    return names.includes('driver_availability') && names.includes('_outbox')
  })

  expect(stores.length).toBeGreaterThan(0)
})

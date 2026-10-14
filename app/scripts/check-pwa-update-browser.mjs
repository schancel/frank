// Optional browser gate; uses a separately installed Playwright without changing
// application dependencies. Example:
// npm install --prefix /tmp/frank-pwa-browser playwright
// /tmp/frank-pwa-browser/node_modules/.bin/playwright install firefox
// FRANK_BROWSER_TEST_PACKAGE=/tmp/frank-pwa-browser/package.json node app/scripts/check-pwa-update-browser.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const require = createRequire(
  process.env.FRANK_BROWSER_TEST_PACKAGE || import.meta.url,
)
const { firefox } = require('playwright')
const dir = fileURLToPath(new URL('../dist/pwa/', import.meta.url))
const original = readFileSync(dir + 'sw.js', 'utf8')
async function scenario(force) {
  let release = 1
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const path = req.url.split('?')[0]
    if (path === '/sw.js') {
      let sw = original.replace(
        /precacheAndRoute\(\[[\s\S]*?\],\{\}\)/,
        `precacheAndRoute(${JSON.stringify([
          { url: 'index.html', revision: String(release) },
          { url: `assets/lazy-${release}.js`, revision: null },
        ])},{})`,
      )
      if (force)
        sw = sw.replace('"use strict";', '"use strict";self.skipWaiting();')
      res.setHeader('Content-Type', 'application/javascript')
      res.end(sw)
      return
    }
    if (path === '/push-sw.js' || /workbox-.*\.js/.test(path)) {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(readFileSync(dir + path.slice(1)))
      return
    }
    if (path === `/assets/lazy-${release}.js`) {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(`export default ${release}`)
      return
    }
    res.setHeader('Content-Type', 'text/html')
    if (path !== '/' && path !== '/index.html') res.statusCode = 404
    res.end('<!doctype html><title>Release ' + release + '</title>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const browser = await firefox.launch()
  try {
    const page = await browser.newPage()
    const origin = `http://127.0.0.1:${server.address().port}`
    await page.goto(origin)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
    })
    await page.reload()
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    )
    await page.evaluate(() => {
      window.controllerChanged = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.controllerChanged = true
      })
    })
    release = 2
    await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration()
      await r.update()
    })
    if (force) {
      await page.waitForFunction(() => window.controllerChanged)
      await page.waitForFunction(async () => {
        const r = await navigator.serviceWorker.getRegistration()
        return !r.installing && !r.waiting
      })
      await page.waitForFunction(
        async () => !(await caches.match('/assets/lazy-1.js')),
      )
    } else {
      await page.waitForFunction(async () =>
        Boolean((await navigator.serviceWorker.getRegistration()).waiting),
      )
    }
    const result = await page.evaluate(async () => {
      try {
        return { value: (await import('/assets/lazy-1.js')).default }
      } catch (e) {
        return { error: String(e) }
      }
    })
    if (force) assert(result.error, JSON.stringify(result))
    else assert.equal(result.value, 1)
    console.log(JSON.stringify({ forceSkipWaiting: force, result }))
    if (!force) {
      await page.evaluate(async () =>
        (
          await navigator.serviceWorker.getRegistration()
        ).waiting.postMessage({ type: 'SKIP_WAITING' }),
      )
      await page.waitForFunction(
        async () => !(await navigator.serviceWorker.getRegistration()).waiting,
      )
      await page.waitForFunction(() => window.controllerChanged)
      await page.reload()
      assert.equal(
        await page.evaluate(
          async () => (await import('/assets/lazy-2.js')).default,
        ),
        2,
      )
      console.log('Explicit update activates release 2 and its lazy module')
    }
  } finally {
    await browser.close()
    await new Promise(r => server.close(r))
  }
}
;(async () => {
  await scenario(true)
  await scenario(false)
})().catch(e => {
  console.error(e)
  process.exit(1)
})

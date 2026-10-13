import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Inspect the generated worker, rather than assuming Workbox accepted the config.
const output = new URL('../dist/pwa/', import.meta.url)
const manifest = JSON.parse(
  readFileSync(new URL('manifest.json', output), 'utf8'),
)
assert.equal(manifest.name, 'Frank')
assert.equal(manifest.display, 'standalone')
for (const size of ['192x192', '512x512']) {
  const icon = manifest.icons.find(icon => icon.sizes === size)
  assert(icon && existsSync(new URL(icon.src, output)), `Missing ${size} icon`)
}
let precache = []
const routes = []
let forcedActivation = false
class NavigationRoute {
  constructor(handler) {
    this.handler = handler
  }
}
const workbox = {
  setCacheNameDetails() {},
  clientsClaim() {},
  cleanupOutdatedCaches() {},
  precacheAndRoute(entries) {
    precache = entries
  },
  createHandlerBoundToURL(url) {
    return url
  },
  NavigationRoute,
  registerRoute(route) {
    routes.push(route)
  },
}
vm.runInNewContext(readFileSync(new URL('sw.js', output), 'utf8'), {
  self: {
    define() {},
    addEventListener() {},
    skipWaiting() {
      forcedActivation = true
    },
  },
  define(_dependencies, factory) {
    factory(workbox)
  },
})
assert(
  forcedActivation,
  'The service worker must activate immediately on reload via skipWaiting',
)
assert.equal(routes.length, 1)
assert(
  routes[0] instanceof NavigationRoute,
  'No runtime API caching is allowed',
)
assert.equal(routes[0].handler, 'index.html')
const urls = new Set(precache.map(entry => entry.url))
assert(urls.has('index.html'))
for (const url of urls) {
  assert(!url.endsWith('.map'), `Source map in precache: ${url}`)
  assert(!/^https?:/.test(url), `Remote response in precache: ${url}`)
  assert(existsSync(new URL(url, output)), `Missing precached file: ${url}`)
}
// Workbox otherwise only warns when a large JS chunk is omitted, producing a broken offline shell.
for (const asset of readdirSync(new URL('assets/', output))) {
  if (/\.(js|css|wasm)$/.test(asset)) {
    assert(urls.has(`assets/${asset}`), `Offline dependency omitted: ${asset}`)
  }
}
console.log(
  `PWA artifact checks passed (${urls.size} static assets in ${fileURLToPath(
    output,
  )})`,
)

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
assert.equal(
  manifest.orientation,
  'any',
  'Installed Frank must allow both portrait and landscape rotation',
)
for (const size of ['192x192', '512x512']) {
  const icon = manifest.icons.find(icon => icon.sizes === size)
  assert(icon && existsSync(new URL(icon.src, output)), `Missing ${size} icon`)
}
const indexHtml = readFileSync(new URL('index.html', output), 'utf8')
assert(
  indexHtml.includes('rel="manifest"') && indexHtml.includes('manifest.json'),
  'Built index.html must link manifest.json',
)
assert(
  !indexHtml.includes('name="theme-color"'),
  'Built index.html must not include <meta name="theme-color"> (prevents Safari 26 floating toolbar overlay shift)',
)
let precache = []
const routes = []
const importedScripts = []
let forcedActivation = false
const workerListeners = new Map()
class NavigationRoute {
  constructor(handler, { denylist = [] } = {}) {
    this.handler = handler
    this.denylist = denylist
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
function recordImportScripts(...scripts) {
  importedScripts.push(...scripts)
}
vm.runInNewContext(readFileSync(new URL('sw.js', output), 'utf8'), {
  importScripts: recordImportScripts,
  self: {
    define() {},
    addEventListener(type, listener) {
      workerListeners.set(type, listener)
    },
    importScripts: recordImportScripts,
    skipWaiting() {
      forcedActivation = true
    },
  },
  define(_dependencies, factory) {
    factory(workbox)
  },
})
assert(
  !forcedActivation,
  'Background updates must retain the running app precache until accepted',
)
workerListeners.get('message')?.({ data: { type: 'SKIP_WAITING' } })
assert(forcedActivation, 'Explicit Update now must activate the waiting worker')
assert(
  importedScripts.includes('push-sw.js'),
  'The generated service worker must import push-sw.js for blind WebPush wakeups',
)
assert(
  existsSync(new URL('push-sw.js', output)),
  'Missing push-sw.js in dist/pwa/',
)
assert.equal(routes.length, 1)
assert(
  routes[0] instanceof NavigationRoute,
  'No runtime API caching is allowed',
)
assert.equal(routes[0].handler, 'index.html')
// Workbox matches navigation exclusions against pathname + search. Inspect the
// generated patterns so gateway portals still reach the server after PWA install.
const bypassesAppShell = path =>
  routes[0].denylist.some(pattern => pattern.test(path))
for (const path of [
  '/pay/held-message',
  '/pay/held-message?network=bitcoin-signet',
  '/secure/message-token',
  '/secure/message-token/request-otp',
  '/secure/message-token/verify?code=123456',
  '/onboard/claim/claim-token',
  '/onboard/claim/claim-token?source=email',
  '/sw.js',
  '/workbox-12345678.js',
]) {
  assert(
    bypassesAppShell(path),
    `Server/worker path intercepted by app shell: ${path}`,
  )
}
for (const path of [
  '/',
  '/chat/conversation',
  '/settings',
  '/payment',
  '/securely',
  '/onboard/claims/token',
  '/chat/pay/token',
  '/chat?next=/secure/token',
]) {
  assert(
    !bypassesAppShell(path),
    `App navigation excluded from app shell: ${path}`,
  )
}
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

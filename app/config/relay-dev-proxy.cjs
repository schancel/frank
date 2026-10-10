/*
 * The dev server forwards the relay's routes to the relay, so the app can always ask its own
 * origin (see `getDefaultRelayBaseUrl` in packages/wallet/chain/monad-chain.ts: on a loopback
 * page that is not the relay's own port, the relay base URL is the page's origin).
 *
 * Which relay: the one the app itself is configured with. `QCLI_MONAD_RELAY_BASE_URL` is
 * the variable the browser reads for its relay, and it is the proxy target too, so the one
 * variable drives both. `FRANK_DEMO_RELAY_PORT`, when set, names a relay on this machine
 * and wins (the demo launcher sets it beside a public relay URL, and the local hop is the
 * shorter one). With neither, the relay's default local port.
 */
const DEFAULT_RELAY_PORT = 8098

/** Every relay route prefix the app asks for. A route missing here is answered 404 by the
 * dev server itself, which the app would read as "this relay does not serve that". */
const RELAY_ROUTES = [
  { path: '/chains' },
  { path: '/peers' },
  { path: '/metadata' },
  { path: '/messages' },
  { path: '/message', ws: true },
  { path: '/chain-rpc', ws: true },
  { path: '/directory' },
  { path: '/relay' },
  { path: '/address' },
  { path: '/profiles' },
  // Prices and energy: GET /oracle/v1/feed (docs/protocol/oracle/README.md).
  { path: '/oracle' },
]

function httpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return undefined
    return parsed.origin + parsed.pathname.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/** The relay the dev server forwards to, from the environment `quasar dev` was started in. */
function relayProxyTarget(env) {
  const port = Number(env.FRANK_DEMO_RELAY_PORT)
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    return `http://127.0.0.1:${port}`
  }
  return (
    httpUrl(env.QCLI_MONAD_RELAY_BASE_URL) ??
    httpUrl(env.QCLI_E2E_DEMO_RELAY_URL) ??
    `http://127.0.0.1:${DEFAULT_RELAY_PORT}`
  )
}

/** The `devServer.proxy` entries for the relay's routes. */
function relayDevProxy(env) {
  const target = relayProxyTarget(env)
  return Object.fromEntries(
    RELAY_ROUTES.map(({ path, ws }) => [
      path,
      { target, changeOrigin: true, ...(ws ? { ws: true } : {}) },
    ]),
  )
}

module.exports = { RELAY_ROUTES, relayProxyTarget, relayDevProxy }

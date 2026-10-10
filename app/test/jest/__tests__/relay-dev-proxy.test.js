const { readFileSync } = require('fs')
const { resolve } = require('path')
const {
  RELAY_ROUTES,
  relayProxyTarget,
  relayDevProxy,
} = require('../../../config/relay-dev-proxy.cjs')

describe('the dev server forwards relay routes to the relay the app is configured with', () => {
  it('forwards the oracle feed, so the dev server never answers 404 for it itself', () => {
    // 2026-10-10: /oracle was missing; the dev server answered 404, which the app reads as
    // "this relay has no oracle", and it went to third-party price providers instead.
    const proxy = relayDevProxy({
      QCLI_MONAD_RELAY_BASE_URL: 'http://127.0.0.1:28198',
    })
    expect(proxy['/oracle']).toEqual({
      target: 'http://127.0.0.1:28198',
      changeOrigin: true,
    })
  })

  it('follows the app relay variable alone: no second variable is needed', () => {
    // 2026-10-10: the launcher's printed command set QCLI_MONAD_RELAY_BASE_URL only; the
    // proxy read FRANK_DEMO_RELAY_PORT only, stayed on 8098, and every relay route was 502.
    const env = { QCLI_MONAD_RELAY_BASE_URL: 'http://127.0.0.1:28198/' }
    expect(relayProxyTarget(env)).toBe('http://127.0.0.1:28198')
    const proxy = relayDevProxy(env)
    expect(Object.keys(proxy)).toEqual(RELAY_ROUTES.map(route => route.path))
    for (const entry of Object.values(proxy)) {
      expect(entry.target).toBe('http://127.0.0.1:28198')
    }
    expect(proxy['/message'].ws).toBe(true)
    expect(proxy['/chain-rpc'].ws).toBe(true)
  })

  it('a relay on another host is forwarded to as configured', () => {
    expect(
      relayProxyTarget({
        QCLI_MONAD_RELAY_BASE_URL: 'https://relay.example.org',
      }),
    ).toBe('https://relay.example.org')
  })

  it('an explicit local relay port wins; with nothing set, the default local relay', () => {
    expect(
      relayProxyTarget({
        FRANK_DEMO_RELAY_PORT: '28198',
        QCLI_MONAD_RELAY_BASE_URL: 'https://public.example.org',
      }),
    ).toBe('http://127.0.0.1:28198')
    expect(relayProxyTarget({})).toBe('http://127.0.0.1:8098')
    expect(relayProxyTarget({ QCLI_MONAD_RELAY_BASE_URL: 'not a url' })).toBe(
      'http://127.0.0.1:8098',
    )
  })

  it('is what quasar.config.js uses, with no relay route written beside it', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../quasar.config.js'),
      'utf8',
    )
    expect(source).toContain('...relayDevProxy(process.env),')
    expect(source).not.toMatch(/FRANK_DEMO_RELAY_PORT/)
  })
})

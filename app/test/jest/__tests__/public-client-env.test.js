const {
  PUBLIC_CLIENT_ENV,
  filterPublicClientEnv,
} = require('../../../config/public-client-env.cjs')

describe('public client environment boundary', () => {
  it('never carries a provider URL or a switch that points the app at a local stand-in chain', () => {
    expect(
      PUBLIC_CLIENT_ENV.has('import.meta.env.QCLI_MONAD_TESTNET_HTTP_RPC_URL'),
    ).toBe(false)
    expect([...PUBLIC_CLIENT_ENV].filter(key => /FAKE|DEMO_CONTROL/.test(key))).toEqual([])
  })
  it('preserves declared public settings and excludes upstream provider secrets', () => {
    const publicValues = Object.fromEntries(
      [...PUBLIC_CLIENT_ENV].map(key => [key, `public:${key}`]),
    )
    const filtered = filterPublicClientEnv(
      {
        ...publicValues,
        'import.meta.env.QCLI_MONAD_TESTNET_HTTP_RPC_URL':
          'https://provider.invalid/secret',
        'import.meta.env.QCLI_MONAD_TESTNET_WS_RPC_URL':
          'wss://provider.invalid/secret',
        'import.meta.env.QCLI_UNDECLARED': 'not-public-by-default',
      },
      'client',
    )

    expect(filtered).toEqual(publicValues)
  })

  it('does not alter the server-side environment', () => {
    const env = {
      'import.meta.env.MONAD_TESTNET_HTTP_RPC_URL':
        'https://provider.invalid/secret',
    }
    expect(filterPublicClientEnv(env, 'backend')).toBe(env)
  })
})

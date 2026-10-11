const PUBLIC_CLIENT_VARIABLES = [
  'QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI',
  'QCLI_E2E_DEMO_RELAY_URL',
  'QCLI_FRANK_DM_DEFAULT_STAMP_AVU',
  'QCLI_FRANK_NETWORK_TAG',
  'QCLI_FRANK_TOPIC_DEFAULT_VOTE_VALUE_WEI',
  'QCLI_MONAD_CHAIN_ID',
  'QCLI_MONAD_DM_POLL_INTERVAL_MS',
  'QCLI_MONAD_NETWORK_ID',
  // Automated tests only: contract addresses of one run of the local Monad regtest network.
  'QCLI_MONAD_REGTEST_HTLC_ADDRESS',
  'QCLI_MONAD_REGTEST_STATE_CHANNEL_ADDRESS',
  'QCLI_MONAD_RELAY_BASE_URL',
  'QCLI_MONAD_RPC_CHAIN',
  'QCLI_MONAD_SKIP_LEGACY_SETUP_GATE',
  'QCLI_MONAD_STAMP_BURN_ADDRESS',
  'QCLI_MONAD_SUB_ACCOUNT_POOL_SIZE',
  'QCLI_MONAD_WALLET_STORAGE_LOCATION',
  'QCLI_SETUP_FINISH_RELOAD',
]
const PUBLIC_CLIENT_ENV = new Set(
  PUBLIC_CLIENT_VARIABLES.map(key => `import.meta.env.${key}`),
)

function filterPublicClientEnv(env, type) {
  if (type !== 'client') return env
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => PUBLIC_CLIENT_ENV.has(key)),
  )
}

module.exports = { PUBLIC_CLIENT_ENV, filterPublicClientEnv }

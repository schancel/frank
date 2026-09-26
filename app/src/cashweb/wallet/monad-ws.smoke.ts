/**
 * Standalone, manual smoke test for `subscribeMonadNewBlocks` (./monad-ws.ts) against the
 * *live* Monad testnet WS endpoint. Not wired into any app logic, not run by `yarn test:unit`
 * or any other automated gate — this is a "did it really work" check to be run by hand.
 *
 * Usage (from `app/`):
 *
 *   set -a; source ../.env; set +a
 *   ./node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop \
 *     --outDir /tmp/monad-ws-smoke \
 *     src/cashweb/wallet/monad-ws.ts src/cashweb/wallet/monad-ws.smoke.ts
 *   node /tmp/monad-ws-smoke/monad-ws.smoke.js
 *
 * Reads the endpoint from `MONAD_TESTNET_WS_RPC_URL` (never hardcoded here) and exits 0 as
 * soon as a real block notification arrives, or exits 1 after a timeout with nothing observed.
 */

import { subscribeMonadNewBlocks } from './monad-ws'

const wsUrl = process.env.MONAD_TESTNET_WS_RPC_URL
if (!wsUrl) {
  console.error('MONAD_TESTNET_WS_RPC_URL is not set in the environment')
  process.exit(1)
}

const TIMEOUT_MS = 30_000
const startedAt = Date.now()

console.log(
  `monad-ws smoke test: connecting to ${wsUrl.replace(
    /\/v2\/.*/,
    '/v2/<redacted>',
  )}`,
)

const timeout = setTimeout(() => {
  console.error(
    `monad-ws smoke test: FAILED — no block observed within ${TIMEOUT_MS}ms`,
  )
  process.exit(1)
}, TIMEOUT_MS)

const unsubscribe = subscribeMonadNewBlocks(wsUrl, event => {
  const elapsedMs = Date.now() - startedAt
  console.log(
    `monad-ws smoke test: OK — observed block ${event.blockHash} after ${elapsedMs}ms`,
  )
  clearTimeout(timeout)
  unsubscribe()
  process.exit(0)
})

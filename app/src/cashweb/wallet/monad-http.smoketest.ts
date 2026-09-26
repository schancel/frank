/**
 * Standalone, manually-run smoke test for `monad-http.ts` against the LIVE Monad testnet
 * endpoint. This is deliberately NOT a jest test (this app's `jest` isn't actually an installed
 * dependency despite being referenced by `package.json` scripts — see ticket #1's handoff on
 * issue #1) and is NOT imported by any app code or build entrypoint.
 *
 * What this proves live (read-only, no funds spent):
 *   - `eth_blockNumber` (via `getBlockNumber`)
 *   - `eth_getLogs` (via `getLogs`, over a recent block range)
 *   - `eth_getTransactionReceipt` (via `getTransactionReceipt`, for a real tx hash pulled from
 *     one of those logs)
 *
 * What this does NOT prove live: `submitRawTransaction` (`eth_sendRawTransaction`). Actually
 * submitting a tx requires a funded testnet account, which is explicitly out of scope for this
 * ticket's proof ("do not attempt an actual fund-requiring send"). That method is exercised only
 * by type-checking (`tsc --noEmit`) and manual code review; it is NOT covered by a live or
 * mocked call in this repo. If real coverage is wanted later, either fund a disposable testnet
 * account or mock `JsonRpcProvider.broadcastTransaction`.
 *
 * Env loading gap: this app (browser + Electron + Capacitor) has no established convention for
 * getting a gitignored `.env` value into runtime config. The tiny loader below is a Node-only,
 * script-local workaround good enough to run this file with `ts-node`/compiled `tsc` output — it
 * is NOT a general solution and should not be reused as one when the real ChainAdapter wiring
 * (M5 / ticket #2) needs to get `MONAD_TESTNET_HTTP_RPC_URL` into the browser/Electron/Capacitor
 * runtime. That's a real open gap, left for whoever does that wiring.
 *
 * Usage (from `app/`):
 *   node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop --resolveJsonModule \
 *     --outDir /tmp/monad-smoketest src/cashweb/wallet/monad-http.ts src/cashweb/wallet/monad-http.smoketest.ts
 *   node /tmp/monad-smoketest/monad-http.smoketest.js
 */
import fs from 'fs'
import path from 'path'

import { MonadHttpClient } from './monad-http'

function loadRpcUrlFromEnv(): string {
  const envKey = 'MONAD_TESTNET_HTTP_RPC_URL'
  if (process.env[envKey]) {
    return process.env[envKey] as string
  }
  // Fall back to reading the repo-root `.env` directly (gitignored, never committed). This repo
  // has no `dotenv` dependency and no established env-loading convention (see file header) —
  // this is a minimal one-off parser, good enough for local script use only.
  const candidates = [
    path.resolve(__dirname, '../../../../.env'), // app/src/cashweb/wallet -> repo root
    path.resolve(process.cwd(), '.env'),
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const raw = fs.readFileSync(candidate, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      if (key !== envKey) continue
      return trimmed.slice(eq + 1).trim()
    }
  }
  throw new Error(
    `Missing ${envKey}: set it in the environment or in a gitignored .env at the repo root`,
  )
}

async function main() {
  const rpcUrl = loadRpcUrlFromEnv()
  const client = new MonadHttpClient({ rpcUrl })

  const blockNumber = await client.getBlockNumber()
  console.log('[1/3] eth_blockNumber ->', blockNumber)
  if (!Number.isFinite(blockNumber) || blockNumber <= 0) {
    throw new Error(`Unexpected block number: ${blockNumber}`)
  }

  // Search backwards in windows for a window with at least one log, since testnet activity is
  // sparse and we don't want to assume the very latest blocks have any. Window size is capped at
  // 10 blocks (inclusive) because Alchemy's free tier rejects wider `eth_getLogs` ranges — see
  // the "Alchemy free-tier eth_getLogs range limit" note in monad-http.ts.
  const WINDOW = 9
  const MAX_WINDOWS = 50
  let logs: Awaited<ReturnType<MonadHttpClient['getLogs']>> = []
  let toBlock = blockNumber
  for (let i = 0; i < MAX_WINDOWS && logs.length === 0; i++) {
    const fromBlock = Math.max(0, toBlock - WINDOW)
    logs = await client.getLogs({ fromBlock, toBlock })
    console.log(
      `[2/3] eth_getLogs [${fromBlock}, ${toBlock}] -> ${logs.length} log(s)`,
    )
    toBlock = fromBlock - 1
  }
  if (logs.length === 0) {
    throw new Error(
      `No logs found in the last ${
        MAX_WINDOWS * WINDOW
      } blocks; cannot pick a real tx hash to fetch a receipt for`,
    )
  }

  const sampleLog = logs[0]
  console.log(
    '  sample log: block',
    sampleLog.blockNumber,
    'tx',
    sampleLog.transactionHash,
  )

  const receipt = await client.getTransactionReceipt(sampleLog.transactionHash)
  if (receipt === undefined) {
    throw new Error(
      `getTransactionReceipt returned undefined for a tx hash (${sampleLog.transactionHash}) we just pulled from eth_getLogs`,
    )
  }
  console.log('[3/3] eth_getTransactionReceipt ->', {
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    logCount: receipt.logs.length,
  })
  if (receipt.blockNumber !== sampleLog.blockNumber) {
    throw new Error(
      `Receipt block number (${receipt.blockNumber}) doesn't match the log's block number (${sampleLog.blockNumber})`,
    )
  }

  console.log(
    '\nSMOKE TEST PASSED against',
    rpcUrl.replace(/\/v2\/.*/, '/v2/<redacted>'),
  )
}

main().catch(err => {
  console.error('SMOKE TEST FAILED:', err)
  process.exit(1)
})

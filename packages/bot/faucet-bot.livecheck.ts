/**
 * Standalone testnet faucet (#316): funds each newly registered Frank profile once with a small
 * amount of testnet MON. No LLM key, no stamp pool, no identity: it only polls the relay's
 * new-profile feed and sends plain transfers from the operator's faucet wallet. Independent of
 * the Qwen greeter (set `QWEN_BOT_FUND_VALUE_WEI=0` there to avoid funding twice).
 *
 * The logic lives in `faucet-core.ts` (tested with fakes); this file is only the process wrapper,
 * same `.livecheck.ts` convention as the other bots (hits a real network, never run by jest).
 *
 * ## Usage
 *
 *   cd packages/bot
 *   export MONAD_TESTNET_HTTP_RPC_URL=...        # a Monad TESTNET RPC (chain id 10143)
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/faucet-wallet.json   # {address, privateKey}
 *   export FRANK_NETWORK_TAG=MONT
 *   yarn faucet
 *   yarn faucet --list-stuck          # unsettled/failed/skipped records (needs only FAUCET_STATE_DIR)
 *   yarn faucet --clear <address>    # allow re-funding a stuck address. DANGEROUS: refuses paid records
 *                                    # and, if MONAD_TESTNET_HTTP_RPC_URL is set, any tx the node knows.
 *                                    # A `signed` record (maybe broadcast) also needs
 *                                    # --force --confirm-tx <txHash>
 *
 * Env vars (all optional except the three above):
 *   E2E_DEMO_RELAY_URL             relay base URL (default http://127.0.0.1:8098)
 *   FAUCET_STATE_DIR               durable state (default ~/.frank-faucet); warns if under a tmp dir
 *   FAUCET_AMOUNT_WEI              per address (default 0.05 MON; hard ceiling 1 MON)
 *   FAUCET_MAX_PER_RUN             new addresses funded per process run (default 10)
 *   FAUCET_MAX_PER_DAY             new addresses funded per rolling 24h, across runs (default 20, max 1000)
 *   FAUCET_MIN_RESERVE_WEI         faucet wallet floor (default 0.1 MON, minimum 0.01 MON)
 *   FAUCET_POLL_INTERVAL_MS        default 4000 (allowed 1000..3600000)
 *   FAUCET_PROFILE_SINCE_MS        first-run cursor override (default: now, i.e. only new signups)
 *   FRANK_BOT_PEER_DENYLIST        addresses never funded (shared with the other bots)
 *
 * The wallet must be dedicated to this faucet: do not share it with the Qwen bot's funding
 * (`QWEN_BOT_FUND_VALUE_WEI=0`) or a second faucet on another state dir; concurrent senders reuse
 * nonces and can kill each other's transfers. The wallet JSON holds a private key: `chmod 600` it
 * (the faucet warns otherwise).
 *
 * Testnet only: the process refuses to start unless the RPC reports chain id 10143 and
 * `FRANK_NETWORK_TAG` is `MONT`. Private keys are read from the wallet JSON only to construct the
 * signer and are never logged. Do not point this at a real-value network.
 */
import { statSync } from 'fs'
import { homedir, tmpdir } from 'os'

import { JsonRpcProvider } from 'ethers'
import { resolve } from 'path'

import { fetchMonadProfilesSince } from '@frank/wallet/monad-identity'

import { botLoopGuardFromEnv } from './bot-loop-guard'
import {
  assertTestnet,
  Faucet,
  faucetAdmin,
  faucetStateDirFromEnv,
  TxLookup,
  faucetSettingsFromEnv,
  keyFilePermissionWarning,
  stateDirWarning,
} from './faucet-core'
import { FaucetStateStore } from './faucet-state'
import {
  loadMainAccountSigner,
  requiredEnv,
  waitForConfirmation,
} from './qwen-bot-common'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Receipt if mined, else whether the node still knows the tx (mempool), else unknown. */
async function lookupTx(
  provider: JsonRpcProvider,
  txHash: string,
): Promise<TxLookup> {
  const receipt = await provider.getTransactionReceipt(txHash)
  if (receipt) return receipt.status === 1 ? 'confirmed' : 'failed'
  return (await provider.getTransaction(txHash)) ? 'pending' : 'unknown'
}

async function main() {
  // Operator commands run BEFORE any env validation: they need only the state dir (and, when
  // MONAD_TESTNET_HTTP_RPC_URL is set, a read-only node lookup), so a bad FAUCET_* value must not
  // block them.
  const adminArgs = process.argv.slice(2)
  if (adminArgs.includes('--list-stuck') || adminArgs.includes('--clear')) {
    const adminStateDir = resolve(
      process.cwd(),
      faucetStateDirFromEnv(process.env, homedir()),
    )
    const adminRpc = process.env.MONAD_TESTNET_HTTP_RPC_URL
    const adminProvider = adminRpc ? new JsonRpcProvider(adminRpc) : undefined
    const adminStore = new FaucetStateStore(adminStateDir)
    await adminStore.Open()
    try {
      for (const line of (await faucetAdmin(
        adminStore,
        adminArgs,
        adminProvider && (hash => lookupTx(adminProvider, hash)),
      )) ?? []) {
        console.log(line)
      }
    } finally {
      await adminStore.Close()
    }
    return
  }

  const settings = faucetSettingsFromEnv(process.env, homedir())
  const { config, pollIntervalMs } = settings
  const stateDirPath = resolve(process.cwd(), settings.stateDir)
  const stateWarning = stateDirWarning(stateDirPath, [tmpdir(), '/tmp'])
  if (stateWarning) console.warn(`[faucet] WARNING: ${stateWarning}`)

  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const networkTag = requiredEnv('FRANK_NETWORK_TAG')
  const mainWalletJsonPath = resolve(
    process.cwd(),
    requiredEnv('E2E_DEMO_MAIN_WALLET_JSON'),
  )
  const keyWarning = keyFilePermissionWarning(
    mainWalletJsonPath,
    statSync(mainWalletJsonPath).mode,
  )
  if (keyWarning) console.warn(`[faucet] WARNING: ${keyWarning}`)

  const { provider, mainAccountSigner } = loadMainAccountSigner({
    rpcUrl,
    mainWalletJsonPath,
  })
  assertTestnet({
    networkTag,
    chainId: (await provider.getNetwork()).chainId,
  })

  console.log('== Testnet faucet (#316) ==')
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Faucet wallet: ${mainAccountSigner.address}`)
  console.log(
    `Amount ${config.amountWei} wei per new address; max ${config.maxPerRun}/run, ${config.maxPerDay}/24h; reserve ${config.minReserveWei} wei`,
  )

  if (
    process.env.USE_BOT_FRAMEWORK === '1' ||
    (process.env.USE_BOT_FRAMEWORK !== '0' && process.env.NODE_ENV !== 'test')
  ) {
    const { FrankBotHost } = await import('@frank/bot-framework')
    const { FaucetBot } = await import('./src/bots/faucet-bot')
    const host = new FrankBotHost({
      stateDir: stateDirPath,
      relayBaseUrl,
      rpcUrl,
      pollIntervalMs: settings.pollIntervalMs,
    })
    await host.register(new FaucetBot(config))
    await host.start()
    return
  }

  const store = new FaucetStateStore(stateDirPath)
  await store.Open()
  const faucet = new Faucet({
    store,
    config,
    guard: botLoopGuardFromEnv({
      selfAddress: mainAccountSigner.address,
      relayBaseUrl,
    }),
    faucetAddress: mainAccountSigner.address,
    signTransfer: (to, value) =>
      mainAccountSigner.buildAndSignTransfer(to, value),
    submitRaw: async tx => {
      await mainAccountSigner.submitRaw(tx.rawTx, tx.txHash)
    },
    getTxStatus: txHash => lookupTx(provider, txHash),
    waitForConfirmation: txHash =>
      waitForConfirmation(mainAccountSigner, txHash, 'faucet transfer'),
    getBalance: address => provider.getBalance(address),
  })

  let since = store.getSinceProfiles() ?? settings.profileSinceMs ?? Date.now()

  let lastStopped: string | undefined
  try {
    while (true) {
      await faucet.recoverSigned()
      await faucet.recheckSubmitted()
      const profiles = await fetchMonadProfilesSince({
        relayBaseUrl,
        sinceMs: since,
      })
      const before = faucet.fundedThisRun
      const result = await faucet.pollOnce(profiles, since)
      if (faucet.fundedThisRun > before) {
        console.log(
          `[faucet] funded ${
            faucet.fundedThisRun - before
          } address(es) this poll (${faucet.fundedThisRun}/${
            config.maxPerRun
          } this run)`,
        )
      }
      if (result.stopped && result.stopped !== lastStopped) {
        console.log(`[faucet] batch stopped: ${result.stopped}`)
      }
      lastStopped = result.stopped
      if (result.cursor !== since) {
        since = result.cursor
        await store.setSinceProfiles(since)
      }
      if (faucet.fundedThisRun >= config.maxPerRun) {
        console.log('[faucet] per-run cap reached -- exiting.')
        break
      }
      await sleep(pollIntervalMs)
    }
  } finally {
    await store.Close()
  }
}

main().catch(err => {
  console.error('\nFAUCET FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})

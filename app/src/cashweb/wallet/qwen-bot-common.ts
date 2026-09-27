/**
 * Shared setup helpers for ticket #9's two live scripts (`qwen-bot.livecheck.ts` and
 * `qwen-bot-send-demo.livecheck.ts`): load-or-create a persisted `FrankIdentity`, and stand up a
 * funded, single-use Monad sub-account pool (#14/#18/#34) + `MonadStampClient` (#13) ready to send
 * stamped messages -- the same steps `monad-e2e-demo.livecheck.ts` (ticket #8) already proved live,
 * factored out here so neither script duplicates them.
 *
 * ## Gas budget (why `gasReserve` is computed, not a fixed constant like #8's demo used)
 *
 * Ticket #8's own demo used a flat `0.02 MON` `gasReserve` headroom, affordable against the
 * ~9.9976 MON balance confirmed live during that ticket. By the time this ticket ran, that same
 * account (`frank-worktrees/spike-demo/spike/data/chain-wallet.json`) had only ~0.0177 MON left
 * (checked live via `eth_getBalance` immediately before this ticket's own demo run -- see this
 * ticket's handoff for the exact figure) -- apparently spent down by that and other tickets'
 * testnet activity in the interim, with no faucet top-up available in this environment. At that
 * balance, a flat `0.02 MON` reserve per sub-account is not affordable at all (let alone the two
 * sub-accounts -- one per identity -- a single round-trip conversation needs), so `gasReserve`
 * here is instead computed from the chain's *actual* current `maxFeePerGas`
 * (`provider.getFeeData()`) times a conservative gas-limit estimate for a Stamp burn tx (~23000
 * gas -- `backend/cashweb/cashweb-registry/examples/README.md`'s own live run recorded `gasUsed:
 * 22596` for an equivalently-sized calldata commitment), with a 10% margin for fee drift between
 * this estimate and the sub-account's own later burn-tx submission. This is the minimum a sub-
 * account needs funded to pass a node's mempool admission check (`balance >= value +
 * maxFeePerGas * gasLimit`) for its own burn tx -- not a padded, "plenty of headroom" number like
 * #8's, because this ticket's balance doesn't have room for padding.
 *
 * ## Nonce-race retries (`fundPoolWithRetry`)
 *
 * Confirmed live while running this ticket's own demo: the shared main funded wallet
 * (`frank-worktrees/spike-demo/spike/data/chain-wallet.json`) is apparently also in concurrent use
 * by other activity in this environment (its balance kept dropping, and `eth_getTransactionCount`
 * kept moving, between this ticket's own transactions) -- so a nonce fetched via `eth_
 * getTransactionCount(address, "pending")` can already be stale by the time the signed transfer
 * actually reaches the node, and `eth_sendRawTransaction` rejects it as `"nonce has already been
 * used"`. `fanOutFundSubAccounts` (`./monad-account-pool.ts`, #14) deliberately has no retry logic
 * of its own for this (its own doc comment calls parallelizing/retrying "out of scope" for that
 * ticket) and `MonadSubAccountPool.fundAll` doesn't expose an `onFunded` hook to track partial
 * progress across a retry -- so `fundPoolWithRetry` below calls `fanOutFundSubAccounts` directly
 * (bypassing `fundAll`, not editing it) with its own `onFunded` bookkeeping, so a retry after a
 * nonce race only re-attempts whichever sub-accounts didn't already get a real funding tx
 * broadcast, rather than re-funding (and double-spending on) ones that already succeeded.
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'

import { JsonRpcProvider } from 'ethers'

import { MonadHttpClient } from './monad-http'
import { MonadAccountTxSigner } from './monad-account-tx'
import { MonadHdKeyring } from './monad-hd-keyring'
import {
  MonadSubAccountPool,
  fanOutFundSubAccounts,
  FanOutFundingResult,
} from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadStampClient } from './monad-stamp-client'
import { FrankIdentity, LotusNet, registerIdentity } from './lotus-identity'

export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var ${name}`)
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Loads a `FrankIdentity` persisted (as `{ privateKeyHex }`) at `identityJsonPath`, or generates
 * and persists a fresh one if the file doesn't exist yet -- so re-running either script keeps
 * addressing the same identity (needed for the bot: the sender script has to know a stable
 * address to send its first message to) instead of registering a brand-new one every run. */
export function loadOrCreateIdentity(
  identityJsonPath: string,
  net: LotusNet,
  label: string,
): FrankIdentity {
  if (existsSync(identityJsonPath)) {
    const saved = JSON.parse(readFileSync(identityJsonPath, 'utf8')) as {
      privateKeyHex: string
    }
    const identity = FrankIdentity.fromPrivateKeyHex(saved.privateKeyHex, net)
    console.log(`[${label}] loaded existing identity ${identity.address}`)
    return identity
  }
  const identity = FrankIdentity.generate(net)
  writeFileSync(
    identityJsonPath,
    JSON.stringify({ privateKeyHex: identity.toPrivateKeyHex() }, null, 2),
  )
  console.log(
    `[${label}] generated fresh identity ${identity.address} (saved to ${identityJsonPath})`,
  )
  return identity
}

/** `PUT /metadata/:addr` for `identity`, logging the result -- registration is idempotent enough
 * to call on every run (`Registry::put_metadata` accepts a re-PUT as long as the new payload's
 * timestamp is strictly greater than any existing one, which `Date.now()` always is on a later
 * run). */
export async function registerAndLog(params: {
  relayBaseUrl: string
  identity: FrankIdentity
  label: string
}): Promise<void> {
  await registerIdentity({
    relayBaseUrl: params.relayBaseUrl,
    identity: params.identity,
  })
  console.log(
    `[${params.label}] registered identity ${params.identity.address} (PUT /metadata, no payment -- POP disabled)`,
  )
}

export interface FundedStampSetup {
  provider: JsonRpcProvider
  stampClient: MonadStampClient
}

/** Waits (polling `getStatus`) for `txHash` to reach a terminal state, throwing if it fails or
 * never confirms within the poll budget -- same pattern `monad-e2e-demo.livecheck.ts` (#8) uses. */
export async function waitForConfirmation(
  signer: MonadAccountTxSigner,
  txHash: string,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await signer.getStatus(txHash)
    if (status === 'confirmed') return
    if (status === 'failed') {
      throw new Error(`${label} (${txHash}) failed on-chain`)
    }
    await sleep(2000)
  }
  throw new Error(`${label} (${txHash}) did not confirm within the poll budget`)
}

/** See this file's header, "Nonce-race retries". Funds every currently-`'available'` sub-account
 * in `pool`, retrying only the not-yet-funded remainder when a funding tx is rejected for a
 * nonce reason (another concurrent user of the same shared wallet having raced it), up to
 * `maxAttempts`. Any other kind of failure (insufficient balance, RPC down, ...) propagates
 * immediately without retrying. */
async function fundPoolWithRetry(params: {
  pool: MonadSubAccountPool
  mainAccountSigner: MonadAccountTxSigner
  burnValueWei: bigint
  gasReserve: bigint
  label: string
  maxAttempts?: number
}): Promise<FanOutFundingResult[]> {
  const maxAttempts = params.maxAttempts ?? 6
  const funded: FanOutFundingResult[] = []
  let remaining = params.pool
    .records()
    .filter(record => record.status === 'available')

  for (
    let attempt = 1;
    attempt <= maxAttempts && remaining.length > 0;
    attempt++
  ) {
    try {
      await fanOutFundSubAccounts({
        mainAccountSigner: params.mainAccountSigner,
        targets: remaining,
        burnValue: params.burnValueWei,
        gasReserve: params.gasReserve,
        onFunded: result => {
          funded.push(result)
          remaining = remaining.filter(target => target.index !== result.index)
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isNonceRace = /nonce/i.test(message)
      if (!isNonceRace || attempt === maxAttempts) throw err
      const backoffMs = 1500 * attempt
      console.log(
        `[${params.label}] funding hit a nonce race (the shared testnet wallet is apparently in ` +
          `concurrent use elsewhere too) -- retrying the remaining ${remaining.length} sub-account(s) ` +
          `in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`,
      )
      await sleep(backoffMs)
    }
  }
  return funded
}

/**
 * Derives a fresh HD sub-account pool (ticket #14), funds `poolSize` sub-accounts from the main
 * funded testnet wallet at `mainWalletJsonPath`, waits for every funding tx to confirm, and wires
 * up a `MonadStampClient` ready to send Stamp-over-Monad messages. See this file's header for how
 * `gasReserve` is sized against this ticket's very tight remaining testnet balance.
 */
export async function setUpFundedStampClient(params: {
  rpcUrl: string
  relayBaseUrl: string
  mainWalletJsonPath: string
  poolSize: number
  burnValueWei: bigint
  label: string
}): Promise<FundedStampSetup> {
  const provider = new JsonRpcProvider(params.rpcUrl)
  const httpClient = new MonadHttpClient({ rpcUrl: params.rpcUrl })

  const mainWallet = JSON.parse(
    readFileSync(params.mainWalletJsonPath, 'utf8'),
  ) as { address: string; privateKey: string }
  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainWallet.privateKey,
    provider,
    httpClient,
  })
  console.log(`[${params.label}] main funding account: ${mainWallet.address}`)

  const { keyring } = MonadHdKeyring.generate()
  const pool = new MonadSubAccountPool({ keyring })
  pool.ensureSize(params.poolSize)

  const feeData = await provider.getFeeData()
  const fallbackMaxFeePerGas = BigInt(250000000000) // 250 gwei -- only if the node can't report feeData at all
  const maxFeePerGas = feeData.maxFeePerGas ?? fallbackMaxFeePerGas
  const estimatedBurnGasLimit = BigInt(23000)
  const gasReserve =
    (maxFeePerGas * estimatedBurnGasLimit * BigInt(11)) / BigInt(10)
  console.log(
    `[${params.label}] maxFeePerGas=${maxFeePerGas} wei; funding each sub-account with burnValue=${params.burnValueWei} + gasReserve=${gasReserve} wei`,
  )

  const funded = await fundPoolWithRetry({
    pool,
    mainAccountSigner,
    burnValueWei: params.burnValueWei,
    gasReserve,
    label: params.label,
  })
  for (const f of funded) {
    console.log(
      `[${params.label}] funded ${f.address} (sub-account ${f.index}) with ${f.fundedValue} wei, tx ${f.txHash}`,
    )
    await waitForConfirmation(
      mainAccountSigner,
      f.txHash,
      `${params.label} funding tx (sub-account ${f.index})`,
    )
    console.log(
      `[${params.label}] funding tx for sub-account ${f.index} confirmed on-chain`,
    )
  }

  const leaseManager = new SubAccountLeaseManager(pool)
  const stampClient = new MonadStampClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    relayBaseUrl: params.relayBaseUrl,
  })

  return { provider, stampClient }
}

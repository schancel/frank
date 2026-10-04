/**
 * Shared setup helpers for ticket #9's two live scripts (`qwen-bot.livecheck.ts` and
 * `qwen-bot-send-demo.livecheck.ts`): load-or-create a persisted `MonadIdentity`, and stand up a
 * funded, single-use Monad sub-account pool (#14/#18/#34) + `MonadStampClient` (#13) ready to send
 * stamped messages -- the same steps `monad-e2e-demo.livecheck.ts` (ticket #8) already proved live,
 * factored out here so neither script duplicates them.
 *
 * ## Ported from `FrankIdentity`/Lotus identity to `MonadIdentity` (post-#45)
 *
 * Originally used `lotus-identity.ts`'s `FrankIdentity` (a Lotus-address-encoded identity,
 * registered via the Lotus-only branch of `PUT /metadata/:addr`) -- proven live and documented in
 * `QWEN_BOT_README.md`'s "Live proof from this ticket's own run" section, which stays accurate as
 * a historical record of that run. Ported to `MonadIdentity`/`monad-identity.ts` once the real
 * Frank UI's `ActiveChain`/`MonadChain` stack (#41-#43) and its Monad-native profile registration
 * route (#45) existed: the UI only ever resolves a contact's pubkey via `fetchMonadProfile`, which
 * never finds a Lotus-registered identity, so a Lotus-identity bot was invisible to (and couldn't
 * message) any real wallet created through the app. `monad-message-envelope.ts`'s envelope
 * format/ECDH itself needed no changes -- `from`/`to` were always plain, format-agnostic strings.
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
 * (`provider.getFeeData()`) times a conservative gas-limit estimate for a Stamp payment (~23000
 * gas -- `backend/cashweb/cashweb-registry/examples/README.md`'s own live run recorded `gasUsed:
 * 22596` for an equivalently-sized calldata commitment), with a 10% margin for fee drift between
 * this estimate and the sub-account's own later payment submission. This is the minimum a sub-
 * account needs funded to pass a node's mempool admission check (`balance >= value +
 * maxFeePerGas * gasLimit`) for its own payment -- not a padded, "plenty of headroom" number like
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
 *
 * **2026-09-28: no longer the default path.** `fundPoolWithRetry` still exists and still works
 * exactly as described above, but as of `setUpFundedStampClient`'s "Lazy per-send funding" update
 * it only runs when a caller explicitly opts in with a nonzero `poolSize` (`monad-ui-verify.
 * livecheck.ts`, which needs a pool pre-funded before it ever calls `directMessages.send`). Both
 * bot scripts fund lazily per-send instead (`sendDirectMessageText`'s `pool.prepareStampInventory`
 * call), which sidesteps this contention almost entirely: instead of one burst of N
 * near-simultaneous transactions from a single account, funding happens in small
 * (`DEFAULT_TOPUP_BUFFER_SIZE = 5`) top-ups spread out one send at a time.
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { JsonRpcProvider, Provider } from 'ethers'

import { MonadHttpClient } from '@frank/wallet/monad-http'
import {
  MonadAccountTxSigner,
  MonadTxSubmitter,
} from '@frank/wallet/monad-account-tx'
import { MonadHdKeyring } from '@frank/wallet/monad-hd-keyring'
import { MonadChangeKeyring } from '@frank/wallet/monad-change-keyring'
import { MonadChangePool } from '@frank/wallet/monad-change-pool'
import {
  MonadSubAccountPool,
  fanOutFundSubAccounts,
  FanOutFundingResult,
} from '@frank/wallet/monad-account-pool'
import { SubAccountLeaseManager } from '@frank/wallet/monad-account-lease'
import {
  MonadStampClient,
  StampMonadMessageResult,
  quoteMonadStampPaymentGasReserve,
} from '@frank/wallet/monad-stamp-client'
import {
  fetchMonadProfile,
  MonadIdentity,
  MonadProfileFields,
  registerMonadIdentity,
} from '@frank/wallet/monad-identity'
import type { ProfileInfo } from '@frank/wallet/chain/active-chain'
import {
  MonadWalletPersistenceBundle,
  openMonadWalletBundle,
} from '@frank/wallet/storage/monad-wallet-bundle'
import { LevelStampAttemptJournal } from '@frank/wallet/storage/stamp-attempt-journal'
import { LevelStampPaymentJournal } from '@frank/wallet/storage/stamp-payment-journal'
import { openPersistentStampPool } from './stamp-pool-seed'
import { buildEnvelope } from '@frank/cashweb/relay/monad-message-envelope'
import { serializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { MessageItem } from '@frank/cashweb/types/messages'
import { randomBytes } from 'crypto'
import {
  directMessageText,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
  canonicalNetworkDescriptor,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import type { MonadTxOverrides } from '@frank/wallet/monad-account-tx'
import {
  canonicalMonadStampClient,
  createMonadChain,
  loadMonadChainConfigFromEnv,
  type MonadChainConfig,
} from '@frank/wallet/chain/monad-chain'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material'
import type { QwenCanonicalSender } from './qwen-response-workflow'
import type { QwenCanonicalInbound } from './qwen-inbound-workflow'
import { computeAddress } from 'ethers'
import { mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import type { Checkpoint, Current } from '@frank/directory-admission'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import {
  createDirectoryClient,
  type DirectoryFetch,
} from '@frank/cashweb/relay/directory-client'
import {
  fetchCanonicalInboxPage,
  type CanonicalMailboxAuthParams,
} from '@frank/cashweb/relay/monad-mailbox-client'
import type { RelayBinding } from '@frank/codec'

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

/** Loads an already-persisted identity and NEVER creates one: for read-only tooling (e.g.
 * `print-curated-defaults.ts`) that must not leave key files behind. */
export function loadExistingIdentity(
  identityJsonPath: string,
  label: string,
): MonadIdentity {
  if (!existsSync(identityJsonPath)) {
    throw new Error(
      `[${label}] no identity file at ${identityJsonPath} (start that bot once to create it)`,
    )
  }
  const saved = JSON.parse(readFileSync(identityJsonPath, 'utf8')) as {
    privateKeyHex: string
  }
  const identity = MonadIdentity.fromPrivateKeyHex(saved.privateKeyHex)
  console.log(`[${label}] loaded existing identity ${identity.displayAddress}`)
  return identity
}

/** Loads a `MonadIdentity` persisted (as `{ privateKeyHex }`) at `identityJsonPath`, or generates
 * and persists a fresh one if the file doesn't exist yet -- so re-running either script keeps
 * addressing the same identity (needed for the bot: the sender script has to know a stable
 * address to send its first message to) instead of registering a brand-new one every run.
 *
 * Ported from the original `FrankIdentity`/`lotus-identity.ts` version (ticket #9's original,
 * still-documented run in `QWEN_BOT_README.md` used that) to `MonadIdentity`/`monad-identity.ts`
 * once the real Frank UI's own identity/messaging stack (`ActiveChain`, tickets #41-#45) landed:
 * the UI's `MonadChain.directMessages` resolves a sender/recipient's pubkey via
 * `fetchMonadProfile`/`GET /metadata/monad/:addr`-or-dispatch, which only ever finds a
 * `MonadIdentity`-registered profile -- a Lotus-registered bot identity was invisible to, and
 * couldn't message, any real Monad wallet created through the app. See this file's own module docs
 * update and `QWEN_BOT_README.md` for the full before/after. */
export function loadOrCreateIdentity(
  identityJsonPath: string,
  label: string,
): MonadIdentity {
  if (existsSync(identityJsonPath)) {
    return loadExistingIdentity(identityJsonPath, label)
  }
  const identity = MonadIdentity.generate()
  writeFileSync(
    identityJsonPath,
    JSON.stringify({ privateKeyHex: identity.toPrivateKeyHex() }, null, 2),
    { mode: 0o600 }, // a private key: owner-only
  )
  console.log(
    `[${label}] generated fresh identity ${identity.displayAddress} (saved to ${identityJsonPath})`,
  )
  return identity
}

/** `PUT /metadata/:addr` for `identity`, logging the result -- registration is idempotent enough
 * to call on every run (`Registry::put_monad_profile`'s monotonic-timestamp check, ticket #45,
 * accepts a re-PUT as long as the new payload's timestamp is strictly greater than any existing
 * one, which `Date.now()` always is on a later run). */
export async function registerAndLog(params: {
  relayBaseUrl: string
  identity: MonadIdentity
  label: string
  /** Registers the self-declared bot marker (#311) so other bots skip this account. Defaults to
   * true -- every caller in this package except the human-simulating send demo is a bot. */
  bot?: boolean
  /** Public name/bio/avatar (#317), e.g. `botProfileFields('vendor')`. */
  profile?: MonadProfileFields
}): Promise<void> {
  const wanted: MonadProfileFields = {
    ...params.profile,
    bot: params.bot ?? true,
  }
  // Idempotent (#317): every re-PUT bumps the profile's registration timestamp, which shows up as
  // a "new registration" to anything watching the profile feed. Skip it when the relay already
  // holds exactly this profile.
  const existing = await fetchMonadProfile({
    relayBaseUrl: params.relayBaseUrl,
    address: params.identity.address,
  })
  if (existing && profileMatches(existing, wanted)) {
    console.log(
      `[${params.label}] profile for ${params.identity.displayAddress} already registered and unchanged`,
    )
    return
  }
  await registerMonadIdentity({
    relayBaseUrl: params.relayBaseUrl,
    identity: params.identity,
    profile: wanted,
  })
  console.log(
    `[${params.label}] registered identity ${
      params.identity.displayAddress
    } as "${wanted.name ?? ''}" (PUT /metadata, no payment -- POP disabled)`,
  )
}

/** Whether the relay's stored profile already carries exactly the fields `wanted` would sign.
 * An unset wanted field must be absent remotely too, so removing a field re-registers. */
export function profileMatches(
  existing: ProfileInfo,
  wanted: MonadProfileFields,
): boolean {
  return (
    (existing.name ?? '') === (wanted.name ?? '') &&
    (existing.bio ?? '') === (wanted.bio ?? '') &&
    (existing.avatar ?? '') === (wanted.avatar ?? '') &&
    (existing.bot ?? false) === (wanted.bot ?? false)
  )
}

export interface FundedStampSetup {
  provider: JsonRpcProvider
  stampClient: MonadStampClient
  /** The main funded testnet wallet's own signer (ticket #77): exposed here so a caller can send
   * plain native-value transfers (e.g. funding a brand-new user's address on registration) without
   * re-deriving its own `MonadAccountTxSigner` from `mainWalletJsonPath` a second time. Not part of
   * `MonadStampClient`'s own surface -- that class only ever spends from the disposable sub-account
   * pool (`pool`/`leaseManager`), never the main account directly. */
  mainAccountSigner: MonadAccountTxSigner
  /** Exposed so a caller can lazily top this up per-send via `pool.prepareStampInventory` (see
   * `sendDirectMessageText`) instead of pre-funding a large fixed batch up front -- see this
   * file's header, "Lazy per-send funding", for why. */
  pool: MonadSubAccountPool
  /** Flushes and closes the persisted pool records (a no-op without `stateDir`). Call at shutdown. */
  closePool(): Promise<void>
}

export interface DurableFundedStampSetup
  extends Omit<FundedStampSetup, 'closePool'> {
  walletState: MonadWalletPersistenceBundle
  /** Flushes and closes every durable journal and the wallet bundle, then releases the provider. */
  close(): Promise<void>
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
 * immediately without retrying.
 *
 * **Widened tonight (autonomous overnight session, 2026-09-27):** Monad testnet's node doesn't
 * always phrase this as "nonce" -- confirmed live, a real rejection came back as `"An existing
 * transaction had higher priority"` (`eth_sendRawTransaction`'s `-32000` response), which the
 * original `/nonce/i` regex didn't match, so a genuine nonce race propagated as a hard failure
 * instead of retrying. Broadened to also match "higher priority" and "already known" (another
 * common phrasing for the same underlying race across different EVM clients). */
export async function fundPoolWithRetry(params: {
  pool: MonadSubAccountPool
  mainAccountSigner: MonadAccountTxSigner
  stampValueWei: bigint
  gasReserve: bigint
  label: string
  maxAttempts?: number
}): Promise<FanOutFundingResult[]> {
  // Bumped from 6 tonight (autonomous overnight session, 2026-09-27): confirmed live, repeatedly,
  // that this environment's shared testnet wallet has persistent, severe nonce contention -- a
  // 10-account pool exhausted 6 attempts (needing a 5th retry for just the 4th-from-last account)
  // before finishing even one of two consecutive runs. Raised the ceiling rather than reducing pool
  // size further, since the linear backoff below already spaces attempts out increasingly.
  const maxAttempts = params.maxAttempts ?? 15
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
        burnValue: params.stampValueWei,
        gasReserve: params.gasReserve,
        onFunded: result => {
          funded.push(result)
          remaining = remaining.filter(target => target.index !== result.index)
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isNonceRace = /nonce|higher priority|already known/i.test(message)
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

/** Loads the operator-supplied main wallet (`{address, privateKey}` JSON at `mainWalletJsonPath`)
 * as a transfer signer. The key is only ever passed to the signer, never logged. Shared by the
 * stamp-funded bots and the faucet (#316), which needs no stamp pool. */
export function loadMainAccountSigner(params: {
  rpcUrl: string
  mainWalletJsonPath: string
  httpClient?: MonadHttpClient
}): { provider: JsonRpcProvider; mainAccountSigner: MonadAccountTxSigner } {
  const provider = new JsonRpcProvider(params.rpcUrl)
  const httpClient =
    params.httpClient ?? new MonadHttpClient({ rpcUrl: params.rpcUrl })
  const mainWallet = JSON.parse(
    readFileSync(params.mainWalletJsonPath, 'utf8'),
  ) as { address: string; privateKey: string }
  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainWallet.privateKey,
    provider,
    httpClient,
  })
  return { provider, mainAccountSigner }
}

/**
 * Opens one seed-bound durable wallet bundle and wires up a `MonadStampClient` ready to send
 * Stamp-over-Monad messages against the main funded testnet wallet at `mainWalletJsonPath`.
 *
 * **Lazy per-send funding (direct user feedback, 2026-09-28):** this used to eagerly pre-fund
 * `poolSize` sub-accounts all at once via `fundPoolWithRetry`, sized to `maxReplies + maxGreetings`
 * by callers -- which meant a long-running bot with generous limits fired a burst of dozens (or,
 * mistakenly, thousands) of near-simultaneous funding transactions from one account before ever
 * reaching its message-polling loop, hitting exactly the nonce contention `fundPoolWithRetry`'s own
 * header describes, with no bound on how bad a large `poolSize` makes it. The real app's own send
 * path (`ActiveChain.directMessages.send`, `chain/monad-chain.ts`) never pre-funds like this --
 * it calls `pool.prepareStampInventory()` right before each individual send, topping up only the
 * shortfall (default buffer of `DEFAULT_TOPUP_BUFFER_SIZE = 5`, see `monad-account-pool.ts`).
 * `sendDirectMessageText` (below) now does the same. `poolSize` stays as an opt-in for a caller
 * that genuinely needs a pool pre-funded before its first send (`monad-ui-verify.livecheck.ts`
 * grafts this pool onto an otherwise-unfunded wallet specifically so it doesn't need to) --
 * omitting it (or passing `0`) skips eager funding entirely, which is what both bot scripts do now.
 *
 * See this file's header for how `gasReserve` is sized against this ticket's very tight remaining
 * testnet balance.
 */
export async function setUpFundedStampClient(params: {
  rpcUrl: string
  relayBaseUrl: string
  mainWalletJsonPath: string
  poolSize?: number
  stampValueWei: bigint
  label: string
  /** Existing bots keep their established pool layout. Qwen uses the durable bundle setup below. */
  stateDir?: string
}): Promise<FundedStampSetup> {
  const httpClient = new MonadHttpClient({ rpcUrl: params.rpcUrl })
  const { provider, mainAccountSigner } = loadMainAccountSigner({
    rpcUrl: params.rpcUrl,
    mainWalletJsonPath: params.mainWalletJsonPath,
    httpClient,
  })
  console.log(
    `[${params.label}] main funding account: ${mainAccountSigner.address}`,
  )

  let pool: MonadSubAccountPool
  let changePool: MonadChangePool
  let closePool: () => Promise<void> = async () => {}
  if (params.stateDir) {
    ;({
      pool,
      changePool,
      close: closePool,
    } = await openPersistentStampPool(params.stateDir, params.label))
  } else {
    const { keyring, mnemonic } = MonadHdKeyring.generate()
    pool = new MonadSubAccountPool({ keyring })
    changePool = new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(mnemonic),
    })
  }

  if (params.poolSize) {
    pool.ensureSize(params.poolSize)
    await fundConfiguredPool({
      pool,
      provider,
      mainAccountSigner,
      stampValueWei: params.stampValueWei,
      label: params.label,
    })
  }

  const leaseManager = new SubAccountLeaseManager(pool)
  const stampClient = new MonadStampClient({
    pool,
    leaseManager,
    provider,
    httpClient,
    changePool,
    relayBaseUrl: params.relayBaseUrl,
  })

  return { provider, stampClient, mainAccountSigner, pool, closePool }
}

async function fundConfiguredPool(params: {
  pool: MonadSubAccountPool
  provider: JsonRpcProvider
  mainAccountSigner: MonadAccountTxSigner
  stampValueWei: bigint
  label: string
}): Promise<void> {
  const feeData = await params.provider.getFeeData()
  const fallbackMaxFeePerGas = BigInt(250000000000)
  const maxFeePerGas = feeData.maxFeePerGas ?? fallbackMaxFeePerGas
  const estimatedStampGasLimit = BigInt(23000)
  const gasReserve =
    (maxFeePerGas * estimatedStampGasLimit * BigInt(11)) / BigInt(10)
  console.log(
    `[${params.label}] maxFeePerGas=${maxFeePerGas} wei; funding each sub-account with stampValue=${params.stampValueWei} + gasReserve=${gasReserve} wei`,
  )

  const funded = await fundPoolWithRetry({
    pool: params.pool,
    mainAccountSigner: params.mainAccountSigner,
    stampValueWei: params.stampValueWei,
    gasReserve,
    label: params.label,
  })
  for (const funding of funded) {
    console.log(
      `[${params.label}] funded ${funding.address} (sub-account ${funding.index}) with ${funding.fundedValue} wei, tx ${funding.txHash}`,
    )
    await waitForConfirmation(
      params.mainAccountSigner,
      funding.txHash,
      `${params.label} funding tx (sub-account ${funding.index})`,
    )
    console.log(
      `[${params.label}] funding tx for sub-account ${funding.index} confirmed on-chain`,
    )
  }
}

/** Opens Qwen's complete crash-recoverable sender state without changing the storage contract of
 * the other bots that share `setUpFundedStampClient`. */
export async function setUpDurableFundedStampClient(params: {
  rpcUrl: string
  relayBaseUrl: string
  mainWalletJsonPath: string
  /** Stable root for the HD seed, account pools, and exact payment journals. */
  stateRoot: string
  poolSize?: number
  stampValueWei: bigint
  label: string
  /** Deterministic no-network test seams. Production callers omit both. */
  provider?: JsonRpcProvider
  httpClient?: MonadTxSubmitter
}): Promise<DurableFundedStampSetup> {
  const ownsProvider = params.provider === undefined
  const provider = params.provider ?? new JsonRpcProvider(params.rpcUrl)
  const httpClient =
    params.httpClient ?? new MonadHttpClient({ rpcUrl: params.rpcUrl })

  const mainWallet = JSON.parse(
    readFileSync(params.mainWalletJsonPath, 'utf8'),
  ) as { address: string; privateKey: string }
  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainWallet.privateKey,
    provider,
    httpClient,
  })
  console.log(
    `[${params.label}] main funding account: ${mainAccountSigner.address}`,
  )

  let walletState: MonadWalletPersistenceBundle | undefined
  let stampAttemptJournal: LevelStampAttemptJournal | undefined
  let stampPaymentJournal: LevelStampPaymentJournal | undefined
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    const closeErrors: unknown[] = []
    for (const closeOne of [
      () => stampAttemptJournal?.Close(),
      () => stampPaymentJournal?.Close(),
      () => walletState?.close(),
    ]) {
      try {
        await closeOne()
      } catch (err) {
        closeErrors.push(err)
      }
    }
    if (ownsProvider) provider.destroy()
    if (closeErrors.length > 0) throw closeErrors[0]
  }

  try {
    walletState = await openMonadWalletBundle({
      location: params.stateRoot,
      createSeedIfEmpty: true,
      mode: 'create',
    })
    stampAttemptJournal = new LevelStampAttemptJournal(params.stateRoot)
    stampPaymentJournal = new LevelStampPaymentJournal(params.stateRoot)
    await Promise.all([stampAttemptJournal.Open(), stampPaymentJournal.Open()])
    const pool = walletState.pool
    const stampClient = new MonadStampClient({
      pool,
      leaseManager: walletState.leaseManager,
      provider,
      httpClient,
      changePool: walletState.changePool,
      stampAttemptJournal,
      stampPaymentJournal,
      walletState,
      relayBaseUrl: params.relayBaseUrl,
    })
    // Replay exact retained bytes before this process is allowed to fund or sign a replacement.
    await stampClient.resumePendingAttempts()

    if (params.poolSize) {
      pool.ensureSize(params.poolSize)
      await fundConfiguredPool({
        pool,
        provider,
        mainAccountSigner,
        stampValueWei: params.stampValueWei,
        label: params.label,
      })
    }

    return {
      provider,
      stampClient,
      walletState,
      mainAccountSigner,
      pool,
      close,
    }
  } catch (err) {
    try {
      await close()
    } catch {
      // Preserve the startup/reconciliation error that made the setup unusable.
    }
    throw err
  }
}

/**
 * Tops up `pool` with only whatever it's short of for one stamp payment of `stampValueWei`
 * (mirroring `ActiveChain.directMessages.send`'s own call, `chain/monad-chain.ts`), builds the
 * E2E-encrypted envelope for `items` (the real UI's `MessageItem[]` wire shape -- see
 * `qwen-bot.livecheck.ts`'s `extractText` doc comment for why), and sends it as a stamped direct
 * message via `stampClient.submitStampedMessage`, paying `toAddress` itself (ticket #57: a DM's
 * stamp always pays its recipient, never a fixed burn address).
 *
 * Ticket #77: factored out of `qwen-bot.livecheck.ts`'s reply-sending logic and
 * `qwen-bot-send-demo.livecheck.ts`'s outgoing-message logic (which duplicated this exact
 * build-envelope-then-submit sequence) so the new auto-greet behavior can reuse the same real
 * DM-sending path instead of a third copy of it. The lazy top-up (2026-09-28) was folded in here
 * rather than left to each call site, so every caller gets it for free -- see
 * `setUpFundedStampClient`'s own header for why this replaced pre-funding a big pool up front.
 * Generalized from a text-only `sendDirectMessageText` (2026-09-28) once the blackjack bot needed
 * to send a `blackjack-move` item instead of plain text -- see `sendDirectMessageText` below,
 * which is now just a one-line wrapper over this for the (still very common) plain-text case.
 */
export async function sendDirectMessageItems(params: {
  stampClient: MonadStampClient
  pool: MonadSubAccountPool
  mainAccountSigner: MonadAccountTxSigner
  provider: Provider
  fromIdentity: MonadIdentity
  toAddress: string
  toPubKey: Buffer
  items: MessageItem[]
  stampValueWei: bigint
  networkTag: string
}): Promise<StampMonadMessageResult> {
  const gasReserveWei = await quoteMonadStampPaymentGasReserve({
    signer: params.mainAccountSigner,
    recipientPublicKey: params.toPubKey,
  })
  await params.pool.prepareStampInventory({
    mainAccountSigner: params.mainAccountSigner,
    provider: params.provider,
    stampValueWei: params.stampValueWei,
    gasReserveWei,
  })

  const envelope = buildEnvelope({
    fromAddress: params.fromIdentity.displayAddress,
    fromPrivateKey: params.fromIdentity.toNakamotoPrivateKey(),
    toAddress: params.toAddress,
    toPubKey: params.toPubKey,
    plaintext: serializeMessageItems(params.items),
    networkTag: params.networkTag,
  })
  return params.stampClient.submitStampedMessage({
    encryptedPayload: envelope,
    recipientPublicKey: params.toPubKey,
    stampValueWei: params.stampValueWei,
  })
}

export async function sendDirectMessageText(params: {
  stampClient: MonadStampClient
  pool: MonadSubAccountPool
  mainAccountSigner: MonadAccountTxSigner
  provider: Provider
  fromIdentity: MonadIdentity
  toAddress: string
  toPubKey: Buffer
  text: string
  stampValueWei: bigint
  networkTag: string
}): Promise<StampMonadMessageResult> {
  return sendDirectMessageItems({
    ...params,
    items: [{ type: 'text', text: params.text }],
  })
}

/** Installed-directory view for the canonical bot (#778). Every call returns a fresh admitted
 * snapshot from the public directory store; a peer is known only by admitted evidence for an
 * operator-installed subject, never by a profile lookup or a fixture table. Structurally the
 * same shape the typed wallet's own canonical messaging consumes. */
export interface QwenCanonicalDirectory {
  /** Canonical network identifier of every installed subject, e.g. `monad-testnet`. */
  readonly network: string
  /** Exact installed HTTPS root endpoint of the bot's home relay. */
  readonly homeEndpoint: string
  /** The bot's own compressed identity point P, lowercase hex. */
  readonly selfSubject: string
  selfCurrent(): Promise<Current>
  /** `undefined` when that subject is not installed or has no admitted evidence yet. */
  peerCurrent(subject: string): Promise<Current | undefined>
}

export interface CanonicalQwenSetup {
  /** The typed economic account that pays reply stamps. Public; safe to log. */
  accountAddress: string
  /** The bot's identity address (derived from P): its canonical mailbox address. */
  identityAddress: string
  /** The #703 outbound boundary handed to `QwenResponseWorkflow`. */
  sender: QwenCanonicalSender
  /** The #778 inbound source handed to `QwenInboundWorkflow`. */
  inbound: QwenCanonicalInbound
  /** Closes the one wallet owner and wipes the sealing material. */
  close(): Promise<void>
}

/** The env-configured chain row with Qwen's own relay and a durable canonical wallet root. */
export function qwenCanonicalChainConfig(params: {
  relayBaseUrl: string
  walletStorageLocation: string
  stampValueWei: bigint
}): MonadChainConfig {
  return {
    ...loadMonadChainConfigFromEnv(),
    relayBaseUrl: params.relayBaseUrl,
    walletStorageLocation: params.walletStorageLocation,
    defaultStampValueWei: params.stampValueWei,
  }
}

const ROOT_PURPOSES = {
  evm: 'evm-wallet',
  authentication: 'identity-authentication',
  messaging: 'messaging-encryption',
} as const

/** Loads an operator-provisioned typed root bundle. It NEVER creates one: a new identity needs
 * directory enrollment and trust installation, which are outside this bot (#778). Failures name
 * only the path, never file contents. */
export function loadQwenCanonicalRoots(rootsJsonPath: string): MonadRootBundle {
  const invalid = () =>
    new Error(
      `Qwen canonical roots at ${rootsJsonPath} are missing or not a frank-domain-roots-v1 bundle`,
    )
  let saved: { registry?: unknown; roots?: Record<string, unknown> }
  try {
    saved = JSON.parse(readFileSync(rootsJsonPath, 'utf8'))
  } catch {
    throw invalid()
  }
  if (
    !saved ||
    saved.registry !== 'frank-domain-roots-v1' ||
    !saved.roots ||
    typeof saved.roots !== 'object'
  )
    throw invalid()
  const root = <P extends (typeof ROOT_PURPOSES)[keyof typeof ROOT_PURPOSES]>(
    purpose: P,
  ) => {
    const hex = saved.roots![purpose]
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw invalid()
    return {
      registry: 'frank-domain-roots-v1' as const,
      purpose,
      bytes: new Uint8Array(Buffer.from(hex, 'hex')),
    }
  }
  return {
    evm: root(ROOT_PURPOSES.evm),
    authentication: root(ROOT_PURPOSES.authentication),
    messaging: root(ROOT_PURPOSES.messaging),
  }
}

/**
 * #703 canonical sender composition. Opens the one typed wallet owner through the public chain
 * factory and takes its canonical consumer through the wallet's own bridge; nothing here signs,
 * funds, resumes or contacts the relay. Replay of retained attempts happens only later, after
 * the caller has opened Qwen's response state and `QwenResponseWorkflow.recover()` has
 * correlated every retained wallet record with a saved turn.
 *
 * The legacy `setUpDurableFundedStampClient`/`sendDirectMessageItems` helpers above are left
 * exactly as they were for the other bots and for Qwen's greeting path.
 */
export async function setUpCanonicalQwenSender(params: {
  chain: MonadChainConfig
  roots: MonadRootBundle
  directory: QwenCanonicalDirectory
  /** Optional wallet-owned inventory preparation; see `QwenCanonicalSender.prepareInventory`. */
  prepareInventory?: () => Promise<void>
  overrides?: MonadTxOverrides
  /** Deterministic no-network test seam. Production callers omit it. */
  fetch?: CanonicalFetch
  label: string
}): Promise<CanonicalQwenSetup> {
  if (params.chain.networkTag !== 'MONT' && params.chain.networkTag !== 'MON1')
    throw new Error('Qwen canonical sender requires an installed Monad network')
  if (params.chain.walletStorageLocation === false)
    throw new Error('Qwen canonical sender requires durable wallet storage')
  const network = canonicalNetworkDescriptor(params.chain.networkTag).network
  // Sealing capability only. It derives no account, pool or signer and is never persisted.
  const material = createMonadWalletMaterial(params.roots)
  let wallet: { close(): Promise<void> } | undefined
  try {
    const roles = material.canonicalRoles
    if (!roles) throw new Error('Qwen canonical sender requires typed roots')
    const accountAddress = material.mainAccount.address
    // Checked before any wallet store is opened or bound.
    const subject = Buffer.from(
      roles.publicGenerationZeroPoints().auth,
    ).toString('hex')
    if (subject !== params.directory.selfSubject)
      throw new Error('Qwen roots differ from the installed directory subject')
    const opened = await createMonadChain(params.chain).createWallet(
      params.roots,
    )
    wallet = opened
    const client = canonicalMonadStampClient(opened)
    console.log(`[${params.label}] canonical stamp account: ${accountAddress}`)
    let closed = false
    const identityAddress = computeAddress('0x' + subject).toLowerCase()
    const mailbox: CanonicalMailboxAuthParams = {
      relayBaseUrl: params.directory.homeEndpoint,
      recipient: identityAddress,
      expectedNetworkTag: params.chain.networkTag,
      subject,
      getCurrent: () => params.directory.selfCurrent(),
      signDigest: digest => material.identity.signHash(Buffer.from(digest)),
      fetch: params.fetch,
    }
    return {
      accountAddress,
      identityAddress,
      inbound: {
        network,
        subject,
        recipient: identityAddress,
        relayBaseUrl: params.directory.homeEndpoint,
        fetchPage: page => fetchCanonicalInboxPage({ ...mailbox, ...page }),
        selfCurrent: () => params.directory.selfCurrent(),
        peerCurrent: peer => params.directory.peerCurrent(peer),
        roles: self => roles.create(network, self),
      },
      sender: {
        wallet: client,
        // The peer is the subject the inbound envelope was opened under, resolved again
        // through admitted directory evidence for every preparation.
        currents: async row => {
          const recipientCurrent = await params.directory.peerCurrent(
            row.senderPubKeyHex,
          )
          return recipientCurrent
            ? {
                senderCurrent: await params.directory.selfCurrent(),
                recipientCurrent,
              }
            : undefined
        },
        seal: (row, currents) => {
          const session = roles.create(network, currents.senderCurrent)
          try {
            const sealed = prepareDirectMessage({
              network,
              senderCurrent: currents.senderCurrent,
              recipientCurrent: currents.recipientCurrent,
              messageId: new Uint8Array(randomBytes(16)),
              items: [directMessageText(row.response)],
              roles: session,
            })
            // Only opaque bytes and public identity leave this function. The authenticated
            // plaintext fields of the producer result are never copied or stored.
            return {
              payload: sealed.payload,
              context: sealed.context,
              t3: sealed.t3,
              messageId: sealed.messageId,
              contentDigest: sealed.contentDigest,
            }
          } finally {
            session.dispose()
          }
        },
        prepareInventory: params.prepareInventory,
        overrides: params.overrides,
        fetch: params.fetch,
      },
      close: async () => {
        if (closed) return
        closed = true
        try {
          await opened.close()
        } finally {
          material.dispose()
        }
      },
    }
  } catch (error) {
    try {
      await wallet?.close()
    } catch {
      // Preserve the setup error.
    }
    material.dispose()
    throw error
  }
}

// ---- #778 operator-installed public configuration ------------------------------------------
//
// The bot reads the same two public files the operator installs for the app: the bootstrap
// policy (which relays exist and for how long an export is valid) and the approved bundle (the
// exact signed revision-zero evidence of every installed subject). Both are public. This reader
// takes only the fields the bot acts on and checks them strictly; it does NOT recompute the
// bundle/configuration identities, whose comparator currently lives only in the app
// (`app/src/utils/directory-provisioning.ts`) and has to move to a shared package before the
// bot can verify it or publish its own installation snapshot.

interface HomeTuple {
  id: string
  endpoint: string
  key: string
  expiryNs: string
}
export interface QwenBootstrapPolicy {
  policyIdentity: string
  networkTag: 'MONT' | 'MON1'
  network: string
  chainId: string
  issuedAtNs: string
  expiresAtNs: string
  relays: Array<
    HomeTuple & { processId: 'relay-a' | 'relay-b'; origin: string }
  >
}
export interface QwenInstalledSubject {
  role: 'ui' | 'bot'
  network: string
  subjectP: string
  revisionZeroT1: string
  statement: Uint8Array
  attestation: Uint8Array
  homeProcessId: 'relay-a' | 'relay-b'
  relay: HomeTuple
}
export interface QwenApprovedBundle {
  bundleIdentity: string
  bootstrapPolicyIdentity: string
  subjects: QwenInstalledSubject[]
}
/** Same public shape the app exports for the operator. Public bytes and points only. */
export interface QwenPublicExportFile {
  version: 1
  kind: 'public-revision-zero-export'
  bootstrapPolicyIdentity: string
  networkTag: 'MONT' | 'MON1'
  network: string
  chainId: string
  subjectP: string
  authAddress: string
  messagePoint: string
  stampPoint: string
  revisionZeroT1: string
  statement: string
  attestation: string
  homeProcessId: 'relay-a' | 'relay-b'
}

const provisioningInvalid = (what: string) =>
  new Error(`Invalid public directory ${what}; refusing to start`)
const isHex = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' &&
  new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)
const isPoint = (value: unknown): value is string =>
  typeof value === 'string' && /^(02|03)[0-9a-f]{64}$/.test(value)
const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value)
const isProcess = (value: unknown): value is 'relay-a' | 'relay-b' =>
  value === 'relay-a' || value === 'relay-b'
function httpsRoot(value: unknown): string {
  if (typeof value !== 'string') throw new Error('endpoint')
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('endpoint')
  return value
}
function homeTuple(value: unknown): HomeTuple {
  const tuple = value as HomeTuple
  if (
    !tuple ||
    !isHex(tuple.id, 16) ||
    !isPoint(tuple.key) ||
    !isDecimal(tuple.expiryNs)
  )
    throw new Error('tuple')
  return {
    id: tuple.id,
    endpoint: httpsRoot(tuple.endpoint),
    key: tuple.key,
    expiryNs: tuple.expiryNs,
  }
}
const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64url')
function fromBase64url(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,349526}$/.test(value))
    throw new Error('base64url')
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'))
  if (base64url(bytes) !== value) throw new Error('base64url')
  return bytes
}
const nsTimestamp = (ns: bigint) => ({
  seconds: ns / 1_000_000_000n,
  nanoseconds: Number(ns % 1_000_000_000n),
})
const relayBinding = (tuple: HomeTuple): RelayBinding => ({
  relayId: new Uint8Array(Buffer.from(tuple.id, 'hex')),
  endpoint: tuple.endpoint,
  identity: {
    keyType: 1,
    keyBytes: new Uint8Array(Buffer.from(tuple.key, 'hex')),
  },
  expiry: nsTimestamp(BigInt(tuple.expiryNs)),
  unknownFields: new Map(),
})

export function readQwenBootstrapPolicy(path: string): QwenBootstrapPolicy {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (
      raw.version !== 1 ||
      raw.kind !== 'directory-bootstrap-process-policy' ||
      !isHex(raw.policyIdentity, 32) ||
      !(
        (raw.networkTag === 'MONT' &&
          raw.network === 'monad-testnet' &&
          raw.chainId === '10143') ||
        (raw.networkTag === 'MON1' &&
          raw.network === 'monad-mainnet' &&
          raw.chainId === '143')
      ) ||
      !Array.isArray(raw.relayTuples) ||
      raw.relayTuples.length !== 2 ||
      !Array.isArray(raw.participants) ||
      !isDecimal(raw.exportValidity?.issuedAtNs) ||
      !isDecimal(raw.exportValidity?.expiresAtNs) ||
      BigInt(raw.exportValidity.expiresAtNs) <=
        BigInt(raw.exportValidity.issuedAtNs)
    )
      throw new Error('policy')
    const relays = raw.relayTuples.map(
      (tuple: HomeTuple & { processId: unknown }) => {
        if (!isProcess(tuple.processId)) throw new Error('process')
        const origin = raw.participants.find(
          (p: { processId: unknown }) => p.processId === tuple.processId,
        )?.origin
        const checked = homeTuple(tuple)
        if (new URL(checked.endpoint).origin !== origin)
          throw new Error('origin')
        return { ...checked, processId: tuple.processId, origin }
      },
    )
    if (
      new Set(relays.map((r: { processId: string }) => r.processId)).size !== 2
    )
      throw new Error('process')
    return {
      policyIdentity: raw.policyIdentity,
      networkTag: raw.networkTag,
      network: raw.network,
      chainId: raw.chainId,
      issuedAtNs: raw.exportValidity.issuedAtNs,
      expiresAtNs: raw.exportValidity.expiresAtNs,
      relays,
    }
  } catch {
    throw provisioningInvalid('bootstrap policy')
  }
}

export function readQwenApprovedBundle(path: string): QwenApprovedBundle {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (
      raw.version !== 1 ||
      raw.kind !== 'operator-approved-directory-bundle' ||
      !isHex(raw.bundleIdentity, 32) ||
      !isHex(raw.bootstrapPolicyIdentity, 32) ||
      !Array.isArray(raw.subjects) ||
      raw.subjects.length < 1 ||
      raw.subjects.length > 1024
    )
      throw new Error('bundle')
    const subjects = raw.subjects.map(
      (subject: Record<string, unknown>): QwenInstalledSubject => {
        if (
          (subject.role !== 'ui' && subject.role !== 'bot') ||
          typeof subject.network !== 'string' ||
          !isPoint(subject.subjectP) ||
          !isHex(subject.revisionZeroT1, 32) ||
          !isProcess(subject.homeProcessId)
        )
          throw new Error('subject')
        return {
          role: subject.role,
          network: subject.network,
          subjectP: subject.subjectP,
          revisionZeroT1: subject.revisionZeroT1,
          statement: fromBase64url(subject.statement),
          attestation: fromBase64url(subject.attestation),
          homeProcessId: subject.homeProcessId,
          relay: homeTuple(subject.relay),
        }
      },
    )
    if (
      new Set(subjects.map((s: QwenInstalledSubject) => s.subjectP)).size !==
      subjects.length
    )
      throw new Error('subject')
    return {
      bundleIdentity: raw.bundleIdentity,
      bootstrapPolicyIdentity: raw.bootstrapPolicyIdentity,
      subjects,
    }
  } catch {
    throw provisioningInvalid('approved bundle')
  }
}

/** The bot's own public revision-zero export for the operator. Signs one public statement with
 * the identity key; opens no wallet, funds nothing, contacts nothing, and returns no root,
 * private leaf or recovery material. */
export function prepareQwenPublicExport(params: {
  roots: MonadRootBundle
  policy: QwenBootstrapPolicy
  home: 'relay-a' | 'relay-b'
  nowNs: bigint
}): QwenPublicExportFile {
  const { policy } = params
  if (
    params.nowNs < BigInt(policy.issuedAtNs) ||
    params.nowNs >= BigInt(policy.expiresAtNs)
  )
    throw new Error('Bootstrap policy export window is not current')
  const process = (processId: 'relay-a' | 'relay-b') => {
    const relay = policy.relays.find(r => r.processId === processId)!
    return { processId, origin: relay.origin, tuple: relayBinding(relay) }
  }
  const material = createMonadWalletMaterial(params.roots)
  try {
    if (!material.canonicalRoles)
      throw new Error('Qwen public export requires typed roots')
    const exported = material.canonicalRoles.prepareRevisionZero({
      networkTag: policy.networkTag,
      network: policy.network,
      chainId: BigInt(policy.chainId),
      issuedAt: nsTimestamp(BigInt(policy.issuedAtNs)),
      expiresAt: nsTimestamp(BigInt(policy.expiresAtNs)),
      now: nsTimestamp(params.nowNs),
      relayA: process('relay-a'),
      relayB: process('relay-b'),
      subjectBinding: params.home === 'relay-a' ? 'A' : 'B',
    })
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
    return {
      version: 1,
      kind: 'public-revision-zero-export',
      bootstrapPolicyIdentity: policy.policyIdentity,
      networkTag: exported.networkTag,
      network: exported.network,
      chainId: exported.chainId.toString(),
      subjectP: hex(exported.auth.compressedPoint),
      authAddress: exported.authAddress,
      messagePoint: hex(exported.message.compressedPoint),
      stampPoint: hex(exported.stamp.compressedPoint),
      revisionZeroT1: hex(exported.t1),
      statement: base64url(exported.statement),
      attestation: base64url(exported.attestation),
      homeProcessId: params.home,
    }
  } finally {
    material.dispose()
  }
}

function checkpointText(checkpoint: Checkpoint): string {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
  return JSON.stringify({
    kind: checkpoint.kind,
    identity: hex(checkpoint.identity),
    anchor: hex(checkpoint.anchor),
    head: checkpoint.head ? hex(checkpoint.head) : null,
    accepted: checkpoint.accepted,
    retained: checkpoint.retained,
    evidenceDigest: hex(checkpoint.evidenceDigest),
    checkedTime: {
      seconds: checkpoint.checkedTime.seconds.toString(),
      nanoseconds: checkpoint.checkedTime.nanoseconds,
    },
    forked: checkpoint.forked,
  })
}
function checkpointFrom(text: string): Checkpoint {
  const saved = JSON.parse(text)
  const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
  return {
    kind: saved.kind,
    identity: bytes(saved.identity),
    anchor: bytes(saved.anchor),
    head: saved.head === null ? null : bytes(saved.head),
    accepted: saved.accepted,
    retained: saved.retained,
    evidenceDigest: bytes(saved.evidenceDigest),
    checkedTime: {
      seconds: BigInt(saved.checkedTime.seconds),
      nanoseconds: saved.checkedTime.nanoseconds,
    },
    forked: saved.forked,
  }
}

/**
 * Opens the bot's installed directory through the public Node directory store and the public
 * directory client. The bot's own subject must be exactly the evidence its roots produce for the
 * installed policy; its revision zero is published to its home relay on every start. Each peer
 * is one installed `ui` subject, admitted from that subject's home relay on first use and then
 * re-read from the relay at most every `peerRefreshMs`. Whole checkpoints are kept in files
 * outside the admission databases. Nothing here enrolls a subject the operator did not install.
 */
export async function openQwenInstalledDirectory(params: {
  roots: MonadRootBundle
  policy: QwenBootstrapPolicy
  bundle: QwenApprovedBundle
  /** Durable directory root, separate from wallet and bot state. */
  location: string
  fetch: DirectoryFetch
  nowNs?: () => bigint
  peerRefreshMs?: number
}): Promise<QwenCanonicalDirectory & { close(): Promise<void> }> {
  const { bundle, policy } = params
  if (bundle.bootstrapPolicyIdentity !== policy.policyIdentity)
    throw new Error('Approved bundle belongs to a different bootstrap policy')
  const own = bundle.subjects.filter(subject => subject.role === 'bot')
  if (own.length !== 1)
    throw new Error('Approved bundle must install exactly one bot subject')
  const self = own[0]
  const nowNs = params.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n)
  // The bundle must carry this bot's own exact signed bytes, not merely its key or T1.
  const expected = prepareQwenPublicExport({
    roots: params.roots,
    policy,
    home: self.homeProcessId,
    nowNs: BigInt(policy.issuedAtNs),
  })
  if (
    expected.subjectP !== self.subjectP ||
    expected.network !== self.network ||
    expected.revisionZeroT1 !== self.revisionZeroT1 ||
    expected.statement !== base64url(self.statement) ||
    expected.attestation !== base64url(self.attestation)
  )
    throw new Error("Approved bundle does not carry this bot's own evidence")
  for (const subject of bundle.subjects) {
    const installed = policy.relays.find(
      relay => relay.processId === subject.homeProcessId,
    )
    if (
      subject.network !== policy.network ||
      !installed ||
      installed.id !== subject.relay.id ||
      installed.key !== subject.relay.key ||
      installed.endpoint !== subject.relay.endpoint ||
      installed.expiryNs !== subject.relay.expiryNs
    )
      throw new Error('Approved subject is not homed on an installed relay')
  }
  mkdirSync(params.location, { recursive: true })
  const opened: Array<{ close(): Promise<void> }> = []
  const open = async (subject: QwenInstalledSubject) => {
    const name = `${subject.network}-${subject.subjectP}-${subject.revisionZeroT1}`
    const checkpointPath = join(params.location, `${name}.checkpoint.json`)
    const checkpoint = existsSync(checkpointPath)
      ? checkpointFrom(readFileSync(checkpointPath, 'utf8'))
      : undefined
    const store = await openNodeDirectoryStore({
      location: join(params.location, name),
      anchor: {
        network: subject.network,
        subject: {
          keyType: 1,
          keyBytes: new Uint8Array(Buffer.from(subject.subjectP, 'hex')),
        },
        revisionZero: new Uint8Array(
          Buffer.from(subject.revisionZeroT1, 'hex'),
        ),
      },
      mode: checkpoint ? { kind: 'reopen', checkpoint } : { kind: 'new' },
    })
    opened.push(store)
    const context = () => ({
      now: nsTimestamp(nowNs()),
      relay: relayBinding(subject.relay),
    })
    const client = createDirectoryClient({
      network: subject.network,
      subject: subject.subjectP,
      endpoint: subject.relay.endpoint,
      store,
      context,
      saveCheckpoint: async saved => {
        // Whole checkpoint, replaced atomically, outside the admission database.
        writeFileSync(checkpointPath + '.tmp', checkpointText(saved), {
          mode: 0o600,
        })
        renameSync(checkpointPath + '.tmp', checkpointPath)
      },
      fetch: params.fetch,
    })
    return { store, client, context }
  }
  try {
    const home = await open(self)
    // Own subject only: publish the exact installed attestation to the home relay on every
    // start (idempotent there) and admit the relay's answer. No other subject is ever enrolled
    // from the installed file.
    await home.client.put(await home.client.preparePut(self.attestation))
    const peers = new Map<
      string,
      { opened?: Awaited<ReturnType<typeof open>>; refreshed: number }
    >()
    const refreshMs = params.peerRefreshMs ?? 30_000
    return {
      network: self.network,
      homeEndpoint: self.relay.endpoint,
      selfSubject: self.subjectP,
      selfCurrent: () => home.store.current(home.context()),
      async peerCurrent(subjectP) {
        const subject = bundle.subjects.find(
          candidate =>
            candidate.role === 'ui' && candidate.subjectP === subjectP,
        )
        if (!subject) return undefined
        let peer = peers.get(subjectP)
        if (!peer) peers.set(subjectP, (peer = { refreshed: 0 }))
        try {
          peer.opened ??= await open(subject)
          // A peer is only ever read; its owner publishes it.
          if (
            !(await peer.opened.store.status()) ||
            Date.now() - peer.refreshed >= refreshMs
          ) {
            const admitted = await peer.opened.client.current()
            peer.refreshed = Date.now()
            return admitted.current
          }
          return await peer.opened.store.current(peer.opened.context())
        } catch {
          // Not published yet, unreachable, expired or forked: not usable now.
          return undefined
        }
      },
      close: async () => {
        for (const store of opened.splice(0))
          await store.close().catch(() => undefined)
      },
    }
  } catch (error) {
    for (const store of opened.splice(0))
      await store.close().catch(() => undefined)
    throw error
  }
}

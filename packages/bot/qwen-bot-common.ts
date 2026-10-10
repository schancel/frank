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
 * ## Pre-funding a pool (`poolSize`)
 *
 * Both bot scripts fund lazily per send (`sendDirectMessageText`'s `pool.prepareStampInventory`
 * call). A caller that needs accounts funded before its first send passes a nonzero `poolSize`
 * (`monad-ui-verify.livecheck.ts`); that goes through `MonadSubAccountPool.topUpPool`, the pool's
 * recorded funding path: each transfer's signed bytes are stored before they are submitted, and a
 * retry resumes that transfer instead of signing another for the same account.
 */
import { readFileSync, existsSync, statSync, writeFileSync } from 'fs'
import { JsonRpcProvider, Provider } from 'ethers'

import { MonadHttpClient } from '@frank/wallet/monad-http'
import {
  MonadAccountTxSigner,
  MonadTxSubmitter,
} from '@frank/wallet/monad-account-tx'
import { MonadHdKeyring } from '@frank/wallet/monad-hd-keyring'
import { MonadChangeKeyring } from '@frank/wallet/monad-change-keyring'
import { MonadChangePool } from '@frank/wallet/monad-change-pool'
import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
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
  registerMonadIdentityCbor,
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
  createEvmChain,
  loadMonadChainConfigFromEnv,
} from "@frank/wallet/chain/monad-chain";
import type { EvmChainConfig } from "@frank/wallet/chain/evm-chain-config";
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import { computeAddress } from 'ethers'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Current } from '@frank/directory-admission'
import type { DirectoryFetch } from '@frank/cashweb/relay/directory-client'
import { directoryAddress } from '@frank/cashweb/relay/open-directory'
import {
  isOpenDirectoryError,
  openBotDirectory,
  publishBotDirectoryEntry,
} from './bot-open-directory'
import {
  fetchCanonicalInboxPage,
  type CanonicalMailboxAuthParams,
} from '@frank/cashweb/relay/monad-mailbox-client'
import {
  createCanonicalMessageRoles,
  prepareCanonicalStampInventory,
} from "@frank/wallet/chain/monad-chain";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";
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
  await registerMonadIdentityCbor({
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
 * `poolSize` sub-accounts all at once, sized to `maxReplies + maxGreetings` by callers -- which
 * meant a long-running bot with generous limits fired a burst of dozens (or, mistakenly,
 * thousands) of near-simultaneous funding transactions from one account before ever reaching its
 * message-polling loop, with no bound on how bad a large `poolSize` makes it. The real app's own send
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
    await fundConfiguredPool({
      pool,
      poolSize: params.poolSize,
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

/** Brings the pool's funded, unused accounts up to `poolSize` through its recorded funding path
 * (`topUpPool`): each transfer is stored before it is submitted and confirmed by its receipt. */
async function fundConfiguredPool(params: {
  pool: MonadSubAccountPool
  poolSize: number
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

  const funded = await params.pool.topUpPool({
    mainAccountSigner: params.mainAccountSigner,
    burnValue: params.stampValueWei,
    gasReserve,
    bufferSize: params.poolSize,
  })
  for (const funding of funded) {
    console.log(
      `[${params.label}] funded ${funding.address} (sub-account ${funding.index}) with ${funding.fundedValue} wei, tx ${funding.txHash} (confirmed)`,
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
      await fundConfiguredPool({
        pool,
        poolSize: params.poolSize,
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

/** Open-directory view for the canonical bot. Every account signs its own entry and nobody
 * approves it, so a peer is any key whose published entry verifies: signed by the key that
 * hashes to its address, unexpired, and on the chain first seen for that address. */
export interface QwenCanonicalDirectory {
  /** Canonical network identifier of every entry, e.g. `monad-testnet`. */
  readonly network: string
  /** HTTPS root of the relay this bot is configured to use, with a trailing slash. */
  readonly homeEndpoint: string
  /** The bot's own compressed identity point P, lowercase hex. */
  readonly selfSubject: string
  selfCurrent(): Promise<Current>
  /** `undefined` when that key has no published entry, or its entry is refused or cannot be
   * read now. `refresh` asks for an answer the relay gave just now, not a remembered one. */
  peerCurrent(subject: string, refresh?: boolean): Promise<Current | undefined>
}

/** The one live typed wallet owner, opened through the public chain factory. Opening signs,
 * funds, replays and sends nothing. */
export interface QwenCanonicalWallet {
  readonly handle: EvmChainWalletHandle
  /** The typed economic account that funds and pays reply stamps. Public; safe to log. */
  readonly accountAddress: string
  /** The bot's compressed identity point P and the mailbox address derived from it. */
  readonly subject: string
  readonly identityAddress: string
  close(): Promise<void>
}

/** The env-configured chain row with Qwen's own relay and a durable canonical wallet root. */
export function qwenCanonicalChainConfig(params: {
  relayBaseUrl: string
  walletStorageLocation: string
  stampValueWei: bigint
}): EvmChainConfig {
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

/** First run only: three distinct random roots in the shape the loader reads, owner-only,
 * created exclusively so a file that already exists is never replaced. Returns false when the
 * file turned out to exist. */
function createQwenCanonicalRoots(rootsJsonPath: string): boolean {
  let roots: string[]
  do {
    roots = [0, 1, 2].map(() => randomBytes(32).toString('hex'))
  } while (new Set(roots).size !== 3)
  mkdirSync(dirname(rootsJsonPath), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(
      rootsJsonPath,
      JSON.stringify({
        registry: 'frank-domain-roots-v1',
        roots: {
          [ROOT_PURPOSES.evm]: roots[0],
          [ROOT_PURPOSES.authentication]: roots[1],
          [ROOT_PURPOSES.messaging]: roots[2],
        },
      }) + '\n',
      { mode: 0o600, flag: 'wx' },
    )
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') return false
    throw new Error(
      `Qwen canonical roots could not be created at ${rootsJsonPath}`,
    )
  }
  return true
}

/** Loads the bot's typed root bundle. When nothing exists at the path, disposable roots are
 * created there first (mode 0600) and only that fact and the path are logged. An existing file
 * is never replaced: one that others can read, or that is not a roots bundle, is refused.
 * Failures name only the path, never file contents. */
export function loadQwenCanonicalRoots(rootsJsonPath: string): MonadRootBundle {
  const invalid = () =>
    new Error(
      `Qwen canonical roots at ${rootsJsonPath} are unreadable or not a frank-domain-roots-v1 bundle`,
    )
  const modeOf = (): number | undefined => {
    try {
      return statSync(rootsJsonPath).mode
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT')
        return undefined
      throw invalid()
    }
  }
  let saved: { registry?: unknown; roots?: Record<string, unknown> }
  let mode = modeOf()
  if (mode === undefined) {
    if (createQwenCanonicalRoots(rootsJsonPath))
      console.log(`[bot] created canonical roots file at ${rootsJsonPath}`)
    mode = modeOf()
    if (mode === undefined) throw invalid()
  }
  // Secret material: readable or writable by the owner only.
  if (process.platform !== 'win32' && (mode & 0o077) !== 0)
    throw new QwenStartRefusal('roots-file-permissions')
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

/** A configuration the bot will not start with. `code` is a fixed public word list, safe to
 * print; it never carries file contents, keys or provider text. */
export class QwenStartRefusal extends Error {
  constructor(readonly code: string) {
    super(`Qwen bot refusing to start: ${code}`)
    this.name = 'QwenStartRefusal'
  }
}

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

export async function openQwenCanonicalWallet(params: {
  chain: EvmChainConfig
  roots: MonadRootBundle
}): Promise<QwenCanonicalWallet> {
  if (params.chain.networkTag !== 'MONT' && params.chain.networkTag !== 'MON1')
    throw new QwenStartRefusal('network-not-monad')
  if (params.chain.walletStorageLocation === false)
    throw new QwenStartRefusal('wallet-storage-not-durable')
  const handle = (await createEvmChain(params.chain).createWallet(
    params.roots,
  )) as unknown as EvmChainWalletHandle
  try {
    const subject = hexOf(handle.identity.compressedPubKey)
    return {
      handle,
      accountAddress: (await handle.getReceiveAddress()).raw,
      subject,
      identityAddress: computeAddress('0x' + subject).toLowerCase(),
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export interface QwenOpenDirectory extends QwenCanonicalDirectory {
  /** Make sure this bot's own entry is current on its relay: adopt the one the relay already
   * holds for this key, sign and publish revision zero when it holds none, renew or move it
   * when needed. Throws a typed `OpenDirectoryError` when that is not possible now. */
  publish(): Promise<void>
  close(): Promise<void>
}

/** A forced peer read counts as fresh when the relay answered for that key this recently. */
const PEER_FRESH_MS = 5_000
const REFUSAL_LOG_LIMIT = 1024

/**
 * The bot's open directory over Node storage: the shared `openDirectory` with Level admission
 * stores under `location` (public evidence only), signing the bot's own entry with its live typed
 * wallet. Nothing is requested, signed or published until `publish()` or a peer read.
 *
 * A peer is any sender key. Its entry is fetched from the bot's relay, accepted only when the
 * key that signed it hashes to the sender's address, pinned to the first chain seen, and reused
 * for about 30 seconds. No sender is configured anywhere.
 */
export function openQwenDirectory(params: {
  wallet: Pick<QwenCanonicalWallet, 'handle' | 'subject'>
  networkTag: 'MONT' | 'MON1'
  /** The relay this bot lives on. Its entry is published to and peers are read from it. */
  relayBaseUrl: string
  /** Durable directory root, separate from wallet and bot state. */
  location: string
  fetch: DirectoryFetch
  nowNs?: () => bigint
}): QwenOpenDirectory {
  // When the relay last answered a head read for a key, so a forced read can tell an answer the
  // relay gave just now from one the shared directory remembered.
  const answeredAt = new Map<string, number>()
  const headRead = /\/directory\/v1\/[^/]+\/((?:02|03)[0-9a-f]{64})\/head$/
  const directory = openBotDirectory({
    handle: params.wallet.handle,
    subject: params.wallet.subject,
    networkTag: params.networkTag,
    relayBaseUrl: params.relayBaseUrl,
    location: params.location,
    nowNs: params.nowNs,
    fetch: async (url, init) => {
      const response = await params.fetch(url, init)
      const read = init.method === 'GET' ? headRead.exec(url) : null
      if (read && (response.status === 200 || response.status === 404))
        answeredAt.set(read[1], Date.now())
      return response
    },
  })
  const refusals = new Map<string, string>()
  return {
    network: directory.network,
    homeEndpoint: directory.homeEndpoint,
    selfSubject: params.wallet.subject,
    async publish() {
      await directory.publish()
    },
    selfCurrent: () => directory.selfCurrent(),
    async peerCurrent(subject, refresh = false) {
      const key = subject.toLowerCase()
      try {
        const entry = await directory.peerCurrent({ subject: key })
        if (!entry) return undefined
        refusals.delete(key)
        // The shared directory reuses a recent entry. A forced read is only satisfied by one
        // the relay served just now; otherwise there is nothing fresh to decide against yet.
        if (refresh && Date.now() - (answeredAt.get(key) ?? 0) > PEER_FRESH_MS)
          return undefined
        return entry.current
      } catch (error) {
        // Refused (not signed by that address, expired, rolled back, forked) or not readable
        // now: not usable. Logged once per change, with the fixed reason word only.
        const code = isOpenDirectoryError(error) ? error.code : 'storage'
        if (refusals.get(key) !== code) {
          if (refusals.size >= REFUSAL_LOG_LIMIT) refusals.clear()
          refusals.set(key, code)
          console.warn(
            `[bot] directory entry of ${
              directoryAddress(key) ?? 'a malformed sender key'
            } not usable: ${code}`,
          )
        }
        return undefined
      }
    },
    close: () => directory.close(),
  }
}

/**
 * Publishes the bot's own directory entry and returns only once the relay holds it; see
 * `publishBotDirectoryEntry`, the one implementation every bot uses.
 */
export const publishQwenDirectoryEntry = publishBotDirectoryEntry

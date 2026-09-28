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
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
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
import { MonadIdentity, registerMonadIdentity } from '@frank/wallet/monad-identity'
import { buildEnvelope } from '@frank/cashweb/relay/monad-message-envelope'
import { serializeMessageItems } from '@frank/wallet/chain/monad-chain'

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
    const saved = JSON.parse(readFileSync(identityJsonPath, 'utf8')) as {
      privateKeyHex: string
    }
    const identity = MonadIdentity.fromPrivateKeyHex(saved.privateKeyHex)
    console.log(
      `[${label}] loaded existing identity ${identity.displayAddress}`,
    )
    return identity
  }
  const identity = MonadIdentity.generate()
  writeFileSync(
    identityJsonPath,
    JSON.stringify({ privateKeyHex: identity.toPrivateKeyHex() }, null, 2),
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
}): Promise<void> {
  await registerMonadIdentity({
    relayBaseUrl: params.relayBaseUrl,
    identity: params.identity,
  })
  console.log(
    `[${params.label}] registered identity ${params.identity.displayAddress} (PUT /metadata, no payment -- POP disabled)`,
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

/**
 * Derives a fresh HD sub-account pool (ticket #14) and wires up a `MonadStampClient` ready to send
 * Stamp-over-Monad messages, against the main funded testnet wallet at `mainWalletJsonPath`.
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

  const { keyring, mnemonic } = MonadHdKeyring.generate()
  const pool = new MonadSubAccountPool({ keyring })
  const changePool = new MonadChangePool({
    keyring: MonadChangeKeyring.fromMnemonic(mnemonic),
  })

  if (params.poolSize) {
    pool.ensureSize(params.poolSize)

    const feeData = await provider.getFeeData()
    const fallbackMaxFeePerGas = BigInt(250000000000) // 250 gwei -- only if the node can't report feeData at all
    const maxFeePerGas = feeData.maxFeePerGas ?? fallbackMaxFeePerGas
    const estimatedBurnGasLimit = BigInt(23000)
    const gasReserve =
      (maxFeePerGas * estimatedBurnGasLimit * BigInt(11)) / BigInt(10)
    console.log(
      `[${params.label}] maxFeePerGas=${maxFeePerGas} wei; funding each sub-account with stampValue=${params.stampValueWei} + gasReserve=${gasReserve} wei`,
    )

    const funded = await fundPoolWithRetry({
      pool,
      mainAccountSigner,
      stampValueWei: params.stampValueWei,
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

  return { provider, stampClient, mainAccountSigner, pool }
}

/**
 * Tops up `pool` with only whatever it's short of for one stamp payment of `stampValueWei`
 * (mirroring `ActiveChain.directMessages.send`'s own call, `chain/monad-chain.ts`), builds the
 * E2E-encrypted envelope for `text` (wrapped as the real UI's `MessageItem[]` wire shape -- see
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
 */
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
    fromPrivateKey: params.fromIdentity.toBitcorePrivateKey(),
    toAddress: params.toAddress,
    toPubKey: params.toPubKey,
    plaintext: serializeMessageItems([{ type: 'text', text: params.text }]),
    networkTag: params.networkTag,
  })
  return params.stampClient.submitStampedMessage({
    encryptedPayload: envelope,
    recipientPublicKey: params.toPubKey,
    stampValueWei: params.stampValueWei,
  })
}

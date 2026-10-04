/**
 * Ticket #9: a headless Frank client that bridges real conversation turns to Qwen 3.8 Max
 * (Alibaba Cloud).
 * Builds entirely on `app`'s existing TS `cashweb`/`relay`/`wallet` library code (no UI) -- this
 * file is only the runnable entry point, same `.livecheck.ts` convention ticket #8's
 * `monad-e2e-demo.livecheck.ts` established (hits the real network, so excluded from `jest`'s
 * `testMatch` and never runs under `yarn test:unit:ci` -- meant to be run manually).
 *
 * Ported (see `qwen-bot-common.ts`'s own header) from the original `lotus-identity.ts`/
 * `FrankIdentity`-based version to `monad-identity.ts`'s `MonadIdentity` once the real Frank UI's
 * `ActiveChain`/`MonadChain` stack (#41-#45) landed -- a Lotus-identity bot was invisible to, and
 * couldn't message, any Monad wallet created through the actual app.
 *
 * ## What this proves, end to end
 *
 * 1. Registers its own Frank identity (`./monad-identity.ts`) via a real `PUT /metadata/:addr`,
 *    no payment (POP disabled, ticket #35) -- the same acceptance criterion ticket #8 proved,
 *    here done from a from-scratch TS client since no TS client for that route existed yet.
 * 2. Polls the *real*, live authenticated mailbox (`POST /message/monad/auth/:me` challenge +
 *    signed `GET /message/monad/inbox/:me`, PR #197; replaced ticket #37's `GET /message/monad?since=<t>`) for new stamped
 *    messages, filtering client-side for ones addressed to itself via the envelope convention in
 *    `./monad-message-envelope.ts` (see that file's header for why, and for the exact gap in the
 *    wire format this works around).
 * 3. For each message actually addressed to it, decrypts the real E2E-encrypted payload
 *    (`./monad-message-envelope.ts`, reusing `../relay/crypto.ts`'s existing ECDH+AES code),
 *    sends it to Qwen 3.8 Max over a real HTTPS streaming call (`./qwen-client.ts`), and gets back
 *    a real completion.
 * 4. Builds a real reply: encrypts Qwen's response for the sender, computes `h_m`, leases a fresh
 *    single-use Monad sub-account (#14/#18/#34), builds+signs a real EIP-1559 stamp payment, and `PUT`s
 *    it to the relay's live `PUT /message/monad` route (#13/#19/#27) -- the relay itself
 *    broadcasts, confirms, and verifies that exact tx against real Monad testnet before storing
 *    it, exactly as `monad-e2e-demo.livecheck.ts` (#8) already proved for a single message.
 * 5. (Ticket #77) In the same poll loop, also polls the real, live `GET /metadata/monad?since=<t>`
 *    route (ticket #75) for newly-registered Monad profiles via `fetchMonadProfilesSince`
 *    (`../wallet/monad-identity.ts`). For each one (never itself), sends it a real greeting DM
 *    (the same `sendDirectMessageText` path step 4 uses) and funds its address with a small
 *    amount of real testnet MON from the main funded wallet, via `MonadAccountTxSigner.
 *    buildAndSignTransfer` directly -- *not* `fanOutFundSubAccounts` (`../wallet/
 *    monad-account-pool.ts`), despite that being this ticket's own initial suggestion: that
 *    function's `targets` are typed as (and exist to fund) the bot's *own* derived sub-account
 *    pool records, not arbitrary third-party addresses -- `buildAndSignTransfer`/`.submit()` on
 *    the main account signer is the actual plain "send N wei to any address" primitive
 *    (confirmed by reading `ActiveChain.nativeTransfers.send`'s own real implementation in
 *    `../wallet/chain/monad-chain.ts`, which itself just calls `buildAndSignTransfer` -- the
 *    `ActiveChain`/`WalletHandle` wrapper around it isn't otherwise used anywhere in this bot).
 *
 * ## Usage
 *
 * Ticket #53 (package split): this is now `@frank/bot`, a real workspace package depending on
 * `@frank/wallet`/`@frank/cashweb` -- runs directly via `tsx`, no manual `tsc` compile step. See
 * `README.md` for the full runbook (env vars, starting a local relay, etc); short version:
 *
 *   cd packages/bot
 *   set -a; source ../../.env; set +a
 *   export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   yarn bot
 *
 * Prints its own Frank identity address on startup (and writes it to `QWEN_BOT_HANDOFF_JSON`) --
 * that's what `qwen-bot-send-demo.livecheck.ts` addresses its first message to.
 *
 * Ticket #77's auto-greet/auto-fund behavior (see point 5 above) is configured via:
 *   QWEN_BOT_MAX_GREETINGS      -- max new profile registrations to greet+fund per run (default 5)
 *   QWEN_BOT_GREETING_MESSAGE   -- the greeting DM's text (default: a short welcome message)
 *   QWEN_BOT_STAMP_VALUE_WEI    -- wei paid as Qwen's DM stamp (default 0.01 MON)
 *   QWEN_BOT_FUND_VALUE_WEI     -- wei sent to each newly-greeted address (default 0.05 MON)
 *
 * State persistence (direct user feedback, 2026-09-28 -- see `qwen-bot-state.ts`'s own header):
 *   QWEN_BOT_STATE_DIR          -- where the `level` DB of polling cursors, greeted-addresses/
 *                                  processed-message idempotency sets, and per-user Qwen
 *                                  conversation history is kept (default ~/.frank-bots/qwen, or $XDG_STATE_HOME/frank-bots/qwen).
 *                                  Survives restarts; preserve held response rows (see README).
 *   QWEN_BOT_WALLET_STATE_DIR   -- durable HD seed, sender/change pools, and exact stamp journals
 *                                  (default ~/.frank-bots/qwen-wallet, or $XDG_STATE_HOME/frank-bots/qwen-wallet).
 *
 * Canonical mode (#703/#778), selected by QWEN_BOT_CANONICAL_ROOTS_JSON. In this mode the bot
 * has no legacy identity, profile registration, greeting or legacy stamp wallet: it reads its
 * canonical inbox from its installed home relay, opens messages with its own role keys under
 * admitted directory evidence, and answers through one sealed envelope and one durable wallet
 * attempt per turn. See `mainCanonical` below and README "Canonical mode".
 *   QWEN_BOT_CANONICAL_ROOTS_JSON   -- operator-provisioned frank-domain-roots-v1 bundle; the
 *                                      bot never creates it.
 *   QWEN_BOT_CANONICAL_POLICY_JSON  -- operator-installed public bootstrap-policy.json.
 *   QWEN_BOT_CANONICAL_BUNDLE_JSON  -- operator-installed public approved-bundle.json.
 *   QWEN_BOT_CANONICAL_EXPORT_JSON  -- if set, write this bot's public revision-zero export
 *                                      there (home relay from QWEN_BOT_CANONICAL_HOME, relay-a or
 *                                      relay-b) and exit.
 *   QWEN_BOT_CANONICAL_STATUS_PORT  -- serve GET /directory-installation/<bundle identity>
 *                                      (plain HTTP, QWEN_BOT_CANONICAL_STATUS_HOST or loopback)
 *                                      for the operator readiness check.
 */
import { writeFileSync } from 'fs'
import { join, resolve } from 'path'

import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata } = __pb_registry_metadata_pb
import {
  fetchMonadIdentityPubKey,
  fetchMonadProfilesSince,
  mailboxAuthFor,
} from '@frank/wallet/monad-identity'
import { canonicalMonadEnvelopeAddress } from '@frank/cashweb/relay/monad-message-envelope'
import { botStateDir, persistentStateDir } from './bot-state-dir'
import { createQwenReplyGenerator, qwenBotConfigFromEnv } from './qwen-reply'
import { botLoopGuardFromEnv } from './bot-loop-guard'
import {
  loadOrCreateIdentity,
  loadQwenCanonicalRoots,
  openQwenCanonicalWallet,
  openQwenInstalledDirectory,
  startQwenInstallationServer,
  readQwenApprovedBundle,
  readQwenBootstrapPolicy,
  qwenCanonicalChainConfig,
  registerAndLog,
  requiredEnv,
  sendDirectMessageText,
  setUpCanonicalQwenSender,
  setUpDurableFundedStampClient,
} from './qwen-bot-common'
import { botProfileFields } from './bot-directory'
import { QwenBotStateStore } from './qwen-bot-state'
import { QwenResponseWorkflow } from './qwen-response-workflow'
import { QwenInboundWorkflow } from './qwen-inbound-workflow'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

const SYSTEM_PROMPT =
  process.env.QWEN_BOT_SYSTEM_PROMPT ??
  'You are a helpful assistant reachable only over Frank, a pay-to-speak messaging protocol ' +
    'on the Monad blockchain (ticket #9 demo). Every message ' +
    'you receive was paid for with a real, tiny MON payment from disposable funding accounts, ' +
    'and your replies are delivered back the same way. Keep replies short (2-4 sentences) since ' +
    'each one costs a real transaction.'

let closeFundedSetup: (() => Promise<void>) | undefined
let closeBotState: (() => Promise<void>) | undefined
let closeCanonicalSetup: (() => Promise<void>) | undefined
let closeCanonicalDirectory: (() => Promise<void>) | undefined

async function main() {
  // Validated first so a missing key fails immediately, naming the variable (#314).
  const botConfig = qwenBotConfigFromEnv(process.env)
  if (process.env.QWEN_BOT_CANONICAL_ROOTS_JSON) return mainCanonical(botConfig)
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const networkTag = requiredEnv('FRANK_NETWORK_TAG')
  // Ticket #57: no MONAD_STAMP_BURN_ADDRESS here -- a reply's stamp pays whoever it's replying
  // to (see the submitStampedMessage call below), not a fixed address.
  const minimumStampValueWei = BigInt(
    requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'),
  )
  const stampValueWei = BigInt(
    process.env.QWEN_BOT_STAMP_VALUE_WEI ??
      process.env.FRANK_DM_DEFAULT_STAMP_VALUE_WEI ??
      '10000000000000000',
  )
  if (stampValueWei < minimumStampValueWei) {
    throw new Error(
      `Qwen stamp default ${stampValueWei} is below the relay minimum ${minimumStampValueWei}`,
    )
  }

  const identityJsonPath = resolve(
    process.cwd(),
    process.env.QWEN_BOT_IDENTITY_JSON ?? '/tmp/qwen-bot-identity.json',
  )
  const handoffJsonPath = resolve(
    process.cwd(),
    process.env.QWEN_BOT_HANDOFF_JSON ?? '/tmp/qwen-bot-handoff.json',
  )
  const mainWalletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )
  // Persists polling cursors, the greeted-addresses/processed-message idempotency sets, and each
  // user's Qwen conversation history across restarts -- see qwen-bot-state.ts's own header for
  // the concrete user-visible bug this fixes.
  const stateDirPath = botStateDir('qwen', 'QWEN_BOT_STATE_DIR')
  const walletStateDirPath = persistentStateDir(
    'qwen-wallet',
    'QWEN_BOT_WALLET_STATE_DIR',
  )
  const pollIntervalMs = Number(process.env.QWEN_BOT_POLL_INTERVAL_MS ?? 4000)
  // Keep running by default; QWEN_BOT_MAX_REPLIES=<n> is the explicit exit-after-n flag.
  const { maxReplies, idleTimeoutMs } = botConfig
  const replyGenerator = createQwenReplyGenerator(botConfig)

  // Ticket #77: auto-greet/auto-fund newly-registered Monad profiles, alongside this script's
  // pre-existing Qwen-reply behavior. `QWEN_BOT_MAX_GREETINGS` caps how many strangers' addresses
  // get a real funding transfer per run; every greeting DM consumes a stamp sub-account the same
  // way a Qwen reply does (2026-09-28: funded lazily per-send now, see `setUpFundedStampClient`'s
  // header -- no longer a fixed pool sized to this number up front).
  const maxGreetings = Number(process.env.QWEN_BOT_MAX_GREETINGS ?? 5)
  const greetingMessage =
    process.env.QWEN_BOT_GREETING_MESSAGE ??
    "Welcome to Frank! I'm a bot -- here's a little MON to help you get started sending your " +
      'first stamped message.'
  // Default: 0.05 MON. The UI's preferred two-payment send needs enough visible-wallet balance
  // for both right-sized payment accounts and their funding/payment gas. The old 0.001 MON was
  // below even one live testnet gas quote and surfaced as ethers' misleading "missing revert
  // data" during estimation.
  const fundValueWei = BigInt(
    process.env.QWEN_BOT_FUND_VALUE_WEI ?? '50000000000000000',
  )

  console.log('== Ticket #9: Qwen 3.8 Max bot over Frank (Monad testnet) ==')
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Reply mode:   ${replyGenerator.mode}`)
  console.log(
    `Max replies:  ${Number.isFinite(maxReplies) ? maxReplies : 'unlimited'}`,
  )
  console.log(
    `Max greetings: ${maxGreetings} (funding each with ${fundValueWei} wei)`,
  )

  const identity = loadOrCreateIdentity(identityJsonPath, 'bot')
  await registerAndLog({
    relayBaseUrl,
    identity,
    label: 'bot',
    profile: botProfileFields('qwen'),
  })
  writeFileSync(
    handoffJsonPath,
    JSON.stringify({ address: identity.displayAddress }, null, 2),
  )
  console.log(`Bot Frank identity address: ${identity.displayAddress}`)
  console.log(`(handoff written to ${handoffJsonPath})`)

  const profileWatchStartedAt = Date.now()

  // No `poolSize` -- sub-accounts are funded lazily, per send, inside `sendDirectMessageText`
  // (see `setUpFundedStampClient`'s header, "Lazy per-send funding"). This is what actually fixed
  // tonight's nonce-contention pain: a fixed pool sized to `maxReplies + maxGreetings` meant a big
  // burst of near-simultaneous funding transactions from one account before the bot ever reached
  // its polling loop.
  const fundedSetup = await setUpDurableFundedStampClient({
    rpcUrl,
    relayBaseUrl,
    mainWalletJsonPath,
    stateRoot: walletStateDirPath,
    stampValueWei,
    label: 'bot',
  })
  const { stampClient, mainAccountSigner, provider, pool } = fundedSetup
  closeFundedSetup = fundedSetup.close

  // #311: never greet/reply to other bots, and cap replies per peer per window (see
  // bot-loop-guard.ts for the env knobs).
  const guard = botLoopGuardFromEnv({
    selfAddress: identity.displayAddress,
    relayBaseUrl,
  })

  // Not persisted, deliberately -- see qwen-bot-state.ts's header for why (cheaply re-fetchable).
  const senderPubKeyCache = new Map<string, Buffer>()

  const state = new QwenBotStateStore(stateDirPath)
  await state.Open()
  closeBotState = () => state.Close()
  console.log(`[bot] persisted state loaded from ${stateDirPath}`)

  const inboxContext = {
    botAddress: canonicalMonadEnvelopeAddress(identity.displayAddress),
    networkTag,
    relayBaseUrl,
  }
  await state.initializeInbox(
    inboxContext,
    Number(process.env.QWEN_BOT_MESSAGE_SINCE_MS ?? profileWatchStartedAt),
  )
  let repliesSent = 0
  let greetingsSent = 0
  let lastActivityAt = Date.now()

  const responses = new QwenResponseWorkflow({
    state,
    context: {
      botAddress: canonicalMonadEnvelopeAddress(identity.displayAddress),
      fundingAddress: canonicalMonadEnvelopeAddress(mainAccountSigner.address),
      networkTag,
      relayBaseUrl,
      stampValueWei: stampValueWei.toString(),
    },
    systemPrompt: SYSTEM_PROMPT,
    generator: replyGenerator,
    send: async row => {
      const result = await sendDirectMessageText({
        stampClient,
        pool,
        mainAccountSigner,
        provider,
        fromIdentity: identity,
        toAddress: row.senderAddress,
        toPubKey: Buffer.from(row.senderPubKeyHex, 'hex'),
        text: row.response,
        stampValueWei,
        networkTag,
      })
      // Stamp results also contain wallet/protobuf details (including BigInts). Only the
      // delivery proof belongs in the durable response receipt.
      return {
        payloadHashHex: result.payloadHashHex,
        txHashes: [...result.txHashes],
      }
    },
  })

  const inbound = new QwenInboundWorkflow({
    state,
    context: inboxContext,
    auth: mailboxAuthFor(identity, relayBaseUrl),
    responses,
    privateKey: identity.toNakamotoPrivateKey(),
    senderKey: async address => {
      const sender = canonicalMonadEnvelopeAddress(address)
      let key = senderPubKeyCache.get(sender)
      if (!key) {
        key = await fetchMonadIdentityPubKey({ relayBaseUrl, address })
        if (key) senderPubKeyCache.set(sender, key)
      }
      return key
    },
    peerBlockReason: address => guard.peerBlockReason(address),
    reserveReply: address => guard.reserveReply(address),
  })

  // Surface nonretryable ambiguity once on startup. Only ready rows enter periodic recovery.
  for (const row of state.pendingResponses()) {
    if (
      row.phase !== 'response-ready' ||
      responses.pollDisposition(row.payloadHashHex) === 'final-hold'
    )
      await responses.resume(row.payloadHashHex)
  }

  // Ticket #77's own sketch used `sinceProfiles = 0` (every historical registration). Deliberately
  // starting from "now" instead: a live relay this bot points at may already have many
  // pre-existing registrations from earlier tickets' own runs (this file's neighboring scripts,
  // `monad-e2e-demo.livecheck.ts`, etc.) -- starting at 0 would immediately try to greet-and-fund
  // every one of them on this bot's very first poll, which is both not what "auto-greet a new
  // signup" means and a real risk to the shared, already-documented-as-scarce funding wallet
  // balance (see `qwen-bot-common.ts`'s header). Only registrations from this run's own startup
  // onward are treated as "new" -- unless a persisted cursor from a real previous run exists, in
  // which case that wins (same "resume, don't rewind" reasoning as `since` just above).
  let sinceProfiles =
    state.getSinceProfiles() ??
    Number(process.env.QWEN_BOT_PROFILE_SINCE_MS ?? profileWatchStartedAt)

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad/inbox/<me> (signed mailbox read, since=<t>) every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )
  console.log(
    `Polling ${relayBaseUrl}/metadata/monad?since=<t> every ${pollIntervalMs}ms for new profile registrations (greeting + funding up to ${maxGreetings}) ...`,
  )

  // Runs until both quotas are met (or the idle timeout fires) -- greeting/funding new signups is
  // no longer gated behind "has the Qwen-reply quota been reached", since it's now this script's
  // second, independent piece of demoed behavior (ticket #77).
  while (repliesSent < maxReplies || greetingsSent < maxGreetings) {
    if (idleTimeoutMs > 0 && Date.now() - lastActivityAt > idleTimeoutMs) {
      console.log(
        `\nNo activity (messages or new profile registrations) within ${idleTimeoutMs}ms -- exiting.`,
      )
      break
    }

    // Recovery does not depend on a mailbox entry or operator restart. Each ready row is
    // reconsidered at most once per poll: a turn that would seal or pay goes through the peer
    // guard and reply budget; a turn that already owns a linked wallet attempt replays exactly
    // that attempt; a dead outcome is final and is not retried. Legacy model-started and
    // send-started holds never enter this path.
    for (const row of state.pendingResponses()) {
      if (repliesSent >= maxReplies) break
      if (row.phase !== 'response-ready') continue
      const disposition = responses.pollDisposition(row.payloadHashHex)
      if (disposition === 'final-hold') continue
      if (
        disposition === 'new-effect' &&
        ((await guard.peerBlockReason(row.senderAddress)) ||
          !guard.reserveReply(row.senderAddress))
      )
        continue
      if ((await responses.resume(row.payloadHashHex)) === 'confirmed') {
        repliesSent++
        lastActivityAt = Date.now()
      }
    }
    if (repliesSent >= maxReplies && greetingsSent >= maxGreetings) break

    if (greetingsSent < maxGreetings) {
      const newProfiles = await fetchMonadProfilesSince({
        relayBaseUrl,
        sinceMs: sinceProfiles,
      })
      let maxSeenProfileTimestamp = sinceProfiles - 1

      for (const profile of newProfiles) {
        // The registration timestamp lives inside the signed `AddressMetadata` payload itself
        // (`ListMonadProfilesEntry` only carries `address` + the raw `SignedPayload` bytes -- see
        // `metadata.proto`'s doc comment on that message) -- decode it to advance the cursor the
        // same way `since`/`maxSeenTimestamp` already does for messages above.
        const registeredAt = AddressMetadata.deserializeBinary(
          profile.signedPayload.getPayload_asU8(),
        ).getTimestamp()
        maxSeenProfileTimestamp = Math.max(
          maxSeenProfileTimestamp,
          registeredAt,
        )

        // Never greet/fund ourselves, a denylisted address, or another bot (#311): the greeting
        // budget and the funding wallet are for human users. Not marked greeted -- it was never
        // greeted -- and it does not count against `maxGreetings`.
        const skipReason = guard.profileBlockReason(
          profile.address,
          profile.signedPayload,
        )
        if (skipReason) {
          console.log(`[bot] not greeting ${profile.address} (${skipReason})`)
          continue
        }
        if (state.hasGreeted(profile.address)) continue // idempotency guard, persisted
        if (greetingsSent >= maxGreetings) break

        state.addGreeted(profile.address)
        lastActivityAt = Date.now()
        console.log(
          `\n[bot] new profile registration: ${
            profile.address
          } (registered ${new Date(registeredAt).toISOString()})`,
        )

        try {
          console.log(`[bot] sending greeting DM to ${profile.address} ...`)
          const greeting = await sendDirectMessageText({
            stampClient,
            pool,
            mainAccountSigner,
            provider,
            fromIdentity: identity,
            toAddress: profile.address,
            toPubKey: Buffer.from(profile.signedPayload.getPublicKey_asU8()),
            text: greetingMessage,
            stampValueWei,
            networkTag,
          })
          console.log(
            `[bot] greeting sent -- payload_hash=${
              greeting.payloadHashHex
            } stamp txs=${greeting.txHashes.join(',')}`,
          )
        } catch {
          console.error(
            `[bot] greeting failed; delivery outcome requires inspection`,
          )
        }

        // `QWEN_BOT_FUND_VALUE_WEI=0` turns funding off (e.g. when the standalone faucet, #316,
        // does it), keeping the greeting.
        if (fundValueWei > 0n) {
          try {
            console.log(
              `[bot] funding ${profile.address} with ${fundValueWei} wei from the main wallet (${mainAccountSigner.address}) ...`,
            )
            const signedFundTx = await mainAccountSigner.buildAndSignTransfer(
              profile.address,
              fundValueWei,
            )
            const fundTxHash = await mainAccountSigner.submit(signedFundTx)
            console.log(`[bot] funding tx sent: ${fundTxHash}`)
          } catch {
            console.error(
              `[bot] funding failed; transfer outcome requires inspection`,
            )
          }
        }

        // Counted once per newly-greeted address regardless of whether the greeting DM and/or the
        // funding transfer above individually succeeded -- `greetedAddresses` already guards
        // against re-attempting this same address on a later poll/restart. Greeting/funding
        // lifecycle remains separate from the response workflow below.
        greetingsSent++
      }

      if (newProfiles.length > 0) {
        sinceProfiles = maxSeenProfileTimestamp + 1
        state.setSinceProfiles(sinceProfiles)
      }
    }

    await inbound.import()
    const confirmed = await inbound.drain(maxReplies - repliesSent)
    repliesSent += confirmed
    if (confirmed) lastActivityAt = Date.now()
    if (repliesSent >= maxReplies && greetingsSent >= maxGreetings) break
    // Flushed once per poll cycle (not just at final Close()) so a crash mid-run loses at most
    // the current cycle's writes, not everything back to the last clean exit.
    await state.flush()
    await sleep(pollIntervalMs)
  }

  console.log(
    `\nDone. Sent ${repliesSent} ${
      replyGenerator.mode === 'stub' ? 'STUB (canned)' : 'real Qwen-generated'
    } repl${
      repliesSent === 1 ? 'y' : 'ies'
    } and greeted+funded ${greetingsSent} new profile registration${
      greetingsSent === 1 ? '' : 's'
    } over Monad testnet.`,
  )
}

/**
 * Canonical mode. Order matters and is fixed:
 *  1. public configuration is read and checked; the export-only path ends here;
 *  2. Qwen's response and inbox state opens;
 *  3. the typed wallet owner opens, which signs, funds, replays and sends nothing;
 *  4. the installed directory opens (own attestation published, peers read lazily);
 *  5. every retained wallet record is correlated with a saved turn;
 *  6. only then are pending turns resumed and the canonical inbox imported and drained.
 */
async function mainCanonical(
  botConfig: ReturnType<typeof qwenBotConfigFromEnv>,
): Promise<void> {
  const path = (name: string) => resolve(process.cwd(), requiredEnv(name))
  const roots = loadQwenCanonicalRoots(path('QWEN_BOT_CANONICAL_ROOTS_JSON'))
  const policy = readQwenBootstrapPolicy(path('QWEN_BOT_CANONICAL_POLICY_JSON'))
  const stampValueWei = BigInt(
    process.env.QWEN_BOT_STAMP_VALUE_WEI ??
      process.env.FRANK_DM_DEFAULT_STAMP_VALUE_WEI ??
      '10000000000000000',
  )
  const stateDirPath = botStateDir('qwen', 'QWEN_BOT_STATE_DIR')
  const walletStateDirPath = persistentStateDir(
    'qwen-wallet',
    'QWEN_BOT_WALLET_STATE_DIR',
  )
  const openWallet = async (relayBaseUrl: string) => {
    const chain = qwenCanonicalChainConfig({
      relayBaseUrl,
      walletStorageLocation: join(walletStateDirPath, 'canonical'),
      stampValueWei,
    })
    if (chain.networkTag !== policy.networkTag)
      throw new Error(
        'Configured chain differs from the installed network; refusing to start',
      )
    const wallet = await openQwenCanonicalWallet({ chain, roots })
    closeCanonicalSetup = () => wallet.close()
    return wallet
  }

  const exportPath = process.env.QWEN_BOT_CANONICAL_EXPORT_JSON
  if (exportPath) {
    const home = requiredEnv('QWEN_BOT_CANONICAL_HOME')
    if (home !== 'relay-a' && home !== 'relay-b')
      throw new Error('QWEN_BOT_CANONICAL_HOME must be relay-a or relay-b')
    // Opening the typed wallet signs, funds and sends nothing; the export is one public
    // statement signed with the identity key.
    const wallet = await openWallet(
      policy.relayTuples.find(tuple => tuple.processId === home)!.endpoint,
    )
    const exported = wallet.publicExport({
      policy,
      home,
      nowNs: BigInt(Date.now()) * 1_000_000n,
    })
    writeFileSync(
      resolve(process.cwd(), exportPath),
      JSON.stringify(exported, null, 2) + '\n',
    )
    console.log(
      `[bot] public revision-zero export written for ${exported.authAddress} (home ${home}); give it to the operator`,
    )
    console.log(
      `[bot] canonical stamp account to fund: ${wallet.accountAddress}`,
    )
    return
  }

  const bundle = readQwenApprovedBundle(path('QWEN_BOT_CANONICAL_BUNDLE_JSON'))
  const installedSelf = bundle.subjects.find(subject => subject.role === 'bot')
  if (!installedSelf) throw new Error('Approved bundle installs no bot subject')
  const relayBaseUrl = installedSelf.relay.endpoint
  const configuredRelay = process.env.E2E_DEMO_RELAY_URL
  if (
    configuredRelay &&
    new URL(configuredRelay).origin !== new URL(relayBaseUrl).origin
  )
    throw new Error(
      'E2E_DEMO_RELAY_URL differs from the installed home relay; refusing to start',
    )
  const pollIntervalMs = Number(process.env.QWEN_BOT_POLL_INTERVAL_MS ?? 4000)
  const { maxReplies, idleTimeoutMs } = botConfig
  const replyGenerator = createQwenReplyGenerator(botConfig)
  console.log('== Qwen bot over Frank, canonical mode ==')
  console.log(`Reply mode:   ${replyGenerator.mode}`)

  const state = new QwenBotStateStore(stateDirPath)
  await state.Open()
  closeBotState = () => state.Close()
  console.log(`[bot] persisted state loaded from ${stateDirPath}`)

  const wallet = await openWallet(relayBaseUrl)
  const directory = await openQwenInstalledDirectory({
    wallet,
    policy,
    bundle,
    location: join(stateDirPath, 'canonical-directory'),
    fetch: (url, init) =>
      (
        globalThis as unknown as {
          fetch: Parameters<typeof openQwenInstalledDirectory>[0]['fetch']
        }
      ).fetch(url, init),
  })
  closeCanonicalDirectory = () => directory.close()
  const canonical = setUpCanonicalQwenSender({
    wallet,
    networkTag: policy.networkTag,
    directory,
    label: 'bot',
  })
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Bot Frank identity address: ${canonical.identityAddress}`)
  writeFileSync(
    resolve(
      process.cwd(),
      process.env.QWEN_BOT_HANDOFF_JSON ?? '/tmp/qwen-bot-handoff.json',
    ),
    JSON.stringify({ address: canonical.identityAddress }, null, 2),
  )
  // The readiness check reads this process's installed public configuration from here.
  const statusPort = process.env.QWEN_BOT_CANONICAL_STATUS_PORT
  if (statusPort) {
    const status = await startQwenInstallationServer({
      directory,
      port: Number(statusPort),
      host: process.env.QWEN_BOT_CANONICAL_STATUS_HOST,
    })
    const closeDirectory = closeCanonicalDirectory
    closeCanonicalDirectory = async () => {
      await status.close()
      await closeDirectory?.()
    }
    console.log(
      `[bot] installed configuration ${directory.bundleIdentity} served on port ${status.port}`,
    )
  }

  const inboxContext = {
    botAddress: canonical.identityAddress,
    networkTag: policy.networkTag,
    relayBaseUrl,
  }
  await state.initializeInbox(
    inboxContext,
    Number(process.env.QWEN_BOT_MESSAGE_SINCE_MS ?? Date.now()),
  )
  const guard = botLoopGuardFromEnv({
    selfAddress: canonical.identityAddress,
    relayBaseUrl,
  })
  // A canonical peer is an operator-installed `ui` subject admitted by the directory; that is
  // the statement that it is not another bot. The legacy profile-marker lookup is not consulted
  // (and would be a legacy read). The per-peer reply budget still applies.
  const peerBlockReason = async (_address: string) => undefined
  const responses = new QwenResponseWorkflow({
    state,
    context: {
      ...inboxContext,
      fundingAddress: canonical.accountAddress.toLowerCase(),
      stampValueWei: stampValueWei.toString(),
    },
    systemPrompt: SYSTEM_PROMPT,
    generator: replyGenerator,
    canonical: canonical.sender,
  })
  const inbound = new QwenInboundWorkflow({
    state,
    context: inboxContext,
    responses,
    canonical: canonical.inbound,
    peerBlockReason,
    reserveReply: address => guard.reserveReply(address),
  })

  // Correlate saved turns with retained wallet records before any replay or new reply effect.
  const hold = await responses.recover()
  console.log(
    `[bot] canonical wallet correlation ${hold ? 'held' : 'complete'}`,
  )
  for (const row of state.pendingResponses()) {
    if (
      row.phase !== 'response-ready' ||
      responses.pollDisposition(row.payloadHashHex) === 'final-hold'
    )
      await responses.resume(row.payloadHashHex)
  }

  let repliesSent = 0
  // Opening the typed owner and directory is not idleness.
  let lastActivityAt = Date.now()
  console.log(
    `\nPolling the canonical inbox of ${canonical.identityAddress} at ${relayBaseUrl} every ${pollIntervalMs}ms ...`,
  )
  while (repliesSent < maxReplies) {
    if (idleTimeoutMs > 0 && Date.now() - lastActivityAt > idleTimeoutMs) {
      console.log(`\nNo activity within ${idleTimeoutMs}ms -- exiting.`)
      break
    }
    await responses.recover()
    for (const row of state.pendingResponses()) {
      if (repliesSent >= maxReplies) break
      if (row.phase !== 'response-ready') continue
      const disposition = responses.pollDisposition(row.payloadHashHex)
      if (disposition === 'final-hold') continue
      if (
        disposition === 'new-effect' &&
        ((await peerBlockReason(row.senderAddress)) ||
          !guard.reserveReply(row.senderAddress))
      )
        continue
      if ((await responses.resume(row.payloadHashHex)) === 'confirmed') {
        repliesSent++
        lastActivityAt = Date.now()
      }
    }
    if (repliesSent >= maxReplies) break
    await inbound.import()
    const confirmed = await inbound.drain(maxReplies - repliesSent)
    repliesSent += confirmed
    if (confirmed) lastActivityAt = Date.now()
    if (repliesSent >= maxReplies) break
    await state.flush()
    await sleep(pollIntervalMs)
  }
  console.log(
    `\nDone. Sent ${repliesSent} canonical repl${
      repliesSent === 1 ? 'y' : 'ies'
    } (${replyGenerator.mode}).`,
  )
}

main()
  .finally(async () => {
    try {
      await closeBotState?.()
    } finally {
      try {
        await closeCanonicalSetup?.()
        await closeCanonicalDirectory?.()
      } finally {
        await closeFundedSetup?.()
      }
    }
  })
  .catch(() => {
    // Provider errors may contain prompts, tokens or raw response bodies, including in debug mode.
    console.error(
      '\nQWEN BOT FAILED: check QWEN_API_KEY and QWEN_OPENAI_COMPATIBLE_ENDPOINT (or QWEN_BOT_MODE=stub), configuration and durable response state; preserve held rows before restart',
    )
    process.exit(1)
  })

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
 *                                  Survives restarts -- delete this directory to start clean.
 *   QWEN_BOT_WALLET_STATE_DIR   -- durable HD seed, sender/change pools, and exact stamp journals
 *                                  (default /tmp/qwen-bot-wallet-state).
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { Transaction, hexlify } from 'ethers'

import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata } = __pb_registry_metadata_pb
import {
  fetchMonadIdentityPubKey,
  fetchMonadProfilesSince,
  mailboxAuthFor,
} from '@frank/wallet/monad-identity'
import {
  canonicalMonadEnvelopeAddress,
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import { botStateDir } from './bot-state-dir'
import {
  createQwenReplyGenerator,
  qwenBotConfigFromEnv,
} from './qwen-reply'
import { botLoopGuardFromEnv } from './bot-loop-guard'
import { extractPromptText } from './qwen-prompt'
import {
  loadOrCreateIdentity,
  registerAndLog,
  requiredEnv,
  sendDirectMessageText,
  setUpFundedStampClient,
} from './qwen-bot-common'
import { botProfileFields } from './bot-directory'
import { QwenBotStateStore } from './qwen-bot-state'

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

async function main() {
  // Validated first so a missing key fails immediately, naming the variable (#314).
  const botConfig = qwenBotConfigFromEnv(process.env)
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
  const walletStateDirPath = botStateDir(
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
  console.log(`Reply mode:   ${replyGenerator.describe()}`)
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
  const fundedSetup = await setUpFundedStampClient({
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

  // A process restart must not replay every retained message and pay for duplicate replies.
  // Start at this run's pre-funding boundary so messages arriving during the potentially slow
  // account setup are still handled. The override exists for deliberate historical backfills.
  // Persisted state (a real previous run's cursor) wins over both when present -- that's the
  // whole point of this fix: a restart should resume, not rewind to "now" and lose the plot.
  let since =
    state.getSince() ??
    Number(process.env.QWEN_BOT_MESSAGE_SINCE_MS ?? profileWatchStartedAt)
  let repliesSent = 0
  let greetingsSent = 0
  let lastActivityAt = Date.now()

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
          console.log(
            `[bot] not greeting ${profile.address} (${skipReason})`,
          )
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
        } catch (err) {
          console.error(`[bot] failed to greet ${profile.address}:`, err)
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
          } catch (err) {
            console.error(`[bot] failed to fund ${profile.address}:`, err)
          }
        }

        // Counted once per newly-greeted address regardless of whether the greeting DM and/or the
        // funding transfer above individually succeeded -- `greetedAddresses` already guards
        // against re-attempting this same address on a later poll/restart (see this loop's header
        // comment; matches this script's existing risk tolerance for the message-reply path, which
        // similarly never retries a `processedPayloadHashes` entry).
        greetingsSent++
      }

      if (newProfiles.length > 0) {
        sinceProfiles = maxSeenProfileTimestamp + 1
        state.setSinceProfiles(sinceProfiles)
      }
    }

    const stored = await fetchMonadMessagesSince({
      ...mailboxAuthFor(identity, relayBaseUrl),
      sinceMs: since,
    })
    let maxSeenTimestamp = since - 1

    for (const message of stored) {
      maxSeenTimestamp = Math.max(maxSeenTimestamp, message.timestamp)
      if (!message.message) continue

      const payloadHashHex = Buffer.from(message.message.payloadHash).toString(
        'hex',
      )
      if (state.hasProcessed(payloadHashHex)) continue
      state.addProcessed(payloadHashHex)

      const envelope = parseEnvelope(message.message.encryptedPayload)
      if (!envelope) continue // not our envelope convention -- e.g. #8's plain-JSON demo blob
      if (!sameMonadEnvelopeAddress(envelope.to, identity.displayAddress))
        continue
      if (sameMonadEnvelopeAddress(envelope.from, identity.displayAddress))
        continue

      lastActivityAt = Date.now()
      const paymentHashes = message.message.stampPayments.map(
        payment => Transaction.from(hexlify(payment.rawTx)).hash,
      )
      console.log(
        `\n[bot] new stamped message ${payloadHashHex} from ${
          envelope.from
        } (stamp txs ${paymentHashes.join(',')})`,
      )

      const senderKey = canonicalMonadEnvelopeAddress(envelope.from)
      let senderPubKey = senderPubKeyCache.get(senderKey)
      if (!senderPubKey) {
        senderPubKey = await fetchMonadIdentityPubKey({
          relayBaseUrl,
          address: envelope.from,
        })
        if (!senderPubKey) {
          console.log(
            `[bot] sender ${envelope.from} has no registered Frank identity -- can't derive a shared key, skipping`,
          )
          continue
        }
        senderPubKeyCache.set(senderKey, senderPubKey)
      }

      const blockReason = await guard.peerBlockReason(envelope.from)
      if (blockReason) {
        console.log(
          `[bot] ignoring message ${payloadHashHex} from ${envelope.from} (${blockReason})`,
        )
        continue
      }

      const rawPlaintext = tryDecryptEnvelope({
        envelope,
        myPrivateKey: identity.toNakamotoPrivateKey(),
        senderPubKey,
      })
      if (rawPlaintext === undefined) {
        console.warn(
          `[bot] rejected unauthenticated or undecryptable message ${payloadHashHex}`,
        )
        continue
      }
      const plaintext = extractPromptText(rawPlaintext)
      if (plaintext === undefined) {
        console.log(
          `[bot] message ${payloadHashHex} has no text item -- not a prompt, skipping`,
        )
        continue
      }
      if (!guard.reserveReply(envelope.from)) {
        console.log(
          `[bot] reply budget for ${envelope.from} exhausted this window -- skipping message ${payloadHashHex}`,
        )
        continue
      }
      console.log(`[bot] decrypted: "${plaintext}"`)

      const history = state.getConversation(envelope.from) ?? [
        { role: 'system', content: SYSTEM_PROMPT },
      ]
      history.push({ role: 'user', content: plaintext })

      console.log(
        replyGenerator.mode === 'stub'
          ? '[bot] STUB mode: generating a canned reply (no model call) ...'
          : '[bot] asking Qwen 3.8 Max ...',
      )
      const completion = await replyGenerator.reply(history)
      console.log(
        `[bot] ${replyGenerator.mode === 'stub' ? 'STUB' : 'Qwen'} reasoning: ${completion.reasoning.slice(0, 400)}`,
      )
      console.log(
        `[bot] ${replyGenerator.mode === 'stub' ? 'STUB' : 'Qwen'} reply: "${completion.content}"`,
      )

      history.push({ role: 'assistant', content: completion.content })
      state.setConversation(envelope.from, history)

      console.log('[bot] stamping + sending reply over Monad testnet ...')
      // Ticket #77: goes through the shared `sendDirectMessageText` helper (`qwen-bot-common.ts`),
      // extracted from this exact build-envelope-then-submit sequence (previously duplicated
      // between this file and `qwen-bot-send-demo.livecheck.ts`) -- also the same path the new
      // auto-greet logic below uses. Ticket #57: a reply is a direct message, so its stamp must
      // pay the recipient (`envelope.from`, the human it's replying to) -- not burn to the fixed
      // `MONAD_STAMP_BURN_ADDRESS`, which is only correct for a broadcast with no single
      // recipient (see `chain/monad-chain.ts`'s `directMessages.send` for the same fix), and the
      // helper derives one-time stealth destinations from the recipient's registered public key.
      const result = await sendDirectMessageText({
        stampClient,
        pool,
        mainAccountSigner,
        provider,
        fromIdentity: identity,
        toAddress: envelope.from,
        toPubKey: senderPubKey,
        text: completion.content,
        stampValueWei,
        networkTag,
      })
      console.log(
        `[bot] reply sent -- payload_hash=${
          result.payloadHashHex
        } stamp txs=${result.txHashes.join(',')}`,
      )
      repliesSent++
      if (repliesSent >= maxReplies) break
    }

    if (stored.length > 0) {
      since = maxSeenTimestamp + 1
      state.setSince(since)
    }
    if (repliesSent >= maxReplies && greetingsSent >= maxGreetings) break
    // Flushed once per poll cycle (not just at final Close()) so a crash mid-run loses at most
    // the current cycle's writes, not everything back to the last clean exit.
    await state.flush()
    await sleep(pollIntervalMs)
  }

  console.log(
    `\nDone. Sent ${repliesSent} ${replyGenerator.mode === 'stub' ? 'STUB (canned)' : 'real Qwen-generated'} repl${
      repliesSent === 1 ? 'y' : 'ies'
    } and greeted+funded ${greetingsSent} new profile registration${
      greetingsSent === 1 ? '' : 's'
    } over Monad testnet.`,
  )
}

main()
  .finally(async () => {
    try {
      await closeBotState?.()
    } finally {
      await closeFundedSetup?.()
    }
  })
  .catch(err => {
    // Message only (no stack) for operator-facing config errors; opt into the stack for debugging.
    console.error(
      '\nQWEN BOT FAILED:',
      process.env.QWEN_BOT_DEBUG
        ? err
        : err instanceof Error
          ? err.message
          : err,
    )
    process.exit(1)
  })

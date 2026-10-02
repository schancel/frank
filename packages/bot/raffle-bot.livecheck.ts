/**
 * A headless Frank client that runs a provably-fair, N-entrant, winner-takes-the-pot raffle over
 * stamped DMs -- the fourth bot built on `qwen-bot-common.ts`'s shared framework (identity, lazy
 * stamp funding, `sendDirectMessageItems`).
 *
 * ## Why this bot can't be drained
 *
 * A trivia-style bot that pays a fixed reward for a correct answer has no cap tying its payout to
 * its revenue -- nothing stops it paying out more than it ever collects. This bot is structured so
 * that can't happen: every entry's price is that same message's own relay-verified stamp value (no
 * self-reported amount, same as `digital-goods.ts`'s `request`), and a round's payout is
 * *arithmetically* `entryPriceWei * entrants.length` -- exactly what that round's entrants already
 * paid in, never a number decided independently of that. The payout transaction is signed and sent
 * from the bot's own identity address (`identitySigner` below), not the shared `mainAccountSigner`
 * demo wallet blackjack/vendor-bot draw from for their own payouts/fulfillment.
 *
 * **This property depends on entry funds actually reaching the identity's spendable balance,
 * which they do not on their own** (ticket #121, found live 2026-09-28): a Monad DM stamp pays a
 * one-time *derived child address* per payment (`deriveMonadStampChildPublic`, ticket #60's
 * stealth-payment design), never the recipient identity's own EOA directly, despite an earlier
 * version of this file's header claiming otherwise. `recoverAndSweepEntryPayment` below is what
 * actually closes that gap: it reconstructs every child private key for an entry's message
 * (`recoverMonadStampPayments`, verified against the real on-chain destination of each payment,
 * never trusted from the message alone) and sweeps each one into the identity's own address
 * (`sweepRecoveredMonadStampPayment`) *before* the entrant is ever credited into the round. An
 * entrant is only added to `round.entrants` once every one of their payments has been swept and
 * confirmed -- so by the time a round can possibly reach `maxEntries` and draw, the identity's own
 * balance is a real, on-chain, already-confirmed reflection of every entrant's payment, not an
 * assumption about where stamp value lands. The only thing `mainAccountSigner` ever funds here is
 * a small, flat, round-count-independent gas reserve on the identity address (see
 * `ensureIdentityFunded`) -- ordinary bot-operation overhead, never payout money -- and the payout
 * path re-asserts the identity's balance actually covers the pot immediately before paying out.
 * NOTE (#363): swept entries arrive net of sweep gas, so the identity is always short of the gross
 * pot by that gas; `raffle-settlement.ts` covers only that bounded shortfall (plus payout gas) from
 * the operator wallet, and HOLDS the draw (never announces, never exits) when it cannot.
 *
 * ## Fairness scheme
 *
 * See `@frank/wallet/message-item-plugins/raffle/draw.ts`'s header for the full "why." Short version: this bot always
 * holds a `serverSeed` it generated (and hashed) *before* the round that will use it had any
 * entrants. Each entrant's own entry-payment tx hash is folded into that round's combined entropy
 * the instant their entry is accepted. At `draw`, the seed is published in plaintext so anyone can
 * independently replay the whole round (`verifyRaffleDraw`) and catch any deviation.
 *
 * ## Usage
 *
 *   cd packages/bot
 *   set -a; source ../../.env; set +a
 *   export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   yarn tsx raffle-bot.livecheck.ts
 *
 * Env vars:
 *   RAFFLE_BOT_IDENTITY_JSON     -- default /tmp/raffle-bot-identity.json
 *   RAFFLE_BOT_STATE_DIR         -- default ~/.frank-bots/raffle (or $XDG_STATE_HOME/frank-bots/raffle)
 *   RAFFLE_BOT_ENTRY_PRICE_WEI   -- default 0.02 MON
 *   RAFFLE_BOT_MAX_ENTRIES       -- entrants per round, default 5
 *   RAFFLE_BOT_MAX_ROUNDS        -- how many rounds to draw before exiting (default 1000)
 *   RAFFLE_BOT_MAX_TOPUP_WEI     -- largest operator top-up to cover sweep+payout gas, default 0.05 MON
 *   RAFFLE_BOT_POLL_INTERVAL_MS  -- default 4000
 *   RAFFLE_BOT_IDLE_TIMEOUT_MS   -- default 10 minutes
 */
import { randomBytes } from 'crypto'
import { resolve } from 'path'

import { getBytes, Provider, Transaction } from 'ethers'

import {
  canonicalMonadEnvelopeAddress,
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import {
  fetchMonadIdentityPubKey,
  MonadIdentity,
  mailboxAuthFor,
} from '@frank/wallet/monad-identity'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { RaffleItem } from '@frank/cashweb/types/messages'
import {
  combineEntrantEntropy,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/raffle/draw'
import { formatMon } from '@frank/wallet/monad-amount'
import { MonadHttpClient } from '@frank/wallet/monad-http'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import { estimateDustThresholdWei } from '@frank/wallet/monad-change-pool'
import {
  MonadStampedMessageProto,
  RecoveredMonadStampPayment,
  recoverMonadStampPayments,
  sweepRecoveredMonadStampPayment,
} from '@frank/wallet/monad-stamp-client'
import {
  loadOrCreateIdentity,
  registerAndLog,
  requiredEnv,
  sendDirectMessageItems,
  setUpFundedStampClient,
  waitForConfirmation,
} from './qwen-bot-common'
import { botProfileFields } from './bot-directory'
import { botStateDir } from './bot-state-dir'
import { botLoopGuardFromEnv } from './bot-loop-guard'
import {
  hasRaffleEntrant,
  RaffleBotStateStore,
  RaffleEntrant,
  RaffleRoundRecord,
} from './raffle-bot-state'
import {
  RAFFLE_DEFAULT_ENTRY_PRICE_WEI,
  RAFFLE_DEFAULT_MAX_ENTRIES,
  RAFFLE_DEFAULT_MAX_TOPUP_PER_DAY_WEI,
  RAFFLE_DEFAULT_MAX_TOPUP_WEI,
  repriceSignedPayout,
  RAFFLE_MAX_PAYMENTS_PER_ENTRY,
  RaffleSettlementPorts,
  runRaffleBot,
} from './raffle-settlement'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function generateServerSeed(): string {
  return randomBytes(32).toString('hex')
}

function generateRaffleId(): string {
  return randomBytes(16).toString('hex')
}

/** Pure, deterministic part of `recoverAndSweepEntryPayment` below -- exported and unit-tested
 * (`raffle-bot.jest.test.ts`) separately from the network-calling sweep loop, since this is the
 * part ticket #121 was actually about: binding an entry's value and entropy to its *complete*
 * verified payment set, not just `stampPayments[0]`. Sorts by `childIndex` (not array/wire order)
 * so two independent observers of the same message -- reconstructing this from the stored message
 * in any order -- always agree on both figures. */
export function summarizeRecoveredPayments(
  recovered: RecoveredMonadStampPayment[],
): { ordered: RecoveredMonadStampPayment[]; totalValueWei: bigint; combinedTxHash: string } {
  const ordered = [...recovered].sort((a, b) => a.childIndex - b.childIndex)
  const totalValueWei = ordered.reduce((sum, p) => sum + p.valueWei, 0n)
  const combinedTxHash = combineEntrantEntropy(ordered.map(p => p.txHash))
  return { ordered, totalValueWei, combinedTxHash }
}

/** Recovers and verifies every child payment for an entry's message (`recoverMonadStampPayments`,
 * checked against each payment's real on-chain destination -- never trusted from the message
 * alone), and only if their sum (`summarizeRecoveredPayments`) meets `minTotalValueWei` sweeps
 * every one of them into `destinationAddress` (the bot's own identity) *before* returning success
 * -- checking the threshold first means a short/insufficient entry never spends gas sweeping
 * payments no round will ever credit. Returns a failure reason instead of throwing for any
 * expected failure mode (a payment too small to sweep, one that never confirms) -- ticket #121's
 * acceptance criteria: missing/partial/ambiguous payments must fail closed, not silently accept a
 * short entry or leave funds unaccounted for. */
export async function recoverAndSweepEntryPayment(params: {
  message: MonadStampedMessageProto
  recipientPrivateKey: Uint8Array
  minTotalValueWei: bigint
  destinationAddress: string
  provider: Provider
  httpClient: MonadHttpClient
  identitySigner: MonadAccountTxSigner
  label: string
  /** Sweep gas tolerated per payment when comparing the amount actually swept to the price
   * (default: the current dust threshold estimate, the amount each sweep leaves behind). */
  dustToleranceWei?: bigint
}): Promise<
  | {
      ok: true
      totalValueWei: bigint
      combinedTxHash: string
      paymentCount: number
    }
  | {
      ok: false
      reason: string
      totalValueWei?: bigint
      /** Present once anything was swept into the identity: what to record as unclaimed. */
      sweptWei?: bigint
      paymentHashes?: string[]
      paymentCount?: number
    }
> {
  let recovered
  try {
    recovered = recoverMonadStampPayments({
      message: params.message,
      recipientPrivateKey: params.recipientPrivateKey,
    })
  } catch (err) {
    return {
      ok: false,
      reason: `payment verification failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (recovered.length === 0) {
    return { ok: false, reason: 'message carries no stamp payments' }
  }
  const { ordered, totalValueWei, combinedTxHash } =
    summarizeRecoveredPayments(recovered)

  if (totalValueWei < params.minTotalValueWei) {
    return {
      ok: false,
      reason: `payment ${formatMon(totalValueWei)} is below the required ${formatMon(params.minTotalValueWei)}`,
      totalValueWei,
    }
  }

  let sweptWei = 0n
  const paymentHashes = ordered.map(p => p.txHash)
  // Every rejection after this point may already hold entrant money in the identity: report it so
  // the caller records an `unclaimed` entry the operator can refund exactly once.
  const fail = (reason: string) => ({
    ok: false as const,
    reason,
    totalValueWei,
    sweptWei,
    paymentHashes,
    paymentCount: ordered.length,
  })
  for (const payment of ordered) {
    const outcome = await sweepRecoveredMonadStampPayment({
      payment,
      destinationAddress: params.destinationAddress,
      provider: params.provider,
      httpClient: params.httpClient,
    })
    if (outcome.swept) {
      sweptWei += outcome.valueWei
      continue
    }
    if (outcome.reason === 'below-dust-threshold') {
      return fail(
        `entry payment (child ${payment.childIndex}) is below the dust threshold to sweep`,
      )
    }
    // 'pending': a sweep tx was already submitted for this child key. Wait for it rather than
    // re-invoking the sweep (re-invoking would race the same child key's own nonce against its
    // still-in-flight transaction).
    if (!outcome.txHash) {
      return fail(
        `sweep for child ${payment.childIndex} is pending with no tx hash to await`,
      )
    }
    try {
      await waitForConfirmation(
        params.identitySigner,
        outcome.txHash,
        `${params.label} sweep (child ${payment.childIndex})`,
      )
      sweptWei += outcome.valueWei ?? 0n
    } catch (err) {
      return fail(
        `sweep for child ${payment.childIndex} did not confirm: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // What the identity ACTUALLY received (child balance minus the sweep's gas), not the claimed
  // payment values above: it must cover the price up to the sweep gas tolerance, or the entry is
  // not credited (the swept funds stay in the identity; the caller logs and rejects it).
  const dustTolerance =
    params.dustToleranceWei ?? (await estimateDustThresholdWei(params.provider))
  const toleratedWei = dustTolerance * BigInt(ordered.length)
  // Each payment loses one sweep gas on the way in and the draw's plausible-dust slack scales with
  // the payment count, so an entry in more than the cap is NOT credited; its funds were swept into
  // the identity above (operator-controlled) and are recorded for refund, never left at the
  // children. The cap is a griefing bound, not a rule for honest users.
  if (ordered.length > RAFFLE_MAX_PAYMENTS_PER_ENTRY) {
    return fail(
      `entry is split into ${ordered.length} payments; at most ${RAFFLE_MAX_PAYMENTS_PER_ENTRY} are counted`,
    )
  }
  if (sweptWei + toleratedWei < params.minTotalValueWei) {
    return fail(
      `only ${formatMon(sweptWei)} reached the raffle identity (plus up to ${formatMon(toleratedWei)} of sweep gas), below the required ${formatMon(params.minTotalValueWei)}`,
    )
  }

  return {
    ok: true,
    totalValueWei,
    combinedTxHash,
    paymentCount: ordered.length,
  }
}

async function main() {
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const networkTag = requiredEnv('FRANK_NETWORK_TAG')
  const minimumStampValueWei = BigInt(
    requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'),
  )
  const entryPriceWei = BigInt(
    process.env.RAFFLE_BOT_ENTRY_PRICE_WEI ?? RAFFLE_DEFAULT_ENTRY_PRICE_WEI,
  )
  if (entryPriceWei < minimumStampValueWei) {
    throw new Error(
      `Raffle bot entry price ${entryPriceWei} wei is below the relay minimum ${minimumStampValueWei}`,
    )
  }
  const maxEntries = Number(process.env.RAFFLE_BOT_MAX_ENTRIES ?? RAFFLE_DEFAULT_MAX_ENTRIES)
  if (maxEntries < 2) {
    throw new Error('RAFFLE_BOT_MAX_ENTRIES must be at least 2')
  }
  // Replies (announce/joined/error) go out with the relay's bare minimum stamp -- an entrant's own
  // `entryPriceWei` payment is what funds this bot; a reply is just a message, not another sale.
  const replyStampValueWei = minimumStampValueWei

  const identityJsonPath = resolve(
    process.cwd(),
    process.env.RAFFLE_BOT_IDENTITY_JSON ?? '/tmp/raffle-bot-identity.json',
  )
  const mainWalletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )
  const stateDirPath = botStateDir('raffle', 'RAFFLE_BOT_STATE_DIR')
  const pollIntervalMs = Number(process.env.RAFFLE_BOT_POLL_INTERVAL_MS ?? 4000)
  // Operator top-ups allowed to cover swept-entry gas + payout gas at draw time, per round and per
  // trailing day (see raffle-settlement.ts); beyond either the draw is held instead.
  const maxTopUpPerRoundWei = BigInt(
    process.env.RAFFLE_BOT_MAX_TOPUP_WEI ?? RAFFLE_DEFAULT_MAX_TOPUP_WEI,
  )
  const maxTopUpPerDayWei = BigInt(
    process.env.RAFFLE_BOT_MAX_TOPUP_PER_DAY_WEI ??
      RAFFLE_DEFAULT_MAX_TOPUP_PER_DAY_WEI,
  )
  const maxRounds = Number(process.env.RAFFLE_BOT_MAX_ROUNDS ?? 1000)
  const idleTimeoutMs = Number(
    process.env.RAFFLE_BOT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000,
  )

  console.log(
    '== Raffle bot: provably-fair, winner-takes-the-pot raffle over stamped Frank DMs ==',
  )
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Entry price:  ${entryPriceWei} wei`)
  console.log(`Round size:   ${maxEntries} entrants`)

  const identity = loadOrCreateIdentity(identityJsonPath, 'raffle-bot')
  await registerAndLog({
    relayBaseUrl,
    identity,
    label: 'raffle-bot',
    profile: botProfileFields('raffle'),
  })
  // #311: round-status replies go to humans only, at most a bounded number per peer per window.
  const guard = botLoopGuardFromEnv({
    selfAddress: identity.displayAddress,
    relayBaseUrl,
  })
  console.log(`Raffle bot identity address: ${identity.displayAddress}`)

  const { stampClient, mainAccountSigner, provider, pool, closePool } =
    await setUpFundedStampClient({
      rpcUrl,
      relayBaseUrl,
      mainWalletJsonPath,
      stampValueWei: replyStampValueWei,
      label: 'raffle-bot',
      stateDir: stateDirPath,
    })

  // This bot's own signer over its own identity's private key -- used *only* to pay a round's
  // winner, from the balance entrants themselves just paid into this same address. See this file's
  // header, "Why this bot can't be drained."
  const httpClient = new MonadHttpClient({ rpcUrl })
  const identitySigner = new MonadAccountTxSigner({
    privateKey: identity.toPrivateKeyHex(),
    provider,
    httpClient,
  })
  // Same private key, raw bytes -- `recoverMonadStampPayments` derives each entry's child payment
  // keys from this, never anyone else's.
  const recipientPrivateKey = getBytes(identity.toPrivateKeyHex())

  const state = new RaffleBotStateStore(stateDirPath)
  await state.Open()
  console.log(`[raffle-bot] persisted state loaded from ${stateDirPath}`)

  function openFreshRound(): RaffleRoundRecord {
    const serverSeed = generateServerSeed()
    const serverSeedHash = sha256Hex(serverSeed)
    state.setPendingCommitment(serverSeed, serverSeedHash)
    const round: RaffleRoundRecord = {
      raffleId: generateRaffleId(),
      entryPriceWei: entryPriceWei.toString(),
      maxEntries,
      serverSeedHash,
      entrants: [],
    }
    state.setCurrentRound(round)
    return round
  }

  // The pending commitment (and the round bound to it) must already exist before this run can see
  // its first entry -- pick up a restart's in-progress round, or open the very first one.
  if (!state.getPendingCommitment() || !state.getCurrentRound()) {
    const round = openFreshRound()
    console.log(
      `[raffle-bot] opened round ${round.raffleId} (commitment ${round.serverSeedHash})`,
    )
  } else {
    const round = state.getCurrentRound() as RaffleRoundRecord
    console.log(
      `[raffle-bot] resumed round ${round.raffleId} (${round.entrants.length}/${round.maxEntries} entered)`,
    )
  }

  const senderPubKeyCache = new Map<string, Buffer>()

  const ports: RaffleSettlementPorts = {
    getBalanceWei: () =>
      provider.getBalance(identity.displayAddress, 'latest'),
    operatorBalanceWei: () =>
      provider.getBalance(mainAccountSigner.address, 'latest'),
    sweepDustWei: () => estimateDustThresholdWei(provider),
    repricePayout: (previousRawTx, gasBudgetWei) =>
      repriceSignedPayout({
        previousRawTx,
        gasBudgetWei,
        sign: async (to, value, overrides) => {
          const tx = await identitySigner.buildAndSignTransfer(
            to,
            value,
            overrides,
          )
          return { rawTx: tx.rawTx, txHash: tx.txHash }
        },
      }),
    isTxKnown: async txHash => (await provider.getTransaction(txHash)) !== null,
    error: message => console.error(message),
    payoutGasReserveWei: async () => {
      const feeData = await provider.getFeeData()
      const maxFeePerGas = feeData.maxFeePerGas ?? BigInt(250000000000)
      return (maxFeePerGas * BigInt(21000) * BigInt(11)) / BigInt(10)
    },
    signTopUp: async amountWei => {
      console.log(
        `[raffle-bot] topping up identity by ${amountWei} wei from the operator (stamp) wallet to cover swept-entry gas and payout gas`,
      )
      const tx = await mainAccountSigner.buildAndSignTransfer(
        identity.displayAddress,
        amountWei,
      )
      return { rawTx: tx.rawTx, txHash: tx.txHash }
    },
    broadcastTopUp: async (rawTx, txHash) => {
      await mainAccountSigner.submitRaw(rawTx, txHash)
    },
    getTopUpStatus: txHash => mainAccountSigner.getStatus(txHash),
    signPayout: async (to, valueWei) => {
      const tx = await identitySigner.buildAndSignTransfer(to, valueWei)
      return { rawTx: tx.rawTx, txHash: tx.txHash }
    },
    broadcast: async (rawTx, txHash) => {
      await identitySigner.submitRaw(rawTx, txHash)
    },
    getStatus: txHash => identitySigner.getStatus(txHash),
    announce: async (entrantAddress, drawItem) => {
      const entrantKey = canonicalMonadEnvelopeAddress(entrantAddress)
      let toPubKey = senderPubKeyCache.get(entrantKey)
      if (!toPubKey) {
        toPubKey = await fetchMonadIdentityPubKey({
          relayBaseUrl,
          address: entrantAddress,
        })
        if (!toPubKey) {
          console.warn(
            `[raffle-bot] no public key for ${entrantAddress}; cannot deliver the draw message`,
          )
          return
        }
        senderPubKeyCache.set(entrantKey, toPubKey)
      }
      await sendDirectMessageItems({
        stampClient,
        pool,
        mainAccountSigner,
        provider,
        fromIdentity: identity,
        toAddress: entrantAddress,
        toPubKey,
        items: [drawItem],
        stampValueWei: replyStampValueWei,
        networkTag,
      })
    },
    log: message => console.log(message),
    warn: message => console.warn(message),
  }

  let since = Date.now()

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad/inbox/<me> (signed mailbox read, since=<t>) every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )

  // One inbox pass. The loop around it (`runRaffleLoop`, tested) also resumes a persisted full
  // round or unsettled draw on its first tick, retries held/unfinished draws every tick, and never
  // idle-exits while a draw is unsettled.
  const pollOnce = async (ctx: {
    markActivity(): void
    roundsDrawn(): number
    drawAndSettle(): Promise<void>
  }) => {
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
      // Deliberately NOT marked processed yet for a message that might turn out to carry a raffle
      // `enter` -- see the `request` branch below, "Durability" comment, for why that path defers
      // this until an entry is either fully credited or conclusively rejected. Every other exit
      // below is a stateless no-op (nothing to resume), so marking immediately is safe there.
      const markProcessed = () => state.addProcessed(payloadHashHex)

      const envelope = parseEnvelope(message.message.encryptedPayload)
      if (!envelope) {
        markProcessed()
        continue
      }
      if (!sameMonadEnvelopeAddress(envelope.to, identity.displayAddress)) {
        markProcessed()
        continue
      }
      if (sameMonadEnvelopeAddress(envelope.from, identity.displayAddress)) {
        markProcessed()
        continue
      }

      const senderKey = canonicalMonadEnvelopeAddress(envelope.from)
      let senderPubKey = senderPubKeyCache.get(senderKey)
      if (!senderPubKey) {
        senderPubKey = await fetchMonadIdentityPubKey({
          relayBaseUrl,
          address: envelope.from,
        })
        if (!senderPubKey) {
          markProcessed()
          continue
        }
        senderPubKeyCache.set(senderKey, senderPubKey)
      }

      const rawPlaintext = tryDecryptEnvelope({
        envelope,
        myPrivateKey: identity.toNakamotoPrivateKey(),
        senderPubKey,
      })
      if (rawPlaintext === undefined) {
        console.warn(
          `[raffle-bot] rejected unauthenticated or undecryptable message ${payloadHashHex}`,
        )
        markProcessed()
        continue
      }

      let items
      try {
        items = deserializeMessageItems(rawPlaintext)
      } catch {
        markProcessed()
        continue
      }
      const request = items.find(
        (item): item is RaffleItem =>
          item.type === 'raffle' && item.action === 'enter',
      )

      ctx.markActivity()

      const sendReply = async (
        replyItems: RaffleItem[],
        stampValueWei: bigint = replyStampValueWei,
      ) =>
        sendDirectMessageItems({
          stampClient,
          pool,
          mainAccountSigner,
          provider,
          fromIdentity: identity,
          toAddress: envelope.from,
          toPubKey: senderPubKey as Buffer,
          items: replyItems,
          stampValueWei,
          networkTag,
        })

      const round = state.getCurrentRound() as RaffleRoundRecord

      if (!request) {
        // Any other message from a would-be entrant gets the current round's status -- except from
        // another bot, and only within the per-peer budget (#311, ping-pong prevention).
        const blockReason = await guard.peerBlockReason(envelope.from)
        if (blockReason || !guard.reserveReply(envelope.from)) {
          console.log(
            `[raffle-bot] not sending round status to ${envelope.from} (${
              blockReason ?? 'reply budget exhausted this window'
            })`,
          )
          markProcessed()
          continue
        }
        console.log(`\n[raffle-bot] sending round status to ${envelope.from}`)
        await sendReply([
          {
            type: 'raffle',
            raffleId: round.raffleId,
            action: 'announce',
            entryPriceWei: round.entryPriceWei,
            maxEntries: round.maxEntries,
            entryCount: round.entrants.length,
            serverSeedHash: round.serverSeedHash,
          },
        ])
        markProcessed()
        continue
      }

      console.log(`\n[raffle-bot] entry request from ${envelope.from}`)

      if (hasRaffleEntrant(round, envelope.from)) {
        await sendReply([
          {
            type: 'raffle',
            raffleId: round.raffleId,
            action: 'error',
            message: 'You have already entered this round.',
          },
        ])
        markProcessed()
        continue
      }

      // Recovers, verifies, and (only once the price threshold is met) sweeps every child payment
      // this message actually made into this bot's own identity balance -- see this function's
      // own header, and this file's header ("Why this bot can't be drained"), for why this
      // replaced trusting `stampPayments[0]` alone. Not marked processed until this resolves
      // either way (durability: see `markProcessed`'s own comment above) -- a restart mid-sweep
      // safely re-attempts, since `sweepRecoveredMonadStampPayment` itself checks each child
      // address's real on-chain balance before acting, and `hasRaffleEntrant` above already
      // guards against crediting the same entrant twice.
      const swept = await recoverAndSweepEntryPayment({
        message: message.message,
        recipientPrivateKey,
        minTotalValueWei: BigInt(round.entryPriceWei),
        destinationAddress: identity.displayAddress,
        provider,
        httpClient,
        identitySigner,
        label: 'raffle-bot',
      })
      if (!swept.ok) {
        console.log(`[raffle-bot] rejecting -- ${swept.reason}`)
        let note = ''
        if (swept.sweptWei !== undefined && swept.sweptWei > 0n) {
          // Money already reached the identity: record it so the operator can refund it once.
          const entrantAddress = canonicalMonadEnvelopeAddress(envelope.from)
          await state.putUnclaimed({
            id: `${entrantAddress}:${sha256Hex((swept.paymentHashes ?? []).join(',')).slice(0, 16)}`,
            entrant: entrantAddress,
            paymentHashes: swept.paymentHashes ?? [],
            sweptWei: swept.sweptWei.toString(),
            reason: swept.reason,
            atMs: Date.now(),
          })
          console.warn(
            `[raffle-bot] UNCLAIMED ${formatMon(swept.sweptWei)} from ${entrantAddress} (${swept.paymentCount} payments) swept but not credited; refund with 'yarn raffle:refund --list'. Reason: ${swept.reason}`,
          )
          note = ` Your ${swept.paymentCount} payment(s) (${(swept.paymentHashes ?? []).join(', ')}) were received but the entry was not counted; the operator will refund ${formatMon(swept.sweptWei)}.`
        }
        await sendReply([
          {
            type: 'raffle',
            raffleId: round.raffleId,
            action: 'error',
            message: `Entry rejected: ${swept.reason}.${note}`,
          },
        ])
        markProcessed()
        continue
      }

      const entrant: RaffleEntrant = {
        address: canonicalMonadEnvelopeAddress(envelope.from),
        txHash: swept.combinedTxHash,
        payments: swept.paymentCount,
      }
      const updatedEntrants = [...round.entrants, entrant]
      const updatedRound: RaffleRoundRecord = {
        ...round,
        entrants: updatedEntrants,
      }
      state.setCurrentRound(updatedRound)
      // The entrant is durably credited (and the on-chain funds durably swept) as of the line
      // above -- safe to mark this message processed now, whatever happens for the rest of this
      // iteration (sending the 'joined' reply, or even a full round draw below).
      markProcessed()

      console.log(
        `[raffle-bot] ${envelope.from} entered round ${round.raffleId} (${updatedEntrants.length}/${round.maxEntries}, swept ${swept.totalValueWei} wei)`,
      )

      await sendReply([
        {
          type: 'raffle',
          raffleId: round.raffleId,
          action: 'joined',
          entryPriceWei: round.entryPriceWei,
          maxEntries: round.maxEntries,
          entryCount: updatedEntrants.length,
          serverSeedHash: round.serverSeedHash,
        },
      ])

      if (updatedEntrants.length < round.maxEntries) continue

      // Round is full. Order (see raffle-settlement.ts): record the draw + rotate to a fresh
      // commitment atomically, verify/fund the pot, persist then broadcast the payout, reconcile
      // by hash, and only then announce (reveal the seed). Nothing here may throw the process.
      await ctx.drawAndSettle()
      if (ctx.roundsDrawn() >= maxRounds) break
    }

    if (stored.length > 0) since = maxSeenTimestamp + 1
    await state.flush()
  }

  const { roundsDrawn } = await runRaffleBot({
    state,
    ports,
    maxTopUpPerRoundWei,
    maxTopUpPerDayWei,
    round: {
      entryPriceWei: entryPriceWei.toString(),
      maxEntries,
      newServerSeed: generateServerSeed,
      newRaffleId: generateRaffleId,
    },
    pollOnce,
    sleep: () => sleep(pollIntervalMs),
    now: Date.now,
    idleTimeoutMs,
    maxRounds,
    onIdleExit: () =>
      console.log(`\nNo activity within ${idleTimeoutMs}ms -- exiting.`),
  })

  await state.Close()
  await closePool()
  console.log(
    `\nDone. Drew ${roundsDrawn} round${roundsDrawn === 1 ? '' : 's'}.`,
  )
}

// Guarded so `raffle-bot.jest.test.ts` can import `summarizeRecoveredPayments` above without this
// script's own `main()` (real network calls, `requiredEnv` throwing outside a real run) executing
// as an import side effect.
if (require.main === module) {
  main().catch(err => {
    console.error('RAFFLE BOT FAILED:', err)
    process.exit(1)
  })
}

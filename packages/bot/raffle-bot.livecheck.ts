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
 * path re-asserts the identity's balance actually covers the pot immediately before paying out, so
 * a bug here fails closed (refuses to draw) rather than silently drawing the shortfall from that
 * shared wallet.
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
 *   RAFFLE_BOT_STATE_DIR         -- default /tmp/raffle-bot-state
 *   RAFFLE_BOT_ENTRY_PRICE_WEI   -- default 0.02 MON
 *   RAFFLE_BOT_MAX_ENTRIES       -- entrants per round, default 5
 *   RAFFLE_BOT_MAX_ROUNDS        -- how many rounds to draw before exiting (default 1000)
 *   RAFFLE_BOT_POLL_INTERVAL_MS  -- default 4000
 *   RAFFLE_BOT_IDLE_TIMEOUT_MS   -- default 10 minutes
 */
import { randomBytes } from 'crypto'
import { resolve } from 'path'

import { getBytes, Provider } from 'ethers'

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
} from '@frank/wallet/monad-identity'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { RaffleItem } from '@frank/cashweb/types/messages'
import {
  combineEntrantEntropy,
  pickWinnerIndex,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/raffle/draw'
import { MonadHttpClient } from '@frank/wallet/monad-http'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
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
import {
  hasRaffleEntrant,
  hasRaffleLeft,
  PendingRefund,
  RaffleBotStateStore,
  RaffleEntrant,
  RaffleRoundRecord,
  removeRaffleEntrant,
} from './raffle-bot-state'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function generateServerSeed(): string {
  return randomBytes(32).toString('hex')
}

function generateRaffleId(): string {
  return randomBytes(16).toString('hex')
}

/** Pure decision for a `leave` request -- no I/O. Rejects, in order: a `raffleId` that is not the
 * *current* round (a stale leave for a round that already drew and rotated must never be read as
 * "leave whatever round I'm in now"); a round that is already full (`entrants.length >=
 * maxEntries`), because a full round is being or has been drawn -- the draw DMs reveal the seed,
 * and a round can stay persisted as full if the draw path throws or crashes after those DMs, so a
 * loser who has seen the seed must not be refunded from the shared balance the winner is paid
 * from; a second leave by the same address in the same round (ticket #209: churn bound of one
 * leave per address per round); and an address that is not entered. */
export function evaluateLeaveRequest(params: {
  round: RaffleRoundRecord
  raffleId: string
  requesterAddress: string
}):
  | { ok: true; updatedRound: RaffleRoundRecord; refundWei: bigint }
  | { ok: false; reason: string } {
  const { round, raffleId, requesterAddress } = params
  if (round.raffleId !== raffleId) {
    return {
      ok: false,
      reason: 'that round has already closed -- nothing to leave',
    }
  }
  if (round.entrants.length >= round.maxEntries) {
    return {
      ok: false,
      reason:
        'this round is full and is being drawn -- it can no longer be left',
    }
  }
  if (hasRaffleLeft(round, requesterAddress)) {
    return {
      ok: false,
      reason:
        'you already left this round -- only one leave per address per round is allowed',
    }
  }
  if (!hasRaffleEntrant(round, requesterAddress)) {
    return { ok: false, reason: 'you are not entered in the current round' }
  }
  const removed = removeRaffleEntrant(round, requesterAddress)
  return {
    ok: true,
    updatedRound: {
      ...removed,
      leavers: [
        ...(round.leavers ?? []),
        canonicalMonadEnvelopeAddress(requesterAddress),
      ],
    },
    refundWei: BigInt(round.entryPriceWei),
  }
}

export interface RefundDeps {
  state: RaffleBotStateStore
  identityAddress: string
  provider: Pick<Provider, 'getBalance' | 'getFeeData' | 'getTransactionCount'>
  signer: {
    buildAndSignTransfer(
      to: string,
      value: bigint,
    ): Promise<{ rawTx: string; txHash: string; nonce: number }>
    submitRaw(rawTx: string, expectedTxHash: string): Promise<string>
    getStatus(txHash: string): Promise<'pending' | 'confirmed' | 'failed'>
  }
  /** Tops the identity's gas reserve up to `neededWei` (see `ensureIdentityFunded`). */
  ensureFunded(neededWei: bigint): Promise<void>
}

/** Sum of every refund still owed or in flight (record not yet cleared, i.e. not yet CONFIRMED).
 * These wei are already spoken for: a `latest` balance may still include an unmined refund, so
 * the draw payout's balance check subtracts this (`raffle-bot.livecheck.ts` draw path). */
export function reservedRefundWei(
  state: RaffleBotStateStore,
  excludePayloadHash?: string,
): bigint {
  return state
    .getPendingRefunds()
    .filter(r => r.payloadHash !== excludePayloadHash)
    .reduce((sum, r) => sum + BigInt(r.amountWei), 0n)
}

/** What the draw payout can actually spend: the `latest` balance minus every refund not yet
 * confirmed (an unmined refund's wei is still in `latest` but will leave first). */
export function drawSpendableWei(
  latestBalanceWei: bigint,
  state: RaffleBotStateStore,
): bigint {
  return latestBalanceWei - reservedRefundWei(state)
}

/** Resolves a refund that already has a journaled signed tx. Never signs anything new.
 *  - receipt success  -> clear the record (only now: mempool acceptance is not payment).
 *  - receipt failed, or its nonce is below the account's confirmed nonce with no receipt -> the
 *    tx can never mine (its nonce was consumed by another tx or it reverted), so the journal is
 *    discarded (record kept, tx fields removed) and the caller re-signs fresh. Exactly one refund
 *    can still land: the old tx is provably dead. The confirmed nonce is read BEFORE the receipt
 *    so a tx mined in between shows up as a receipt, never as a false "dead".
 *  - otherwise re-broadcast the SAME bytes (idempotent by hash) and keep the record. */
async function resolveJournaled(
  refund: PendingRefund,
  deps: RefundDeps,
): Promise<'confirmed' | 'submitted' | 'discarded'> {
  const { state, signer } = deps
  const txHash = refund.txHash as string
  const confirmedNonce = await deps.provider.getTransactionCount(
    deps.identityAddress,
    'latest',
  )
  const status = await signer.getStatus(txHash)
  if (status === 'confirmed') {
    state.clearPendingRefund(refund.payloadHash)
    await state.flush()
    return 'confirmed'
  }
  if (
    status === 'failed' ||
    (refund.nonce !== undefined && refund.nonce < confirmedNonce)
  ) {
    state.clearPendingRefundTx(refund.payloadHash)
    await state.flush()
    return 'discarded'
  }
  try {
    await signer.submitRaw(refund.rawTx as string, txHash)
  } catch (err) {
    // Re-broadcasting a tx the node already has is fine; anything else (e.g. nonce too low)
    // propagates and is re-evaluated by the next sweep, which sees the consumed nonce.
    if (!/already known|known transaction/i.test(String(err))) throw err
  }
  return 'submitted'
}

/** Pays one journaled refund. Exact ordering (the whole point of the journal):
 *
 *  1. The caller has already made the entrant's removal, the processed marker and this
 *     `PendingRefund` record durable in ONE atomic batch (`commitLeave`) + flush. Crash before
 *     that: nothing changed, the leave is replayed from the start (the entrant is still entered).
 *     Crash after: the entrant is removed AND a refund record exists -- never one without the other.
 *  2. Fail-closed balance check (balance must cover this refund + the current round's pot + other
 *     owed refunds). If not, 'insufficient-balance': the record stays (unsigned, nothing ever
 *     submitted) and the periodic sweep retries with backoff.
 *  3. Nonce serialization: before signing, every OTHER journaled refund is resolved first
 *     (`resolveJournaled`), so a new refund is never signed with a pending nonce an unsubmitted
 *     journaled tx is about to use. The draw payout does the same sweep before it signs.
 *     Once a tx is in the mempool, the next signing uses the following pending nonce, no clash.
 *  4. Sign, journal `{txHash, rawTx, nonce}` and FLUSH strictly before submitting.
 *  5. Submit. Returns 'submitted'; the record is NOT cleared here.
 *  6. The record is cleared only when a sweep sees a receipt with success (`resolveJournaled`).
 *     A dropped/replaced tx therefore never loses the refund: it either gets rebroadcast, or its
 *     nonce is seen consumed without our receipt and it is re-signed (one refund total).
 *
 * Left for an operator: nothing automatic; a permanently failing RPC just keeps retrying. */
export async function executeRefund(
  refund: PendingRefund,
  deps: RefundDeps,
): Promise<'confirmed' | 'submitted' | 'insufficient-balance' | 'deferred'> {
  const { state, signer } = deps
  if (refund.rawTx && refund.txHash) {
    const resolved = await resolveJournaled(refund, deps)
    if (resolved !== 'discarded') return resolved
  }
  for (const other of state.getPendingRefunds()) {
    if (other.payloadHash === refund.payloadHash || !other.rawTx) continue
    try {
      await resolveJournaled(other, deps)
    } catch {
      return 'deferred'
    }
  }
  const balanceWei = await deps.provider.getBalance(deps.identityAddress)
  const amountWei = BigInt(refund.amountWei)
  const round = state.getCurrentRound()
  const potWei = round
    ? BigInt(round.entryPriceWei) * BigInt(round.entrants.length)
    : 0n
  if (
    balanceWei <
    amountWei + potWei + reservedRefundWei(state, refund.payloadHash)
  ) {
    return 'insufficient-balance'
  }
  const gasBufferWei = await computeGasBufferWei(deps.provider)
  await deps.ensureFunded(balanceWei + gasBufferWei)
  const signed = await signer.buildAndSignTransfer(refund.recipient, amountWei)
  state.setPendingRefundTx(
    refund.payloadHash,
    signed.txHash,
    signed.rawTx,
    signed.nonce,
  )
  await state.flush()
  try {
    await signer.submitRaw(signed.rawTx, signed.txHash)
  } catch (err) {
    if (!/already known|known transaction/i.test(String(err))) throw err
  }
  return 'submitted'
}

/** One attempt at every pending refund. Used at startup, before every draw, and by the periodic
 * sweeper. Sends no reply (no sender key at hand). `errored` lists refunds whose attempt threw. */
export async function retryPendingRefunds(
  deps: RefundDeps,
  log: (msg: string) => void = console.log,
): Promise<{ confirmed: string[]; stillPending: string[]; errored: string[] }> {
  const confirmed: string[] = []
  const stillPending: string[] = []
  const errored: string[] = []
  for (const refund of deps.state.getPendingRefunds()) {
    try {
      const result = await executeRefund(refund, deps)
      if (result === 'confirmed') confirmed.push(refund.payloadHash)
      else stillPending.push(refund.payloadHash)
    } catch (err) {
      log(
        `[raffle-bot] pending refund ${
          refund.payloadHash
        } still unpaid: ${String(err)}`,
      )
      stillPending.push(refund.payloadHash)
      errored.push(refund.payloadHash)
    }
  }
  return { confirmed, stillPending, errored }
}

/** Bounded periodic retry for the poll loop: at most one sweep in flight, exponential backoff
 * (baseMs doubling up to maxMs) while anything is still pending, reset once nothing is. */
export function createRefundSweeper(
  deps: RefundDeps,
  opts: { now?: () => number; baseMs?: number; maxMs?: number } = {},
): { tick(): Promise<void> } {
  const now = opts.now ?? Date.now
  const baseMs = opts.baseMs ?? 10_000
  const maxMs = opts.maxMs ?? 5 * 60_000
  let delayMs = baseMs
  let nextAt = 0
  let running = false
  return {
    async tick() {
      if (running || now() < nextAt) return
      if (deps.state.getPendingRefunds().length === 0) {
        delayMs = baseMs
        return
      }
      running = true
      try {
        const r = await retryPendingRefunds(deps)
        if (r.stillPending.length > 0) {
          nextAt = now() + delayMs
          delayMs = Math.min(delayMs * 2, maxMs)
        } else {
          delayMs = baseMs
          nextAt = 0
        }
      } finally {
        running = false
      }
    },
  }
}

/** The whole `leave` handler (decision, state mutation, refund, reply), extracted from the poll
 * loop so it is testable with fakes. */
export async function handleLeaveRequest(
  params: RefundDeps & {
    round: RaffleRoundRecord
    raffleId: string
    requesterAddress: string
    payloadHashHex: string
    sendReply(items: RaffleItem[]): Promise<unknown>
  },
): Promise<'rejected' | 'refunded' | 'refund-pending'> {
  const { state, round, payloadHashHex, sendReply } = params
  const evaluation = evaluateLeaveRequest({
    round,
    raffleId: params.raffleId,
    requesterAddress: params.requesterAddress,
  })
  if (!evaluation.ok) {
    await sendReply([
      {
        type: 'raffle',
        raffleId: round.raffleId,
        action: 'error',
        message: evaluation.reason,
      },
    ])
    state.addProcessed(payloadHashHex)
    return 'rejected'
  }
  const refund: PendingRefund = {
    payloadHash: payloadHashHex,
    recipient: canonicalMonadEnvelopeAddress(params.requesterAddress),
    amountWei: evaluation.refundWei.toString(),
    raffleId: round.raffleId,
  }
  // Durable BEFORE any money moves -- see `executeRefund`'s ordering comment.
  state.commitLeave(evaluation.updatedRound, refund, payloadHashHex)
  await state.flush()

  let result: Awaited<ReturnType<typeof executeRefund>> | 'error' = 'error'
  try {
    result = await executeRefund(refund, params)
  } catch (err) {
    console.error(
      `[raffle-bot] refund for ${refund.recipient} failed: ${String(err)}`,
    )
  }
  if (result !== 'submitted' && result !== 'confirmed') {
    await sendReply([
      {
        type: 'raffle',
        raffleId: round.raffleId,
        action: 'error',
        message:
          'Left the round, but the refund could not be sent right now -- it is recorded and retried automatically.',
      },
    ])
    return 'refund-pending'
  }
  await sendReply([
    {
      type: 'raffle',
      raffleId: round.raffleId,
      action: 'left',
      entryPriceWei: round.entryPriceWei,
      maxEntries: round.maxEntries,
      entryCount: evaluation.updatedRound.entrants.length,
      serverSeedHash: round.serverSeedHash,
    },
  ])
  return 'refunded'
}

/** Pure, deterministic part of `recoverAndSweepEntryPayment` below -- exported and unit-tested
 * (`raffle-bot.jest.test.ts`) separately from the network-calling sweep loop, since this is the
 * part ticket #121 was actually about: binding an entry's value and entropy to its *complete*
 * verified payment set, not just `stampPayments[0]`. Sorts by `childIndex` (not array/wire order)
 * so two independent observers of the same message -- reconstructing this from the stored message
 * in any order -- always agree on both figures. */
export function summarizeRecoveredPayments(
  recovered: RecoveredMonadStampPayment[],
): {
  ordered: RecoveredMonadStampPayment[]
  totalValueWei: bigint
  combinedTxHash: string
} {
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
async function recoverAndSweepEntryPayment(params: {
  message: MonadStampedMessageProto
  recipientPrivateKey: Uint8Array
  minTotalValueWei: bigint
  destinationAddress: string
  provider: Provider
  httpClient: MonadHttpClient
  identitySigner: MonadAccountTxSigner
  label: string
}): Promise<
  | { ok: true; totalValueWei: bigint; combinedTxHash: string }
  | { ok: false; reason: string; totalValueWei?: bigint }
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
      reason: `payment verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
      reason: `payment ${totalValueWei} wei is below the required ${params.minTotalValueWei} wei`,
      totalValueWei,
    }
  }

  for (const payment of ordered) {
    const outcome = await sweepRecoveredMonadStampPayment({
      payment,
      destinationAddress: params.destinationAddress,
      provider: params.provider,
      httpClient: params.httpClient,
    })
    if (outcome.swept) continue
    if (outcome.reason === 'below-dust-threshold') {
      return {
        ok: false,
        reason: `entry payment (child ${payment.childIndex}) is below the dust threshold to sweep`,
      }
    }
    // 'pending': a sweep tx was already submitted for this child key. Wait for it rather than
    // re-invoking the sweep (re-invoking would race the same child key's own nonce against its
    // still-in-flight transaction).
    if (!outcome.txHash) {
      return {
        ok: false,
        reason: `sweep for child ${payment.childIndex} is pending with no tx hash to await`,
      }
    }
    try {
      await waitForConfirmation(
        params.identitySigner,
        outcome.txHash,
        `${params.label} sweep (child ${payment.childIndex})`,
      )
    } catch (err) {
      return {
        ok: false,
        reason: `sweep for child ${payment.childIndex} did not confirm: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }
  }

  return { ok: true, totalValueWei, combinedTxHash }
}

/** Tops up `identitySigner`'s own on-chain balance from `mainAccountSigner` if it's short of
 * `neededWei` -- a small, flat, per-payout operational gas cost, never scaled to a round's pot size
 * (see this file's header, "Why this bot can't be drained"). Only ever moves enough to cover the
 * shortfall, never a fixed lump sum, so repeated calls don't compound. */
async function ensureIdentityFunded(params: {
  identityAddress: string
  mainAccountSigner: MonadAccountTxSigner
  provider: Provider
  neededWei: bigint
  label: string
}): Promise<void> {
  const balance = await params.provider.getBalance(params.identityAddress)
  if (balance >= params.neededWei) return
  const shortfall = params.neededWei - balance
  console.log(
    `[${params.label}] topping up identity gas reserve by ${shortfall} wei from the main funded wallet`,
  )
  const signedTx = await params.mainAccountSigner.buildAndSignTransfer(
    params.identityAddress,
    shortfall,
  )
  const txHash = await params.mainAccountSigner.submit(signedTx)
  await waitForConfirmation(
    params.mainAccountSigner,
    txHash,
    `${params.label} identity funding`,
  )
}

/** A flat, single-transfer gas reserve -- shared by the draw payout and the leave refund below,
 * the only two places this bot ever sends its own identity's funds out. Never scaled to a round's
 * pot size (see this file's header, "Why this bot can't be drained"). */
async function computeGasBufferWei(
  provider: Pick<Provider, 'getFeeData'>,
): Promise<bigint> {
  const feeData = await provider.getFeeData()
  const fallbackMaxFeePerGas = BigInt(250000000000)
  const maxFeePerGas = feeData.maxFeePerGas ?? fallbackMaxFeePerGas
  return (maxFeePerGas * BigInt(21000) * BigInt(11)) / BigInt(10)
}

async function main() {
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const networkTag = requiredEnv('FRANK_NETWORK_TAG')
  const minimumStampValueWei = BigInt(
    requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'),
  )
  const entryPriceWei = BigInt(
    process.env.RAFFLE_BOT_ENTRY_PRICE_WEI ?? '20000000000000000', // 0.02 MON
  )
  if (entryPriceWei < minimumStampValueWei) {
    throw new Error(
      `Raffle bot entry price ${entryPriceWei} wei is below the relay minimum ${minimumStampValueWei}`,
    )
  }
  const maxEntries = Number(process.env.RAFFLE_BOT_MAX_ENTRIES ?? 5)
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
  const stateDirPath = resolve(
    process.cwd(),
    process.env.RAFFLE_BOT_STATE_DIR ?? '/tmp/raffle-bot-state',
  )
  const pollIntervalMs = Number(process.env.RAFFLE_BOT_POLL_INTERVAL_MS ?? 4000)
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
  await registerAndLog({ relayBaseUrl, identity, label: 'raffle-bot' })
  console.log(`Raffle bot identity address: ${identity.displayAddress}`)

  const { stampClient, mainAccountSigner, provider, pool } =
    await setUpFundedStampClient({
      rpcUrl,
      relayBaseUrl,
      mainWalletJsonPath,
      stampValueWei: replyStampValueWei,
      label: 'raffle-bot',
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

  const refundDeps: RefundDeps = {
    state,
    identityAddress: identity.displayAddress,
    provider,
    signer: identitySigner,
    ensureFunded: neededWei =>
      ensureIdentityFunded({
        identityAddress: identity.displayAddress,
        mainAccountSigner,
        provider,
        neededWei,
        label: 'raffle-bot',
      }),
  }
  // Resolve any refund a previous run journaled but did not finish, then keep sweeping (bounded,
  // with backoff) from inside the poll loop so a transient failure never waits for a restart.
  const retried = await retryPendingRefunds(refundDeps)
  if (retried.confirmed.length + retried.stillPending.length > 0) {
    console.log(
      `[raffle-bot] pending refunds: ${retried.confirmed.length} confirmed, ${retried.stillPending.length} still pending`,
    )
  }
  const refundSweeper = createRefundSweeper(refundDeps)

  const senderPubKeyCache = new Map<string, Buffer>()
  let since = Date.now()
  let roundsDrawn = 0
  let lastActivityAt = Date.now()

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad?since=<t> every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )

  while (roundsDrawn < maxRounds) {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      console.log(`\nNo activity within ${idleTimeoutMs}ms -- exiting.`)
      break
    }

    await refundSweeper.tick().catch(err => {
      console.error(`[raffle-bot] refund sweep failed: ${String(err)}`)
    })
    const stored = await fetchMonadMessagesSince({
      relayBaseUrl,
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
        myPrivateKey: identity.toBitcorePrivateKey(),
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
      const leaveRequest = items.find(
        (item): item is RaffleItem =>
          item.type === 'raffle' && item.action === 'leave',
      )

      lastActivityAt = Date.now()

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

      if (leaveRequest) {
        console.log(`\n[raffle-bot] leave request from ${envelope.from}`)
        await handleLeaveRequest({
          ...refundDeps,
          round,
          raffleId: leaveRequest.raffleId,
          requesterAddress: envelope.from,
          payloadHashHex,
          sendReply,
        })
        continue
      }

      if (!request) {
        // Any other message from a would-be entrant gets the current round's status.
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
        await sendReply([
          {
            type: 'raffle',
            raffleId: round.raffleId,
            action: 'error',
            message: `Entry rejected: ${swept.reason}`,
          },
        ])
        markProcessed()
        continue
      }

      const entrant: RaffleEntrant = {
        address: canonicalMonadEnvelopeAddress(envelope.from),
        txHash: swept.combinedTxHash,
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

      // Round is full -- draw, reveal, and pay out, then immediately rotate to a fresh round with
      // a brand new commitment (generated *before* it can have any entrants).
      const commitment = state.getPendingCommitment()
      if (!commitment || commitment.serverSeedHash !== round.serverSeedHash) {
        console.error(
          `[raffle-bot] internal error: no matching pending commitment for round ${round.raffleId} -- refusing to draw`,
        )
        continue
      }
      // Resolve journaled refunds BEFORE the seed-revealing DMs: (1) it settles confirmed ones so
      // their amounts are not double-counted below, and (2) every journaled refund tx is either in
      // the mempool or discarded, so the payout's pending nonce cannot collide with one. If a
      // journaled refund cannot be rebroadcast, refuse to draw now (nothing revealed yet).
      const settled = await retryPendingRefunds(refundDeps)
      if (settled.errored.length > 0) {
        throw new Error(
          `[raffle-bot] refusing to draw round ${
            round.raffleId
          }: refund(s) ${settled.errored.join(',')} could not be resolved`,
        )
      }
      const entrantAddresses = updatedEntrants.map(e => e.address)
      const entryTxHashes = updatedEntrants.map(e => e.txHash)
      const winnerIndex = pickWinnerIndex(
        commitment.serverSeed,
        combineEntrantEntropy(entryTxHashes),
        entrantAddresses.length,
      )
      const winnerAddress = entrantAddresses[winnerIndex]
      const potWei =
        BigInt(round.entryPriceWei) * BigInt(updatedEntrants.length)

      console.log(
        `[raffle-bot] drawing round ${round.raffleId}: winner=${winnerAddress} pot=${potWei} wei`,
      )

      for (const e of updatedEntrants) {
        const entrantKey = canonicalMonadEnvelopeAddress(e.address)
        let toPubKey = senderPubKeyCache.get(entrantKey)
        if (!toPubKey) {
          toPubKey = await fetchMonadIdentityPubKey({
            relayBaseUrl,
            address: e.address,
          })
          if (!toPubKey) continue
          senderPubKeyCache.set(entrantKey, toPubKey)
        }
        await sendDirectMessageItems({
          stampClient,
          pool,
          mainAccountSigner,
          provider,
          fromIdentity: identity,
          toAddress: e.address,
          toPubKey,
          items: [
            {
              type: 'raffle',
              raffleId: round.raffleId,
              action: 'draw',
              entryPriceWei: round.entryPriceWei,
              winnerAddress,
              serverSeed: commitment.serverSeed,
              entrants: entrantAddresses,
              entryTxHashes,
              potWei: potWei.toString(),
            },
          ],
          stampValueWei: replyStampValueWei,
          networkTag,
        })
      }

      // Fail closed (ticket #121 acceptance criteria): every entrant's payment was already swept
      // into this identity's balance before they were ever credited into `round.entrants` above,
      // so by the time a round can reach `maxEntries` its balance must already cover the pot on
      // its own. If it doesn't, something upstream is broken -- refuse the draw rather than
      // silently letting `ensureIdentityFunded` below paper over the gap with mainAccountSigner
      // funds (exactly the bug this file used to have).
      // `latest` still counts an unmined refund's wei, which the payout cannot spend; subtract
      // every refund not yet confirmed so the payout cannot fail mempool admission after the
      // seed was revealed.
      const identityBalanceWei = await provider.getBalance(
        identity.displayAddress,
      )
      if (drawSpendableWei(identityBalanceWei, state) < potWei) {
        throw new Error(
          `[raffle-bot] refusing to draw round ${round.raffleId}: identity balance ${identityBalanceWei} wei is below the ${potWei} wei pot it should already hold from this round's swept entries`,
        )
      }

      // See this file's header, "Why this bot can't be drained" -- this only ever tops up a flat
      // gas buffer *on top of* the pot already confirmed above, never the payout amount itself.
      const gasBufferWei = await computeGasBufferWei(provider)
      await ensureIdentityFunded({
        identityAddress: identity.displayAddress,
        mainAccountSigner,
        provider,
        neededWei: identityBalanceWei + gasBufferWei,
        label: 'raffle-bot',
      })

      console.log(
        `[raffle-bot] paying out ${potWei} wei to ${winnerAddress} ...`,
      )
      const payoutTx = await identitySigner.buildAndSignTransfer(
        winnerAddress,
        potWei,
      )
      const payoutTxHash = await identitySigner.submit(payoutTx)
      console.log(`[raffle-bot] payout tx sent: ${payoutTxHash}`)

      roundsDrawn++
      const nextRound = openFreshRound()
      console.log(
        `[raffle-bot] opened round ${nextRound.raffleId} (commitment ${nextRound.serverSeedHash})`,
      )
      if (roundsDrawn >= maxRounds) break
    }

    if (stored.length > 0) since = maxSeenTimestamp + 1
    await state.flush()
    await sleep(pollIntervalMs)
  }

  await state.Close()
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

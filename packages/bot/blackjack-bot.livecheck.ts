/**
 * A headless Frank client that deals provably-fair blackjack against real Monad testnet stakes --
 * the second bot built on `qwen-bot-common.ts`'s shared framework (identity, lazy stamp funding,
 * `sendDirectMessageText`), demonstrating that framework is genuinely game-agnostic, not
 * Qwen-specific. Run like `qwen-bot.livecheck.ts` (same `.livecheck.ts` convention: hits the real
 * network, excluded from `jest`, meant to be run manually via `tsx`).
 *
 * ## Fairness scheme
 *
 * See `@frank/wallet/message-item-plugins/blackjack/deck.ts`'s header for the full "why," and `blackjack-bot-state.ts`'s
 * header for why the pending commitment must be persisted. Short version: this bot always holds a
 * `serverSeed` it generated (and hashed) *before* any bet that might use it exists. A `bet`'s own
 * wager transaction hash becomes the shuffle's client-seed entropy the instant that bet is
 * verified. At `reveal`, the seed is published in plaintext so the player's own client can
 * independently replay the entire hand (`verifyRevealedHand`) and catch any deviation.
 *
 * ## Wager verification and payout
 *
 * A `bet` move item carries no self-reported amount -- `wagerTxHash` is resolved to a real,
 * confirmed transaction via `@frank/wallet/message-item-plugins`'s `hydrateMessageItems` (the
 * *exact* same verification code the frontend uses to render a bet trustworthily -- see that
 * registry's own header on why hydrate() is shared, isomorphic code). A bet below the configured
 * minimum, unconfirmed, or not actually paid to this bot's own address is rejected outright.
 * Payout on a win is a plain value transfer back to the player (same `buildAndSignTransfer`
 * primitive `qwen-bot.livecheck.ts` already uses to fund new signups) -- blackjack pays 3:2 (2.5x
 * total returned), an ordinary win pays 2x, a push returns the original wager, and a loss simply
 * leaves the wager with the bot (no separate escrow step needed at all).
 *
 * ## Rejections, refunds and bankroll
 *
 * A verified transfer (from the authenticated player, to this dealer) that the bot rejects -- bet
 * below/above the table limits, a bet or double refused for bankroll, an ineligible double -- is
 * refunded to the sender from the same payout account, once: the tx hash is claimed in the global
 * wager-claim keyspace (`claimRefund`) before anything is sent, so a replay can never refund it
 * twice and a refunded hash can never later back a game. A hash already claimed (e.g. the game's
 * own stake) is never refunded. Refunds that could not be signed (bankroll empty) stay `pending`
 * and are retried each poll; once a signed transfer may have been broadcast the record is
 * `submitting` and is never retried automatically. Bets/doubles are refused (and refunded) when
 * the payout account's balance cannot cover all open games' worst-case payouts plus the new one.
 *
 * A resolved hand's payout is durable (ticket #215): the game is marked revealed and the payout
 * recorded as `owed` in ONE write, then `owed -> submitting` (signed bytes journaled before the
 * broadcast) `-> submitted -> confirmed` (only a successful receipt clears it). A restart or the
 * poll loop re-broadcasts the same signed bytes -- never re-signs -- and no other payer-account
 * transaction is signed while a signed payout is unconfirmed (it owns the nonce). See
 * `attemptPayout`/`settlePayouts`. The welcome greeter signs from the payer account too (the
 * welcome stamp's funding transfer), so `runBlackjackLoop` runs it behind the same lane gate.
 *
 * ## Usage
 *
 *   cd packages/bot
 *   set -a; source ../../.env; set +a
 *   export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   yarn tsx blackjack-bot.livecheck.ts
 *
 * Env vars (mirroring qwen-bot.livecheck.ts's own naming where the concept is the same):
 *   BLACKJACK_BOT_IDENTITY_JSON     -- default /tmp/blackjack-bot-identity.json
 *   BLACKJACK_BOT_STATE_DIR         -- default ~/.frank-bots/blackjack (or $XDG_STATE_HOME/frank-bots/blackjack)
 *   BLACKJACK_BOT_MIN_WAGER_WEI     -- default 0.01 MON
 *   BLACKJACK_BOT_MAX_WAGER_WEI     -- default 1 MON (the client UI's documented default limits)
 *   BLACKJACK_BOT_MAX_HANDS         -- how many hands to resolve before exiting (default 1000)
 *   BLACKJACK_BOT_POLL_INTERVAL_MS  -- default 4000
 *   BLACKJACK_BOT_IDLE_TIMEOUT_MS   -- default 10 minutes
 *   BLACKJACK_BOT_MAX_GREETINGS     -- welcomes sent per run (default 5; 0 = never greet)
 *   BLACKJACK_BOT_MAX_GREETINGS_PER_DAY -- welcomes per UTC day across restarts (default 20)
 *   BLACKJACK_BOT_GREETING_MAX_AGE_MS   -- skip registrations older than this (default 24 h)
 *   BLACKJACK_BOT_PROFILE_SINCE_MS  -- first-run start of the registration watch (default: now)
 *
 * ## Welcome greeting (#395)
 *
 * The dealer greets each NEW registration once with a `blackjack-move` `welcome` item (table limits
 * from this bot's own config, fee hint, rules) plus a text line: see `blackjack-greeter.ts` for the
 * once-per-address record, the per-run/per-day caps (each greeting costs a stamp), the funds
 * check and the loop guard (never greets itself, the denylist or bot-marked profiles).
 */
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

import { computeAddress, JsonRpcProvider, Provider } from 'ethers'

import {
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import {
  fetchMonadIdentityPubKey,
  fetchMonadProfilesSince,
  MonadIdentity,
  mailboxAuthFor,
} from '@frank/wallet/monad-identity'
import __pb_registry_metadata_pb from '@frank/cashweb/registry/metadata_pb'
const { AddressMetadata } = __pb_registry_metadata_pb
import {
  createMonadChain,
  deserializeMessageItems,
  installCanonicalDirectory,
} from '@frank/wallet/chain/monad-chain'
import {
  BlackjackMoveItem,
  Message,
  MessageItem,
} from '@frank/cashweb/types/messages'
import {
  getMessageItemPlugin,
  MessageItemContext,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import '@frank/wallet/message-item-plugins/blackjack/plugin'
import { Card, deriveDeck, handValue, sha256Hex } from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  BLACKJACK_DEFAULT_MAX_WAGER_WEI,
  BlackjackOutcome,
  dealInitialCards,
  formatBlackjackError,
  HydratedBlackjackMove,
  playOutDealer,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import { MonadStampClient } from '@frank/wallet/monad-stamp-client'
import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import { MonadAccountTxSigner, MonadTxStatus } from '@frank/wallet/monad-account-tx'
import {
  loadOrCreateIdentity,
  loadQwenCanonicalRoots,
  openQwenCanonicalWallet,
  openQwenInstalledDirectory,
  qwenCanonicalChainConfig,
  readQwenApprovedBundle,
  readQwenBootstrapPolicy,
  registerAndLog,
  requiredEnv,
  sendDirectMessageItems,
  sendDirectMessageText,
  setUpFundedStampClient,
  startQwenInstallationServer,
} from './qwen-bot-common'
import {
  BlackjackCanonicalOutbox,
  BlackjackCanonicalStore,
  canonicalDirectoryFor,
  fetchCanonicalInbound,
  type CanonicalBlackjackInbound,
} from './blackjack-canonical'
import { botStateDir, persistentStateDir } from './bot-state-dir'
import { botLoopGuardFromEnv } from './bot-loop-guard'
import {
  BlackjackGreeter,
  BlackjackGreetingStore,
  GREETING_FEE_RESERVE_WEI,
  greeterConfigFromEnv,
  GreeterProfile,
  welcomeItems,
} from './blackjack-greeter'
import { formatMon } from '@frank/wallet/monad-amount'
import { botProfileFields } from './bot-directory'
import {
  BlackjackBotStateStore,
  BlackjackGameRecord,
  InvalidBlackjackGameIdError,
  normalizeBlackjackGameId,
  normalizePlayerAddress,
  normalizeWagerTxHash,
  PayoutRecord,
  PayoutStatus,
} from './blackjack-bot-state'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function generateServerSeed(): string {
  return randomBytes(32).toString('hex')
}

/** Blackjack's standard 3:2 payout on a natural, 1:1 (i.e. 2x total returned) on an ordinary win,
 * exactly the wager back on a push, nothing on a loss (the bot simply keeps the wager it already
 * received as part of the `bet` message's stamp/transfer -- no separate escrow to release). */
function payoutMultiplier(outcome: BlackjackOutcome): number {
  switch (outcome) {
    case 'player_blackjack':
      return 2.5
    case 'player_win':
      return 2
    case 'push':
      return 1
    case 'dealer_win':
      return 0
  }
}

/** Reconstructs the player's cards dealt so far during their own turn (before a 'stand'/'reveal'
 * has happened) -- valid only up to that point, since after standing the same trailing deck
 * indices belong to the dealer instead. See `@frank/wallet/message-item-plugins/blackjack/game.ts`'s "Dealing order
 * convention" for why indices 0/2 are always the player's initial two cards and every index from 4
 * onward is whichever hit/draw consumed it next, in order. */
function playerCardsSoFar(deck: Card[], dealtCount: number): Card[] {
  const initial = dealInitialCards(deck)
  return [...initial.playerCards, ...deck.slice(4, dealtCount)]
}

/** Legacy transport: every reply is sealed and paid inline through the legacy stamp client. */
export interface BlackjackLegacyTransport {
  senderPubKey: Buffer
  networkTag: string
  stampValueWei: bigint
  stampClient: MonadStampClient
  pool: MonadSubAccountPool
  canonical?: undefined
}

/**
 * Canonical transport (#780). The sender was authenticated by opening its sealed envelope under
 * the installed directory before any of this runs.
 *
 * The authenticated sender is an identity point; the wager is paid from that wallet's separate
 * EVM account, and nothing public binds the two. So the two roles the legacy record's single
 * `playerAddress` played are kept apart: `playerAddress` stays the verified wager sender (where a
 * payout or refund goes, exactly as before), and the actor binding saved here is who may act.
 */
export interface BlackjackCanonicalMove {
  /** Durably saves one reply to the authenticated sender; the outbox delivers it exactly once. */
  reply(items: MessageItem[]): Promise<void>
  actors: {
    actor(gameId: string): { actor: string; wagerTxHash: string } | undefined
    bindActor(
      gameId: string,
      binding: { actor: string; wagerTxHash: string },
    ): Promise<void>
  }
}
export interface BlackjackCanonicalTransport {
  canonical: BlackjackCanonicalMove
}
export type BlackjackTransport =
  | BlackjackLegacyTransport
  | BlackjackCanonicalTransport

/** The one place a dealer reply leaves through. Legacy calls are byte-for-byte what they were. */
function replier(
  params: BlackjackTransport & {
    identity: MonadIdentity
    mainAccountSigner: MonadAccountTxSigner
    provider: Provider
  },
): {
  items(toAddress: string, items: MessageItem[]): Promise<void>
  text(toAddress: string, text: string): Promise<void>
} {
  if (params.canonical) {
    const { canonical } = params
    return {
      items: (_to, items) => canonical.reply(items),
      text: (_to, text) => canonical.reply([{ type: 'text', text }]),
    }
  }
  const legacy = {
    stampClient: params.stampClient,
    pool: params.pool,
    mainAccountSigner: params.mainAccountSigner,
    provider: params.provider,
    fromIdentity: params.identity,
    toPubKey: params.senderPubKey,
    stampValueWei: params.stampValueWei,
    networkTag: params.networkTag,
  }
  return {
    async items(toAddress, items) {
      await sendDirectMessageItems({
        stampClient: legacy.stampClient,
        pool: legacy.pool,
        mainAccountSigner: legacy.mainAccountSigner,
        provider: legacy.provider,
        fromIdentity: legacy.fromIdentity,
        toAddress,
        toPubKey: legacy.toPubKey,
        items,
        stampValueWei: legacy.stampValueWei,
        networkTag: legacy.networkTag,
      })
    },
    async text(toAddress, text) {
      await sendDirectMessageText({
        stampClient: legacy.stampClient,
        pool: legacy.pool,
        mainAccountSigner: legacy.mainAccountSigner,
        provider: legacy.provider,
        fromIdentity: legacy.fromIdentity,
        toAddress,
        toPubKey: legacy.toPubKey,
        text,
        stampValueWei: legacy.stampValueWei,
        networkTag: legacy.networkTag,
      })
    },
  }
}

/** The transport fields alone, to hand the same transport on to `resolveAndReveal`. */
function transportOf(params: BlackjackTransport): BlackjackTransport {
  return params.canonical
    ? { canonical: params.canonical }
    : {
        senderPubKey: params.senderPubKey,
        networkTag: params.networkTag,
        stampValueWei: params.stampValueWei,
        stampClient: params.stampClient,
        pool: params.pool,
      }
}

export async function resolveAndReveal(
  params: {
    gameId: string
    record: BlackjackGameRecord
    identity: MonadIdentity
    mainAccountSigner: MonadAccountTxSigner
    provider: Provider
    state: BlackjackBotStateStore
  } & BlackjackTransport,
): Promise<void> {
  const { gameId, record, mainAccountSigner, state } = params
  const send = replier(params)
  if (record.authority !== 'verified-wager-sender') {
    throw new Error(
      'cannot resolve or pay a blackjack game without verified wager authority',
    )
  }
  const deck = deriveDeck(record.serverSeed, record.wagerTxHash, 0)
  const playerCards = playerCardsSoFar(deck, record.dealtCount)
  // A double-down puts a second, independently-verified transfer of the same size into the pot --
  // never just a client-side-doubled number (see `BlackjackGameRecord.doubleWagerWei`'s own
  // header) -- so the payout base is the sum of the two real transfers actually received, not
  // `wagerWei * 2`.
  const effectiveWagerWei =
    record.doubled && record.doubleWagerWei !== undefined
      ? record.wagerWei + record.doubleWagerWei
      : record.wagerWei

  // The dealing rules live in one shared function (also used by the client-side fairness check):
  // no draw on a player natural or bust, otherwise the dealer draws to 17.
  const { dealerCards, dealtCount, outcome } = playOutDealer(
    deck,
    playerCards,
    record.dealtCount,
  )

  const multiplier = payoutMultiplier(outcome)
  const payoutWei =
    multiplier > 0
      ? (BigInt(Math.round(multiplier * 1000)) * effectiveWagerWei) / 1000n
      : 0n

  // Resolving the hand and recording what it owes are ONE atomic write: there is no durable state
  // in which the game is revealed but its payout is not recorded. Nothing external happens before
  // this write is durable, so a failure or crash anywhere after it is recovered by `settlePayouts`.
  const resolved = await state.resolveGameWithPayout({
    gameId,
    dealtCount,
    payoutWei,
  })
  await state.flush()
  if (!resolved.ok) {
    // Already resolved (and its payout, if any, already journaled): never resolve twice.
    console.log(`[blackjack-bot] game ${gameId} was already resolved (${resolved.reason}); skipping`)
    return
  }

  console.log(
    `[blackjack-bot] resolving game ${gameId}: player=${JSON.stringify(playerCards)} dealer=${JSON.stringify(dealerCards)} outcome=${outcome}`,
  )

  // A failed reveal message must not cost the winner their payout: the payout is already owed and
  // is attempted (and, if need be, retried from the poll loop) regardless.
  try {
    await send.items(record.playerAddress, [
      {
        type: 'blackjack-move',
        gameId,
        action: 'reveal',
        dealerCards,
        serverSeed: record.serverSeed,
        outcome,
      },
    ])
  } catch (err) {
    console.error(
      `[blackjack-bot] reveal message for game ${gameId} failed (payout is still owed and will proceed):`,
      err,
    )
  }

  if (payoutWei > 0n) {
    console.log(
      `[blackjack-bot] paying out ${payoutWei} wei (${multiplier}x) to ${record.playerAddress} ...`,
    )
    await attemptPayout({ state, gameId, mainAccountSigner })
  } else {
    console.log('[blackjack-bot] dealer wins -- no payout, wager already received as the bet.')
  }
}

/** Per-game in-memory settle bookkeeping (never persisted; a restart starts fresh, so a `failed`
 * payout alerts again at every restart). `failures` counts genuine failures only. */
export interface PayoutTrack {
  failures: number
  /** Earliest time a build/broadcast may be retried after a genuine failure. */
  nextAt: number
  /** When a signed payout was first seen without a receipt (drives slow-tx re-broadcast). */
  pendingSince?: number
  lastAlertAt?: number
}
export type PayoutBackoff = Map<string, PayoutTrack>

const PAYOUT_BACKOFF_BASE_MS = 2000
const PAYOUT_BACKOFF_MAX_MS = 60000
/** A signed payout that has no receipt this long after we first looked is re-broadcast (same bytes). */
const PAYOUT_REBROADCAST_AFTER_MS = 30000
const PAYOUT_STUCK_AFTER_MS = 5 * 60 * 1000
const PAYOUT_ALERT_EVERY_MS = 10 * 60 * 1000

export type PayoutAttempt = PayoutStatus | 'none' | 'blocked' | 'error'

/**
 * Drives one owed payout forward, exactly once, and NEVER throws (the caller is the poll loop; a
 * payout problem must be retried, not crash the bot).
 *
 * `owed`       -> build + sign; journal `rawTx`/`txHash`/`nonce` durably (`submitting`) BEFORE
 *                 broadcasting.
 * `submitting` -> the signed bytes may already be in the mempool. Check the receipt; if none,
 *                 re-broadcast the SAME bytes. Never re-sign: a second signed transfer could mine
 *                 in addition to the first.
 * `submitted`  -> accepted by the node; wait for a receipt (the caller may allow re-broadcasting the
 *                 same bytes if it stays absent, which covers mempool eviction).
 * receipt ok   -> `confirmed` (the only way a payout stops being owed). A reverted receipt marks
 *                 it `failed` for an operator.
 *
 * Returns `'error'` only for a genuine failure (build/sign/submit/receipt-read threw); a payout that
 * is merely waiting (pending receipt, or `blocked` behind another) is not a failure.
 *
 * A signed payout that cannot be shown to have mined is left as-is and reported (fail closed):
 * re-signing is only sound if the transaction provably can never mine, and this bot has no proof
 * better than one RPC node's opinion, so that decision is an operator's (`requeue`).
 */
export async function attemptPayout(params: {
  state: BlackjackBotStateStore
  gameId: string
  mainAccountSigner: MonadAccountTxSigner
  /** May a signed payout without a receipt be re-broadcast now? Default true. */
  rebroadcast?: boolean
}): Promise<PayoutAttempt> {
  const { state, gameId, mainAccountSigner, rebroadcast = true } = params
  try {
    let payout = state.getPayout(gameId)
    const game = state.getGame(gameId)
    if (!payout || !game) return 'none'
    if (payout.status === 'confirmed' || payout.status === 'failed') {
      return payout.status
    }

    if (payout.status === 'owed') {
      // One signed payout in flight at a time: an unconfirmed signed transaction owns its payer
      // nonce, and anything signed from the chain's pending count meanwhile could take it.
      if (state.hasSignedUnconfirmedPayout()) return 'blocked'
      let signedTx
      try {
        signedTx = await mainAccountSigner.buildAndSignTransfer(
          game.playerAddress,
          payout.amountWei,
        )
      } catch (err) {
        console.error(
          `[blackjack-bot] payout of ${payout.amountWei} wei for game ${gameId} could not be built/signed (stays owed, will retry):`,
          err,
        )
        return 'error'
      }
      // Durable before anything is broadcast. If this write fails the signed bytes are simply
      // dropped: nothing left this process, so a later re-sign is safe.
      await state.setPayoutState(gameId, {
        status: 'submitting',
        rawTx: signedTx.rawTx,
        txHash: signedTx.txHash,
        nonce: signedTx.nonce,
      })
      await state.flush()
      payout = state.getPayout(gameId)!
    } else {
      // A signed transaction may already have mined (e.g. we crashed or lost the RPC response after
      // broadcasting). Only a successful receipt clears the debt.
      let status: MonadTxStatus
      try {
        status = await mainAccountSigner.getStatus(payout.txHash!)
      } catch (err) {
        console.error(`[blackjack-bot] could not read the receipt of payout ${payout.txHash}:`, err)
        return 'error'
      }
      if (status === 'confirmed') {
        await state.setPayoutState(gameId, { status: 'confirmed' })
        await state.flush()
        console.log(`[blackjack-bot] payout ${payout.txHash} for game ${gameId} confirmed`)
        return 'confirmed'
      }
      if (status === 'failed') {
        await state.setPayoutState(gameId, { status: 'failed' })
        await state.flush()
        console.error(
          `[blackjack-bot] OPERATOR ACTION: payout ${payout.txHash} for game ${gameId} mined but reverted; ${payout.amountWei} wei is still owed to ${game.playerAddress}`,
        )
        return 'failed'
      }
      // Receipt pending. A payout the node already accepted is simply slow, not failed.
      if (payout.status === 'submitted' && !rebroadcast) return 'submitted'
      if (payout.status === 'submitting' && !rebroadcast) return 'submitting'
    }

    // Broadcast exactly the journaled bytes.
    try {
      await mainAccountSigner.submitRaw(payout.rawTx!, payout.txHash!)
    } catch (err) {
      console.error(
        `[blackjack-bot] broadcast of payout ${payout.txHash} for game ${gameId} did not succeed (it may already be in the mempool). Retrying the SAME signed bytes, never re-signing; if this persists an operator must inspect the tx:`,
        err,
      )
      // An already-accepted tx failing to be re-offered is not a failure; a never-accepted one is.
      return payout.status === 'submitting' ? 'error' : payout.status
    }
    if (payout.status === 'submitting') {
      await state.setPayoutState(gameId, { status: 'submitted' })
      await state.flush()
    }
    console.log(`[blackjack-bot] payout tx sent: ${payout.txHash}`)
    return 'submitted'
  } catch (err) {
    console.error(`[blackjack-bot] payout attempt for game ${gameId} failed (will retry):`, err)
    return 'error'
  }
}

function payoutAlert(gameId: string, payout: PayoutRecord, now: number): string {
  return JSON.stringify({
    gameId,
    status: payout.status,
    ageMs: now - payout.owedAt,
    amountWei: payout.amountWei.toString(),
    nonce: payout.nonce ?? null,
    txHash: payout.txHash ?? null,
    action:
      payout.status === 'failed'
        ? 'OPERATOR ACTION: check the reverted receipt on an explorer, then `blackjack-payout-admin requeue <gameId> --i-verified-reverted`'
        : payout.status === 'owed'
          ? 'unpaid and being retried (build/sign failing?); check the payer balance and RPC'
          : 'signed and unconfirmed; the payer account is held. If its nonce was consumed by another tx: `blackjack-payout-admin requeue <gameId> --nonce-consumed-by <txHash>`',
  })
}

/** Poll-loop entry: advances every open payout. Never throws.
 *
 * - A signed payout's receipt is checked on EVERY call (that is what releases the payer lane);
 *   only genuine failures (build/sign/submit/receipt-read throwing) back off, and a payout that is
 *   merely waiting (pending receipt, blocked behind another) never does.
 * - An `owed` payout whose build keeps throwing is retried forever (backoff capped at 60s); it
 *   alerts but never changes state.
 * - Emits a structured, rate-limited `PAYOUT STUCK` line for any payout not confirmed after a
 *   threshold, and for every `failed` payout (again at each restart). */
export async function settlePayouts(params: {
  state: BlackjackBotStateStore
  mainAccountSigner: MonadAccountTxSigner
  now?: number
  backoff?: PayoutBackoff
  stuckAfterMs?: number
  alertEveryMs?: number
}): Promise<void> {
  const { state, mainAccountSigner } = params
  const now = params.now ?? Date.now()
  const backoff = params.backoff ?? new Map()
  const stuckAfterMs = params.stuckAfterMs ?? PAYOUT_STUCK_AFTER_MS
  const alertEveryMs = params.alertEveryMs ?? PAYOUT_ALERT_EVERY_MS
  try {
    // Signed ones first so an in-flight transaction resolves before another is signed.
    const open = state
      .getOpenPayouts()
      .sort(([, a], [, b]) => Number(a.status === 'owed') - Number(b.status === 'owed'))
    for (const [gameId, payout] of open) {
      const track: PayoutTrack = backoff.get(gameId) ?? { failures: 0, nextAt: 0 }
      backoff.set(gameId, track)
      const inBackoff = now < track.nextAt
      const signed = payout.status !== 'owed'
      if (!signed && inBackoff) continue
      if (signed) track.pendingSince ??= now
      const rebroadcast =
        !inBackoff &&
        (payout.status === 'submitting' ||
          now - (track.pendingSince ?? now) >= PAYOUT_REBROADCAST_AFTER_MS)
      const result = await attemptPayout({ state, gameId, mainAccountSigner, rebroadcast })
      const after = state.getPayout(gameId)
      if (result === 'error') {
        track.failures += 1
        track.nextAt =
          now + Math.min(PAYOUT_BACKOFF_MAX_MS, PAYOUT_BACKOFF_BASE_MS * 2 ** (track.failures - 1))
      } else if (after && after.status !== payout.status) {
        track.failures = 0
        track.nextAt = 0
        track.pendingSince = undefined
        if (after.status === 'submitted') track.pendingSince = now
      }
      if (result === 'submitted' && payout.status === 'submitted' && rebroadcast) {
        track.pendingSince = now // re-offered just now; wait another interval before the next one
      }
      if (result === 'confirmed') backoff.delete(gameId)
    }
    for (const [gameId, payout] of state.getUnconfirmedPayouts()) {
      const track: PayoutTrack = backoff.get(gameId) ?? { failures: 0, nextAt: 0 }
      backoff.set(gameId, track)
      const needsOperator = payout.status === 'failed'
      if (!needsOperator && now - payout.owedAt < stuckAfterMs) continue
      if (track.lastAlertAt !== undefined && now - track.lastAlertAt < alertEveryMs) continue
      track.lastAlertAt = now
      console.error(`[blackjack-bot] PAYOUT STUCK ${payoutAlert(gameId, payout, now)}`)
    }
  } catch (err) {
    console.error('[blackjack-bot] settling payouts failed (will retry):', err)
  }
}

/** Attempts (at most once per broadcast) the refund recorded by `state.claimRefund`. `pending`
 * means nothing was ever broadcast, so a failed signing/balance error stays retryable; once a
 * signed transfer might have reached the network the record moves to `submitting` and is never
 * retried automatically, so a replay or retry can never refund twice. */
export async function attemptRefund(params: {
  state: BlackjackBotStateStore
  txHash: string
  mainAccountSigner: MonadAccountTxSigner
}): Promise<'sent' | 'pending' | 'submitting' | 'none'> {
  const { state, txHash, mainAccountSigner } = params
  const refund = state.getRefund(txHash)
  if (!refund) return 'none'
  if (refund.status !== 'pending') return refund.status
  // A signed, unconfirmed payout owns its payer nonce; do not sign anything beside it.
  if (state.hasSignedUnconfirmedPayout()) return 'pending'
  let signedTx
  try {
    signedTx = await mainAccountSigner.buildAndSignTransfer(
      refund.playerAddress,
      refund.amountWei,
    )
  } catch (err) {
    console.error(
      `[blackjack-bot] refund of ${refund.amountWei} wei for ${txHash} left pending (could not sign/fund):`,
      err,
    )
    return 'pending'
  }
  await state.setRefundStatus(txHash, 'submitting')
  try {
    const refundTxHash = await mainAccountSigner.submit(signedTx)
    await state.setRefundStatus(txHash, 'sent', refundTxHash)
    console.log(`[blackjack-bot] refunded ${refund.amountWei} wei for ${txHash}: ${refundTxHash}`)
    return 'sent'
  } catch (err) {
    console.error(
      `[blackjack-bot] refund for ${txHash} may or may not have been broadcast; NOT retrying automatically (needs manual review):`,
      err,
    )
    return 'submitting'
  }
}

/** Retries refunds that never reached the point of broadcasting (e.g. bankroll was empty). */
export async function retryPendingRefunds(
  state: BlackjackBotStateStore,
  mainAccountSigner: MonadAccountTxSigner,
): Promise<void> {
  for (const [txHash] of state.getPendingRefunds()) {
    await attemptRefund({ state, txHash, mainAccountSigner })
  }
}

/** Fail-closed bankroll check: the payout account must cover every unresolved game's worst-case
 * payout plus this one's. */
async function canCoverWorstCase(params: {
  provider: Provider
  mainAccountSigner: MonadAccountTxSigner
  state: BlackjackBotStateStore
  worstCaseWei: bigint
  excludeGameId?: string
}): Promise<boolean> {
  try {
    const balance = await params.provider.getBalance(
      params.mainAccountSigner.address,
    )
    return (
      balance >=
      params.state.openExposureWei(params.excludeGameId) + params.worstCaseWei
    )
  } catch (err) {
    console.error('[blackjack-bot] could not read the dealer balance; refusing:', err)
    return false
  }
}

export async function handleMove(
  params: {
    action: BlackjackMoveItem['action']
    hydrated: HydratedBlackjackMove
    /** The authenticated sender: the legacy envelope's verified `from`, or in canonical mode the
     * identity address of the directory-admitted subject the sealed envelope opened under. */
    senderAddress: string
    minWagerWei: bigint
    maxWagerWei?: bigint
    state: BlackjackBotStateStore
    identity: MonadIdentity
    mainAccountSigner: MonadAccountTxSigner
    provider: Provider
  } & BlackjackTransport,
): Promise<void> {
  const {
    action,
    hydrated,
    senderAddress,
    minWagerWei,
    maxWagerWei = BLACKJACK_DEFAULT_MAX_WAGER_WEI,
    state,
    identity,
    mainAccountSigner,
    provider,
    canonical,
  } = params
  const send = replier(params)
  const transport = transportOf(params)
  let gameId: string
  try {
    gameId = normalizeBlackjackGameId(
      (hydrated as unknown as { gameId: unknown }).gameId,
    )
  } catch {
    console.log(`[blackjack-bot] rejecting ${action}: invalid gameId`)
    await send.text(
      senderAddress,
      'Blackjack: gameId must be a nonempty bounded string',
    )
    return
  }

  async function sendError(text: string) {
    console.log(`[blackjack-bot] rejecting ${action} for game ${gameId}: ${text}`)
    await send.text(senderAddress, formatBlackjackError(gameId, text))
  }

  let authenticatedPlayerAddress: string
  let dealerAddress: string
  try {
    authenticatedPlayerAddress = normalizePlayerAddress(senderAddress)
    dealerAddress = normalizePlayerAddress(identity.displayAddress)
  } catch {
    await sendError('message carried an invalid Monad address')
    return
  }

  /** Refunds a verified transfer (sender == authenticated player, recipient == this dealer) that
   * we are about to reject, claimed by hash so it can happen at most once. Never refunds a hash
   * that is already claimed (e.g. this game's own stake). Returns text to append to the error.
   *
   * The refund always goes back to the address the transfer came from. In legacy mode that is
   * required to be the authenticated player. In canonical mode the authenticated subject is not
   * a paying account, so the transfer's own verified sender is the only place it can return to. */
  async function refundRejected(
    txHash: string | undefined,
    transfer: HydratedBlackjackMove['verifiedWager'],
  ): Promise<string> {
    if (!txHash || !transfer) return ''
    let hash: string
    let refundAddress: string
    try {
      hash = normalizeWagerTxHash(txHash)
      refundAddress = normalizePlayerAddress(transfer.fromAddress)
      if (
        (!canonical && refundAddress !== authenticatedPlayerAddress) ||
        normalizePlayerAddress(transfer.toAddress) !== dealerAddress ||
        transfer.valueWei <= 0n
      ) {
        return ''
      }
    } catch {
      return ''
    }
    const claim = await state.claimRefund({
      txHash: hash,
      playerAddress: refundAddress,
      amountWei: transfer.valueWei,
    })
    if (!claim.ok) return ''
    const status = await attemptRefund({ state, txHash: hash, mainAccountSigner })
    return status === 'sent'
      ? ' Your transfer has been refunded.'
      : ' Your transfer is queued for refund.'
  }

  if (action === 'bet') {
    const wager = hydrated.verifiedWager
    if (!wager) {
      await sendError(
        'could not verify your wager transaction on-chain (unconfirmed, or the hash was wrong)',
      )
      return
    }
    let wagerSenderAddress: string
    let wagerRecipientAddress: string
    let wagerTxHash: string
    try {
      wagerSenderAddress = normalizePlayerAddress(wager.fromAddress)
      wagerRecipientAddress = normalizePlayerAddress(wager.toAddress)
      wagerTxHash = normalizeWagerTxHash(hydrated.wagerTxHash ?? '')
    } catch {
      await sendError(
        'wager transaction carried an invalid hash or Monad address',
      )
      return
    }
    // Canonical mode cannot make this comparison: the authenticated subject never sends
    // transactions (see `BlackjackCanonicalMove`). The payout still goes only to the verified
    // wager sender, so claiming someone else's transfer can never pay the claimant.
    if (!canonical && wagerSenderAddress !== authenticatedPlayerAddress) {
      await sendError(
        'your authenticated identity did not send this wager transaction',
      )
      return
    }
    if (wagerRecipientAddress !== dealerAddress) {
      await sendError('your wager transaction did not pay this dealer')
      return
    }
    // From here the transfer is a real payment to us: any rejection must refund it.
    async function rejectBet(text: string) {
      await sendError(text + (await refundRejected(wagerTxHash, wager)))
    }
    if (state.getGame(gameId)) {
      await rejectBet('this gameId already has a hand in progress')
      return
    }
    if (wager.valueWei < minWagerWei) {
      await rejectBet(
        `wager ${formatMon(wager.valueWei)} is below the table minimum of ${formatMon(minWagerWei)}`,
      )
      return
    }
    if (wager.valueWei > maxWagerWei) {
      await rejectBet(
        `wager ${formatMon(wager.valueWei)} is above the table maximum of ${formatMon(maxWagerWei)}`,
      )
      return
    }
    if (
      !(await canCoverWorstCase({
        provider,
        mainAccountSigner,
        state,
        worstCaseWei: (2500n * wager.valueWei) / 1000n,
      }))
    ) {
      await rejectBet('the dealer bankroll cannot cover this bet right now')
      return
    }
    const commitment = state.getPendingCommitment()
    if (!commitment) {
      await rejectBet('dealer has no pending seed commitment ready -- try again shortly')
      return
    }
    // Prepare a fresh commitment for the *next* hand. The state store atomically installs it with
    // this wager's global claim and game authority, so neither a crash nor a concurrent bet can
    // consume only part of the transition.
    const nextServerSeed = generateServerSeed()
    const deck = deriveDeck(commitment.serverSeed, wagerTxHash, 0)
    const { playerCards, dealerCards } = dealInitialCards(deck)
    const record: BlackjackGameRecord = {
      authority: 'verified-wager-sender',
      serverSeed: commitment.serverSeed,
      serverSeedHash: commitment.serverSeedHash,
      wagerTxHash,
      wagerWei: wager.valueWei,
      playerAddress: wagerSenderAddress,
      dealtCount: 4,
      revealed: false,
      doubled: false,
      doubleWagerWei: undefined,
    }
    if (canonical) {
      // Saved before the game exists, and only while it does not: a binding can never be moved
      // onto an existing game (that path returned above), and it names the one wager it is for.
      await canonical.actors.bindActor(gameId, {
        actor: authenticatedPlayerAddress,
        wagerTxHash,
      })
    }
    const claim = await state.claimWagerAndCreateGame({
      gameId,
      wagerTxHash,
      record,
      expectedCommitment: commitment,
      nextCommitment: {
        serverSeed: nextServerSeed,
        serverSeedHash: sha256Hex(nextServerSeed),
      },
    })
    if (!claim.ok) {
      if (claim.reason === 'game_exists') {
        await rejectBet('this gameId already has a hand in progress')
      } else if (claim.reason === 'wager_claimed') {
        // Already backing a game (or already refunded): never refund it again.
        await sendError(
          'this wager transaction has already authorized a blackjack game',
        )
      } else {
        await rejectBet(
          'dealer commitment changed while accepting the wager -- try again',
        )
      }
      return
    }

    await send.items(record.playerAddress, [
        {
          type: 'blackjack-move',
          gameId,
          action: 'deal',
          serverSeedHash: commitment.serverSeedHash,
          playerCards,
          dealerUpCard: dealerCards[0],
        },
      ])

    if (handValue(playerCards).blackjack) {
      await resolveAndReveal({
        gameId,
        record,
        identity,
        mainAccountSigner,
        provider,
        state,
        ...transport,
      })
    }
    return
  }

  if (action === 'deal' || action === 'reveal' || action === 'welcome') {
    await sendError(`${action} is a dealer-only action`)
    return
  }

  // A `double` carries a second real transfer. Every rejection of it below refunds that transfer
  // (once, claim-guarded) unless it is already claimed -- notably this game's own original stake.
  async function rejectDouble(text: string) {
    await sendError(
      text +
        (await refundRejected(
          hydrated.doubleWagerTxHash,
          hydrated.verifiedDoubleWager,
        )),
    )
  }
  const rejectMove = action === 'double' ? rejectDouble : sendError

  const record = state.getGame(gameId)
  if (
    !record ||
    record.revealed ||
    record.authority !== 'verified-wager-sender'
  ) {
    await rejectMove('no in-progress hand found for this gameId')
    return
  }
  // Legacy: the payer is the authenticated player. Canonical: the subject bound at the bet, and
  // only for the wager this record was created from.
  const binding = canonical?.actors.actor(gameId)
  const mayAct = canonical
    ? binding !== undefined &&
      binding.actor === authenticatedPlayerAddress &&
      binding.wagerTxHash === record.wagerTxHash
    : record.playerAddress === authenticatedPlayerAddress
  if (!mayAct) {
    await rejectMove(
      'only the player who funded this wager can act on this game',
    )
    return
  }

  if (action === 'hit') {
    // A doubled hand gets exactly one card and can only resolve.
    if (record.doubled) {
      await sendError('this hand has been doubled and can only be resolved')
      return
    }
    const deck = deriveDeck(record.serverSeed, record.wagerTxHash, 0)
    const newDealtCount = record.dealtCount + 1
    const playerCards = playerCardsSoFar(deck, newDealtCount)
    await state.setGame(gameId, { ...record, dealtCount: newDealtCount })

    await send.items(record.playerAddress, [{ type: 'blackjack-move', gameId, action: 'hit', playerCards }])

    if (handValue(playerCards).bust) {
      await resolveAndReveal({
        gameId,
        record: { ...record, dealtCount: newDealtCount },
        identity,
        mainAccountSigner,
        provider,
        state,
        ...transport,
      })
    }
    return
  }

  if (action === 'double') {
    const doubleWager = hydrated.verifiedDoubleWager
    if (!doubleWager) {
      await sendError(
        'could not verify your double-down wager transaction on-chain (unconfirmed, or the hash was wrong)',
      )
      return
    }
    let doubleWagerSenderAddress: string
    let doubleWagerRecipientAddress: string
    let doubleWagerTxHash: string
    try {
      doubleWagerSenderAddress = normalizePlayerAddress(doubleWager.fromAddress)
      doubleWagerRecipientAddress = normalizePlayerAddress(doubleWager.toAddress)
      doubleWagerTxHash = normalizeWagerTxHash(hydrated.doubleWagerTxHash ?? '')
    } catch {
      await sendError(
        'double-down wager transaction carried an invalid hash or Monad address',
      )
      return
    }
    // The second transfer must come from the same paying account as the first. In legacy mode
    // that account is the authenticated player (already equal to `record.playerAddress`).
    if (
      doubleWagerSenderAddress !==
      (canonical ? record.playerAddress : authenticatedPlayerAddress)
    ) {
      await sendError(
        'your authenticated identity did not send this double-down wager transaction',
      )
      return
    }
    if (doubleWagerRecipientAddress !== dealerAddress) {
      await sendError('your double-down wager transaction did not pay this dealer')
      return
    }
    // The double transfer must be a NEW transfer: the game's own original wager can never double
    // as its own double-down stake (it is also claimed, so no refund is issued for it).
    if (doubleWagerTxHash === record.wagerTxHash) {
      await rejectDouble(
        'your double-down must be a new transfer, not the original wager transaction',
      )
      return
    }
    if (record.doubled) {
      await rejectDouble('this hand has already been doubled')
      return
    }
    // `record.dealtCount` only reads 4 (2 player + 2 dealer, per the dealing-order convention)
    // before any `hit` has consumed a card -- exactly "the untouched two-card hand," the same
    // eligibility window `reduceBlackjackState`'s `'double'` case enforces client-side.
    if (record.dealtCount !== 4) {
      await rejectDouble(
        'double down is only allowed immediately after the deal, before any hit',
      )
      return
    }
    // Doubling means exactly doubling -- the second transfer must match the original wager
    // exactly, not merely meet the table minimum, so the payout math's `wagerWei + doubleWagerWei`
    // is always precisely 2x what the player actually put at risk.
    if (doubleWager.valueWei !== record.wagerWei) {
      await rejectDouble(
        `double-down wager must match your original wager exactly (${formatMon(record.wagerWei)})`,
      )
      return
    }
    if (
      !(await canCoverWorstCase({
        provider,
        mainAccountSigner,
        state,
        worstCaseWei: 2n * (record.wagerWei + doubleWager.valueWei),
        excludeGameId: gameId,
      }))
    ) {
      await rejectDouble('the dealer bankroll cannot cover this double-down right now')
      return
    }

    const deck = deriveDeck(record.serverSeed, record.wagerTxHash, 0)
    const newDealtCount = record.dealtCount + 1
    const playerCards = playerCardsSoFar(deck, newDealtCount)
    const updatedRecord: BlackjackGameRecord = {
      ...record,
      dealtCount: newDealtCount,
      doubled: true,
      doubleWagerWei: doubleWager.valueWei,
    }
    // Claims the double transfer hash (same global keyspace as wager hashes) atomically with
    // marking the hand doubled.
    const claim = await state.claimDoubleWagerAndUpdateGame({
      gameId,
      doubleWagerTxHash,
      record: updatedRecord,
    })
    if (!claim.ok) {
      if (claim.reason === 'wager_claimed') {
        await sendError(
          'this transaction has already been used as a stake and cannot be used again',
        )
      } else {
        await rejectDouble('this hand can no longer be doubled')
      }
      return
    }

    await send.items(record.playerAddress, [{ type: 'blackjack-move', gameId, action: 'double', playerCards }])

    // Doubling is always exactly one more card then an automatic stand -- win, lose, or bust, the
    // hand is over, unlike an ordinary `hit` which only forces a reveal on a bust.
    await resolveAndReveal({
      gameId,
      record: updatedRecord,
      identity,
      mainAccountSigner,
      provider,
      state,
      ...transport,
    })
    return
  }

  if (action === 'stand') {
    // Standing on a doubled record (only reachable if the process died between accepting the
    // double and revealing) resolves it on the combined stake -- the only thing a doubled hand can
    // do besides being rejected here for `hit`.
    await resolveAndReveal({
      gameId,
      record,
      identity,
      mainAccountSigner,
      provider,
      state,
      ...transport,
    })
    return
  }
}

/** Validates the untrusted wire gameId before hydrate() can perform wager RPC lookups. */
export async function hydrateMoveWithValidatedGameId(
  raw: BlackjackMoveItem,
  hydrate: (validated: BlackjackMoveItem) => Promise<HydratedBlackjackMove>,
): Promise<HydratedBlackjackMove> {
  const gameId = normalizeBlackjackGameId(
    (raw as unknown as { gameId: unknown }).gameId,
  )
  const hydrated = await hydrate({ ...raw, gameId })
  return { ...hydrated, gameId }
}

export type StoredRelayMessage = Awaited<ReturnType<typeof fetchMonadMessagesSince>>[number]

/** What the poll loop itself reads of an inbox message: its relay time and its payload digest. */
export interface BlackjackLoopMessage {
  timestamp: number
  message?: { payloadHash: Uint8Array }
}

export interface BlackjackLoopDeps<
  M extends BlackjackLoopMessage = StoredRelayMessage,
> {
  state: BlackjackBotStateStore
  mainAccountSigner: MonadAccountTxSigner
  pollIntervalMs: number
  maxHands: number
  idleTimeoutMs: number
  fetchMessages: (sinceMs: number) => Promise<M[]>
  /** Decrypts/hydrates/handles one not-yet-processed message. Returns what it acted on, or
   * `undefined` when the message was not a blackjack move for this bot. */
  processMessage: (message: M) => Promise<{ action: string; gameId: string } | undefined>
  /** Canonical mode's saved-reply delivery (and welcome). It pays stamps from the typed wallet's
   * own account, never the payout account, so it runs every poll, payout lane held or not.
   * Returns how many replies were delivered. Must not throw. */
  tick?: () => Promise<number>
  /** The welcome greeter's poll (main's greeting flow, #395). Its sends sign from the payer
   * account, so it is invoked only while the payout lane is free -- never while a signed payout
   * is submitting/submitted (a greeting funding tx could otherwise steal the payout's nonce).
   * Returns how many greetings were sent. */
  greet?: () => Promise<number>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long, after the loop ends, to keep settling payouts before reporting them unsettled. */
  drainTimeoutMs?: number
}

/** The bot's poll loop, extracted from `main()` so its payout hold, idle exit, durable cursor and
 * exit status are testable with fakes. */
export async function runBlackjackLoop<
  M extends BlackjackLoopMessage = StoredRelayMessage,
>(
  deps: BlackjackLoopDeps<M>,
): Promise<{ handsResolved: number; unsettled: string[]; exitCode: number }> {
  const { state, mainAccountSigner, pollIntervalMs, maxHands, idleTimeoutMs } = deps
  const now = deps.now ?? Date.now
  const pause = deps.sleep ?? sleep
  const payoutBackoff: PayoutBackoff = new Map()

  // Resume from the durable cursor. Only a brand-new database starts "now" (as before), and that
  // start is persisted at once so a restart before any message never skips ahead of it.
  let since: number = state.getSince() ?? now()
  if (state.getSince() === undefined) await state.setSince(since)
  let handsResolved = 0
  let lastActivityAt = now()

  while (handsResolved < maxHands) {
    // A payout that is still being driven is activity, not idleness: never idle-exit with one open.
    if (state.getOpenPayouts().length > 0) lastActivityAt = now()
    if (now() - lastActivityAt > idleTimeoutMs) {
      console.log(`\nNo activity within ${idleTimeoutMs}ms -- exiting.`)
      break
    }

    // Owed payouts first (restart recovery included): re-broadcast/confirm before anything else
    // may sign on the payer account. Never throws.
    await settlePayouts({ state, mainAccountSigner, backoff: payoutBackoff, now: now() })
    await retryPendingRefunds(state, mainAccountSigner)
    if (deps.tick && (await deps.tick()) > 0) lastActivityAt = now()
    // While a signed payout is unconfirmed the payer account is reserved for it (its nonce). Do not
    // consume or advance past any message until it clears; the messages are picked up next poll.
    if (state.hasSignedUnconfirmedPayout()) {
      await state.flush()
      await pause(pollIntervalMs)
      continue
    }
    // The greeter signs from the payer account too (the welcome stamp's funding transfer), so it
    // sits behind the same lane gate: a held payout's nonce can never be stolen by a greeting.
    if (deps.greet && (await deps.greet()) > 0) lastActivityAt = now()

    const stored = await deps.fetchMessages(since)
    let maxSeenTimestamp: number = since - 1

    let complete = true
    for (const message of stored) {
      if (state.hasSignedUnconfirmedPayout()) {
        complete = false
        break
      }
      maxSeenTimestamp = Math.max(maxSeenTimestamp, message.timestamp)
      if (!message.message) continue

      const payloadHashHex = Buffer.from(message.message.payloadHash).toString('hex')
      if (state.hasProcessed(payloadHashHex)) continue
      // At-most-once handling: the marker is made DURABLE before the message is handled. If handling
      // then throws or the process dies, the message is skipped on restart (exactly as on main) and
      // never re-run; a per-message failure is logged (structured) instead of crashing the loop.
      state.addProcessed(payloadHashHex)
      await state.flush()

      let acted: { action: string; gameId: string } | undefined
      try {
        acted = await deps.processMessage(message)
      } catch (err) {
        console.error(
          `[blackjack-bot] MESSAGE FAILED ${JSON.stringify({ payloadHash: payloadHashHex, timestamp: message.timestamp, error: String((err as Error)?.message ?? err) })} (marked processed; it will NOT be retried)`,
        )
        continue
      }
      if (!acted) continue
      lastActivityAt = now()
      if (acted.action === 'reveal' || (state.getGame(acted.gameId)?.revealed ?? false)) {
        handsResolved++
      }
      if (handsResolved >= maxHands) {
        complete = false
        break
      }
    }

    await state.flush()
    // The cursor only moves past messages that were all handled (or marked processed): never past
    // ones a payout hold or the hand limit left unread.
    if (stored.length > 0 && complete) {
      since = maxSeenTimestamp + 1
      await state.setSince(since)
    }
    await state.flush()
    await pause(pollIntervalMs)
  }

  // Give a payout submitted by the last hand a chance to confirm before judging the run.
  const drainDeadline = now() + (deps.drainTimeoutMs ?? 60000)
  while (state.getOpenPayouts().length > 0 && now() < drainDeadline) {
    await settlePayouts({ state, mainAccountSigner, backoff: payoutBackoff, now: now() })
    if (state.getOpenPayouts().length === 0) break
    await pause(pollIntervalMs)
  }
  await state.flush()

  const unsettled = state
    .getUnconfirmedPayouts()
    .map(([gameId, p]) => `${gameId}:${p.status}`)
  if (unsettled.length > 0) {
    console.error(
      `[blackjack-bot] EXITING WITH UNSETTLED PAYOUTS ${JSON.stringify(
        state.getUnconfirmedPayouts().map(([gameId, p]) => ({
          gameId,
          status: p.status,
          amountWei: p.amountWei.toString(),
          nonce: p.nonce ?? null,
          txHash: p.txHash ?? null,
        })),
      )} -- restart the bot (or use blackjack-payout-admin) to settle them`,
    )
  }
  return { handsResolved, unsettled, exitCode: unsettled.length > 0 ? 1 : 0 }
}

/**
 * One authenticated canonical inbox message -> at most one dealer action. `message` came out of
 * the wallet's canonical `fetchSince`, so its envelope already opened under the installed
 * directory's admitted entries for sender and recipient; a tampered envelope or an uninstalled
 * sender never reaches this function. Replies are saved to the outbox under keys derived from
 * the inbound payload digest, then delivered.
 */
export async function processCanonicalMessage(params: {
  message: CanonicalBlackjackInbound
  identity: MonadIdentity
  /** Chain reads for wager lookups (the wallet's own provider, through the home relay). */
  wagerProvider: Provider
  store: BlackjackCanonicalStore
  outbox: Pick<BlackjackCanonicalOutbox, 'enqueue' | 'drive'>
  blockReason?: (address: string) => string | undefined
  minWagerWei: bigint
  maxWagerWei: bigint
  state: BlackjackBotStateStore
  mainAccountSigner: MonadAccountTxSigner
  provider: Provider
}): Promise<{ action: string; gameId: string } | undefined> {
  const { received } = params.message
  const sender = received.senderAddress.raw.toLowerCase()
  if (sender === params.identity.displayAddress.toLowerCase()) return undefined
  const blocked = params.blockReason?.(sender)
  if (blocked) {
    console.log(`[blackjack-bot] ignoring message from ${sender} (${blocked})`)
    return undefined
  }
  const moveRaw = received.items.find(
    (item): item is BlackjackMoveItem => item.type === 'blackjack-move',
  )
  if (!moveRaw) return undefined

  let replies = 0
  const canonical: BlackjackCanonicalMove = {
    async reply(items) {
      await params.outbox.enqueue(
        `${received.payloadDigest}:${replies++}`,
        sender,
        items,
      )
    },
    actors: params.store,
  }
  const plugin = getMessageItemPlugin('blackjack-move')
  if (!plugin) throw new Error('blackjack-move plugin not registered')
  const context: MessageItemContext = {
    message: { senderAddress: sender } as unknown as Message,
    index: received.items.indexOf(moveRaw),
    provider: params.wagerProvider,
  }
  try {
    let hydrated: HydratedBlackjackMove
    try {
      hydrated = await hydrateMoveWithValidatedGameId(moveRaw, validated =>
        plugin.hydrate(validated, context),
      )
    } catch (error) {
      if (!(error instanceof InvalidBlackjackGameIdError)) throw error
      console.log(
        `[blackjack-bot] rejecting ${moveRaw.action} from ${sender}: invalid gameId`,
      )
      await canonical.reply([
        {
          type: 'text',
          text: 'Blackjack: gameId must be a nonempty bounded string',
        },
      ])
      return undefined
    }
    console.log(
      `\n[blackjack-bot] ${moveRaw.action} from ${sender} (game ${hydrated.gameId})`,
    )
    try {
      await handleMove({
        action: moveRaw.action,
        hydrated,
        senderAddress: sender,
        minWagerWei: params.minWagerWei,
        maxWagerWei: params.maxWagerWei,
        state: params.state,
        identity: params.identity,
        mainAccountSigner: params.mainAccountSigner,
        provider: params.provider,
        canonical,
      })
    } catch (err) {
      console.error(
        `[blackjack-bot] failed to handle ${moveRaw.action} for game ${hydrated.gameId}:`,
        err,
      )
    }
    return { action: moveRaw.action, gameId: hydrated.gameId }
  } finally {
    // Whatever was saved is delivered now rather than a poll interval later.
    await params.outbox.drive()
  }
}

let closeCanonical: Array<() => Promise<void>> = []

/** A configuration the canonical dealer will not start with; `code` is a fixed public word. */
class BlackjackStartRefusal extends Error {
  constructor(readonly code: string) {
    super(`Blackjack bot refusing to start: ${code}`)
    this.name = 'BlackjackStartRefusal'
  }
}

/**
 * Canonical mode (#780), selected by BLACKJACK_BOT_CANONICAL_ROOTS_JSON. Fixed order:
 *  1. public configuration is read and checked; the export-only path ends here;
 *  2. game state and the reply outbox open;
 *  3. the typed wallet owner opens (signs, funds, replays and sends nothing);
 *  4. the installed directory opens (own attestation published, peers read lazily) and is
 *     installed into the wallet's canonical message client;
 *  5. every payment set the wallet retains must be one the outbox accounts for;
 *  6. only then does the ordinary dealer loop run.
 *
 * The installed directory, export, attestation and status endpoint are the Qwen bot's own
 * helpers (`qwen-bot-common.ts`), used as they are. Payouts and refunds keep their legacy
 * journal and payer: a separate operator-funded bankroll key, here signing through the typed
 * wallet's relay RPC. The typed wallet's own account pays only reply stamps.
 */
async function mainCanonical(): Promise<void> {
  const path = (name: string) => resolve(process.cwd(), requiredEnv(name))
  const roots = loadQwenCanonicalRoots(
    path('BLACKJACK_BOT_CANONICAL_ROOTS_JSON'),
  )
  const policy = readQwenBootstrapPolicy(
    path('BLACKJACK_BOT_CANONICAL_POLICY_JSON'),
  )
  const stampValueWei = BigInt(
    process.env.BLACKJACK_BOT_STAMP_VALUE_WEI ??
      process.env.FRANK_DM_DEFAULT_STAMP_VALUE_WEI ??
      '10000000000000000',
  )
  const minWagerWei = BigInt(
    process.env.BLACKJACK_BOT_MIN_WAGER_WEI ?? '10000000000000000',
  )
  const maxWagerWei = BigInt(
    process.env.BLACKJACK_BOT_MAX_WAGER_WEI ??
      BLACKJACK_DEFAULT_MAX_WAGER_WEI.toString(),
  )
  const stateDirPath = botStateDir('blackjack', 'BLACKJACK_BOT_STATE_DIR')
  const walletStateDirPath = persistentStateDir(
    'blackjack-wallet',
    'BLACKJACK_BOT_WALLET_STATE_DIR',
  )
  const chainConfig = (relayBaseUrl: string) =>
    qwenCanonicalChainConfig({
      relayBaseUrl,
      walletStorageLocation: join(walletStateDirPath, 'canonical'),
      stampValueWei,
    })
  const openWallet = async (relayBaseUrl: string) => {
    const chain = chainConfig(relayBaseUrl)
    if (chain.networkTag !== policy.networkTag)
      throw new BlackjackStartRefusal('chain-not-installed-network')
    const wallet = await openQwenCanonicalWallet({ chain, roots })
    closeCanonical.push(() => wallet.close())
    return wallet
  }

  const exportPath = process.env.BLACKJACK_BOT_CANONICAL_EXPORT_JSON
  if (exportPath) {
    const home = requiredEnv('BLACKJACK_BOT_CANONICAL_HOME')
    if (home !== 'relay-a' && home !== 'relay-b')
      throw new BlackjackStartRefusal('home-relay-not-relay-a-or-relay-b')
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
      `[blackjack-bot] public revision-zero export written for ${exported.authAddress} (home ${home}); give it to the operator`,
    )
    console.log(
      `[blackjack-bot] canonical stamp account to fund: ${wallet.accountAddress}`,
    )
    return
  }

  const bundle = readQwenApprovedBundle(
    path('BLACKJACK_BOT_CANONICAL_BUNDLE_JSON'),
  )
  const installedSelf = bundle.subjects.find(subject => subject.role === 'bot')
  if (!installedSelf) throw new BlackjackStartRefusal('bundle-installs-no-bot')
  const relayBaseUrl = installedSelf.relay.endpoint
  const configuredRelay = process.env.E2E_DEMO_RELAY_URL
  if (
    configuredRelay &&
    new URL(configuredRelay).origin !== new URL(relayBaseUrl).origin
  )
    throw new BlackjackStartRefusal('relay-url-not-installed-home')
  const bankrollPath = resolve(
    process.cwd(),
    process.env.BLACKJACK_BOT_BANKROLL_WALLET_JSON ??
      requiredEnv('E2E_DEMO_MAIN_WALLET_JSON'),
  )
  let bankrollKey: string
  try {
    bankrollKey = (
      JSON.parse(readFileSync(bankrollPath, 'utf8')) as { privateKey: string }
    ).privateKey
    if (typeof bankrollKey !== 'string') throw new Error('no key')
  } catch {
    throw new BlackjackStartRefusal('bankroll-wallet-unreadable')
  }
  const pollIntervalMs = Number(
    process.env.BLACKJACK_BOT_POLL_INTERVAL_MS ?? 4000,
  )
  const maxHands = Number(process.env.BLACKJACK_BOT_MAX_HANDS ?? 1000)
  const idleTimeoutMs = Number(
    process.env.BLACKJACK_BOT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000,
  )

  console.log('== Blackjack bot, canonical mode ==')
  console.log(`Min wager:  ${minWagerWei} wei`)
  console.log(`Max wager:  ${maxWagerWei} wei`)

  const state = new BlackjackBotStateStore(stateDirPath)
  await state.Open()
  closeCanonical.push(() => state.Close())
  const store = new BlackjackCanonicalStore(stateDirPath)
  await store.Open()
  closeCanonical.push(() => store.Close())
  console.log(`[blackjack-bot] persisted state loaded from ${stateDirPath}`)
  // The commitment exists before any bet this run can see (see the header, "Fairness scheme").
  if (!state.getPendingCommitment()) {
    const serverSeed = generateServerSeed()
    await state.setPendingCommitment(serverSeed, sha256Hex(serverSeed))
    console.log('[blackjack-bot] generated initial pending seed commitment')
  }

  const wallet = await openWallet(relayBaseUrl)
  const identity = wallet.handle.identity
  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: bankrollKey,
    provider: wallet.handle.provider,
    httpClient: wallet.handle.httpClient,
  })
  // Two signers on one account would race its nonce; the journaled payout owns the bankroll's.
  if (
    [wallet.accountAddress, wallet.identityAddress].some(
      address =>
        address.toLowerCase() === mainAccountSigner.address.toLowerCase(),
    )
  )
    throw new BlackjackStartRefusal('bankroll-is-the-typed-wallet')

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
  closeCanonical.push(() => directory.close())
  if (wallet.subject !== directory.selfSubject)
    throw new BlackjackStartRefusal('roots-not-installed-subject')
  const peerSubjects = bundle.subjects
    .filter(subject => subject.role === 'ui')
    .map(subject => subject.subjectP)
  const messages = createMonadChain(chainConfig(relayBaseUrl)).directMessages
  installCanonicalDirectory(
    wallet.handle,
    canonicalDirectoryFor({ installed: directory, peerSubjects }),
  )
  console.log(`Relay:      ${relayBaseUrl}`)
  console.log(`Blackjack bot identity address: ${wallet.identityAddress}`)
  console.log(
    `[blackjack-bot] wagers are verified as transfers to ${identity.displayAddress}; payouts and refunds are paid from the bankroll ${mainAccountSigner.address}; reply stamps are paid from ${wallet.accountAddress}`,
  )
  writeFileSync(
    resolve(
      process.cwd(),
      process.env.BLACKJACK_BOT_HANDOFF_JSON ??
        '/tmp/blackjack-bot-handoff.json',
    ),
    JSON.stringify({ address: wallet.identityAddress }, null, 2),
  )
  const statusPort = process.env.BLACKJACK_BOT_CANONICAL_STATUS_PORT
  if (statusPort) {
    const status = await startQwenInstallationServer({
      directory,
      port: Number(statusPort),
      host: process.env.BLACKJACK_BOT_CANONICAL_STATUS_HOST || undefined,
    })
    closeCanonical.push(() => status.close())
    console.log(
      `[blackjack-bot] installed configuration ${directory.bundleIdentity} served on port ${status.port}`,
    )
  }
  // The app only offers the bet box to the relay-curated dealer whose signed profile says
  // "Blackjack Dealer" (#422/#425). The profile is one public statement signed by the identity
  // key; it carries no message key and enables no legacy message path.
  if (process.env.BLACKJACK_BOT_CANONICAL_PROFILE !== '0') {
    try {
      await registerAndLog({
        relayBaseUrl,
        identity,
        label: 'blackjack-bot',
        profile: botProfileFields('blackjack'),
      })
    } catch {
      console.warn(
        '[blackjack-bot] public dealer profile was not registered; the app will not offer its bet box until it is',
      )
    }
  }

  // Step 5: nothing the wallet retains may be unknown to the outbox, unless a send was in flight
  // when the last run stopped (the outbox adopts exactly that one).
  if (!store.open().some(row => row.phase === 'sending')) {
    let orphans: string[]
    try {
      orphans = await messages.unattributedAttempts({
        wallet: wallet.handle,
        knownDigests: store.digests(),
      })
    } catch {
      throw new BlackjackStartRefusal('wallet-correlation-held')
    }
    if (orphans.length > 0)
      throw new BlackjackStartRefusal('wallet-has-unaccounted-payment-sets')
  }
  const outbox = new BlackjackCanonicalOutbox({
    store,
    messages,
    wallet: wallet.handle,
    stampValueWei,
  })
  const guard = botLoopGuardFromEnv({
    selfAddress: wallet.identityAddress,
    relayBaseUrl,
  })
  const greetingsEnabled = greeterConfigFromEnv(process.env).maxPerRun > 0

  console.log(
    `\nPolling the canonical inbox of ${wallet.identityAddress} at ${relayBaseUrl} every ${pollIntervalMs}ms ...`,
  )
  const result = await runBlackjackLoop<CanonicalBlackjackInbound>({
    state,
    mainAccountSigner,
    pollIntervalMs,
    maxHands,
    idleTimeoutMs,
    fetchMessages: sinceMs =>
      fetchCanonicalInbound(messages, wallet.handle, sinceMs),
    tick: async () => {
      try {
        // One welcome per installed `ui` subject, once it has published its own entry.
        if (greetingsEnabled)
          for (const subject of peerSubjects) {
            const key = `welcome:${subject}`
            if (store.has(key) || !(await directory.peerCurrent(subject)))
              continue
            await outbox.enqueue(
              key,
              computeAddress('0x' + subject),
              welcomeItems({ minWagerWei, maxWagerWei, stampValueWei }),
            )
          }
      } catch {
        console.warn('[blackjack-bot] welcome could not be saved; will retry')
      }
      return outbox.drive()
    },
    processMessage: message =>
      processCanonicalMessage({
        message,
        identity,
        wagerProvider: wallet.handle.provider,
        store,
        outbox,
        blockReason: address => guard.staticBlockReason(address),
        minWagerWei,
        maxWagerWei,
        state,
        mainAccountSigner,
        provider: wallet.handle.provider,
      }),
  })
  console.log(
    `\nDone. Resolved ${result.handsResolved} hand${result.handsResolved === 1 ? '' : 's'}.`,
  )
  if (result.exitCode !== 0) process.exitCode = result.exitCode
}

async function main() {
  if (process.env.BLACKJACK_BOT_CANONICAL_ROOTS_JSON) {
    try {
      return await mainCanonical()
    } finally {
      for (const close of closeCanonical.reverse())
        await close().catch(() => undefined)
      closeCanonical = []
    }
  }
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const networkTag = requiredEnv('FRANK_NETWORK_TAG')
  const minimumStampValueWei = BigInt(
    requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'),
  )
  const stampValueWei = BigInt(
    process.env.BLACKJACK_BOT_STAMP_VALUE_WEI ??
      process.env.FRANK_DM_DEFAULT_STAMP_VALUE_WEI ??
      '10000000000000000',
  )
  if (stampValueWei < minimumStampValueWei) {
    throw new Error(
      `Blackjack bot stamp default ${stampValueWei} is below the relay minimum ${minimumStampValueWei}`,
    )
  }
  const minWagerWei = BigInt(
    process.env.BLACKJACK_BOT_MIN_WAGER_WEI ?? '10000000000000000',
  )
  const maxWagerWei = BigInt(
    process.env.BLACKJACK_BOT_MAX_WAGER_WEI ??
      BLACKJACK_DEFAULT_MAX_WAGER_WEI.toString(),
  )

  const identityJsonPath = resolve(
    process.cwd(),
    process.env.BLACKJACK_BOT_IDENTITY_JSON ?? '/tmp/blackjack-bot-identity.json',
  )
  const mainWalletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )
  const stateDirPath = botStateDir('blackjack', 'BLACKJACK_BOT_STATE_DIR')
  const pollIntervalMs = Number(
    process.env.BLACKJACK_BOT_POLL_INTERVAL_MS ?? 4000,
  )
  const maxHands = Number(process.env.BLACKJACK_BOT_MAX_HANDS ?? 1000)
  const idleTimeoutMs = Number(
    process.env.BLACKJACK_BOT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000,
  )

  console.log('== Blackjack bot: provably-fair, stamped-DM-driven blackjack over Monad testnet ==')
  console.log(`Relay:      ${relayBaseUrl}`)
  console.log(`Min wager:  ${minWagerWei} wei`)
  console.log(`Max wager:  ${maxWagerWei} wei`)
  console.log(`Max hands:  ${maxHands}`)

  const identity = loadOrCreateIdentity(identityJsonPath, 'blackjack-bot')
  await registerAndLog({
    relayBaseUrl,
    identity,
    label: 'blackjack-bot',
    profile: botProfileFields('blackjack'),
  })
  console.log(`Blackjack bot identity address: ${identity.displayAddress}`)

  // No poolSize -- lazily funded per-send, same as qwen-bot.livecheck.ts (see
  // setUpFundedStampClient's own header, "Lazy per-send funding").
  const { stampClient, mainAccountSigner, provider, pool, closePool } =
    await setUpFundedStampClient({
      rpcUrl,
      relayBaseUrl,
      mainWalletJsonPath,
      stampValueWei,
      label: 'blackjack-bot',
      stateDir: stateDirPath,
    })

  const rpcProvider = new JsonRpcProvider(rpcUrl)

  const state = new BlackjackBotStateStore(stateDirPath)
  await state.Open()
  console.log(`[blackjack-bot] persisted state loaded from ${stateDirPath}`)

  // The pending commitment must already exist *before* the first bet this run will ever see --
  // generate one now if a previous run didn't leave one behind (see this file's header, "Fairness
  // scheme").
  if (!state.getPendingCommitment()) {
    const serverSeed = generateServerSeed()
    await state.setPendingCommitment(serverSeed, sha256Hex(serverSeed))
    console.log('[blackjack-bot] generated initial pending seed commitment')
  }

// The welcome greeting. Its own small durable store (never the game-authority store).
  const greetingStore = new BlackjackGreetingStore(stateDirPath)
  await greetingStore.Open()
  const greeterConfig = greeterConfigFromEnv(process.env)
  const profileWatchStart = Number(
    process.env.BLACKJACK_BOT_PROFILE_SINCE_MS || Date.now(),
  )
  if (!Number.isFinite(profileWatchStart)) {
    throw new Error('BLACKJACK_BOT_PROFILE_SINCE_MS must be a number of milliseconds')
  }
  const guard = botLoopGuardFromEnv({
    selfAddress: identity.displayAddress,
    relayBaseUrl,
  })
  const greeter = new BlackjackGreeter(
    {
      store: greetingStore,
      guard,
      startedAt: profileWatchStart,
      async listProfiles(sinceMs): Promise<GreeterProfile[]> {
        const profiles = await fetchMonadProfilesSince({ relayBaseUrl, sinceMs })
        return profiles.map(profile => ({
          address: profile.address,
          signedPayload: profile.signedPayload,
          registeredAt: AddressMetadata.deserializeBinary(
            profile.signedPayload.getPayload_asU8(),
          ).getTimestamp(),
        }))
      },
      // A greeting must never eat what open hands may still owe, nor the stamp it pays.
      async canAffordGreeting() {
        const balance = await rpcProvider.getBalance(mainAccountSigner.address)
        return (
          balance >=
          state.openExposureWei() + stampValueWei + GREETING_FEE_RESERVE_WEI
        )
      },
      async sendWelcome(profile) {
        await sendDirectMessageItems({
          stampClient,
          pool,
          mainAccountSigner,
          provider,
          fromIdentity: identity,
          toAddress: profile.address,
          toPubKey: Buffer.from(profile.signedPayload.getPublicKey_asU8()),
          items: welcomeItems({ minWagerWei, maxWagerWei, stampValueWei }),
          stampValueWei,
          networkTag,
        })
      },
    },
    greeterConfig,
  )
  console.log(
    `Greetings:  up to ${greeterConfig.maxPerRun} per run, ${greeterConfig.maxPerDay} per day`,
  )

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad/inbox/<me> (signed mailbox read, since=<t>) every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )
  console.log(
    `[blackjack-bot] payer account ${mainAccountSigner.address}: this bot assumes it is the ONLY signer of that key (the raffle and qwen bots default to the same chain wallet file -- do not run them against it concurrently). Payout nonces are reserved in-process only.`,
  )

const senderPubKeyCache = new Map<string, Buffer>()
  const result = await runBlackjackLoop({
    state,
    mainAccountSigner,
    pollIntervalMs,
    maxHands,
    idleTimeoutMs,
    fetchMessages: (sinceMs) =>
      fetchMonadMessagesSince({
        ...mailboxAuthFor(identity, relayBaseUrl),
        sinceMs,
      }),
    // Greetings sign from the payer account (the welcome stamp's funding transfer); the loop runs
    // them only while the payout lane is free (see runBlackjackLoop's lane gate).
    greet: () => greeter.poll(),
    processMessage: async (message) => {
      const payloadHashHex = Buffer.from(message.message!.payloadHash).toString('hex')
      const envelope = parseEnvelope(message.message!.encryptedPayload)
      if (!envelope) return undefined
      if (!sameMonadEnvelopeAddress(envelope.to, identity.displayAddress)) return undefined
      if (sameMonadEnvelopeAddress(envelope.from, identity.displayAddress)) return undefined

      let senderPubKey = senderPubKeyCache.get(envelope.from)
      if (!senderPubKey) {
        senderPubKey = await fetchMonadIdentityPubKey({
          relayBaseUrl,
          address: envelope.from,
        })
        if (!senderPubKey) return undefined
        senderPubKeyCache.set(envelope.from, senderPubKey)
      }

      const rawPlaintext = tryDecryptEnvelope({
        envelope,
        myPrivateKey: identity.toNakamotoPrivateKey(),
        senderPubKey,
      })
      if (rawPlaintext === undefined) {
        console.warn(
          `[blackjack-bot] rejected unauthenticated or undecryptable message ${payloadHashHex}`,
        )
        return undefined
      }

      let items
      try {
        items = deserializeMessageItems(rawPlaintext)
      } catch {
        return undefined // not a MessageItem[] payload -- ignore, same as qwen-bot's own text-only fallback
      }
      const moveRaw = items.find(
        (item): item is BlackjackMoveItem => item.type === 'blackjack-move',
      )
      if (!moveRaw) return undefined

      const plugin = getMessageItemPlugin('blackjack-move')
      if (!plugin) throw new Error('blackjack-move plugin not registered')
      const context: MessageItemContext = {
        message: message.message as unknown as Message,
        index: items.indexOf(moveRaw),
        provider: rpcProvider,
      }
      // Real message.senderAddress isn't populated on the raw relay response shape the same way
      // the frontend's own `Message` is -- patch it in from what we already verified via the
      // envelope/decrypt above, so hydrate()'s context matches what it expects.
      ;(context.message as { senderAddress: string }).senderAddress = envelope.from

      let hydrated: HydratedBlackjackMove
      try {
        hydrated = await hydrateMoveWithValidatedGameId(moveRaw, (validated) =>
          plugin.hydrate(validated, context),
        )
      } catch (error) {
        if (!(error instanceof InvalidBlackjackGameIdError)) throw error
        console.log(
          `[blackjack-bot] rejecting ${moveRaw.action} from ${envelope.from}: invalid gameId`,
        )
        await sendDirectMessageText({
          stampClient,
          pool,
          mainAccountSigner,
          provider,
          fromIdentity: identity,
          toAddress: envelope.from,
          toPubKey: senderPubKey,
          text: 'Blackjack: gameId must be a nonempty bounded string',
          stampValueWei,
          networkTag,
        })
        return undefined
      }

      console.log(
        `\n[blackjack-bot] ${moveRaw.action} from ${envelope.from} (game ${hydrated.gameId})`,
      )

      try {
        await handleMove({
          action: moveRaw.action,
          hydrated,
          senderAddress: envelope.from,
          senderPubKey,
          minWagerWei,
          maxWagerWei,
          state,
          identity,
          networkTag,
          stampValueWei,
          stampClient,
          pool,
          mainAccountSigner,
          provider,
        })
      } catch (err) {
        console.error(
          `[blackjack-bot] failed to handle ${moveRaw.action} for game ${hydrated.gameId}:`,
          err,
        )
      }
      return { action: moveRaw.action, gameId: hydrated.gameId }
    },
  })

  await state.Close()
  await greetingStore.Close()
  await closePool()
  console.log(`\nDone. Resolved ${result.handsResolved} hand${result.handsResolved === 1 ? '' : 's'}.`)
  if (result.exitCode !== 0) process.exitCode = result.exitCode
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(err => {
    // A refusal carries only a fixed reason word; print it so an operator can act.
    const refusal = err as { name?: unknown; code?: unknown } | null
    if (
      (refusal?.name === 'BlackjackStartRefusal' ||
        refusal?.name === 'QwenStartRefusal') &&
      typeof refusal.code === 'string' &&
      /^[a-z-]{1,64}$/.test(refusal.code)
    )
      console.error(`\nBLACKJACK BOT REFUSING TO START: ${refusal.code}`)
    console.error('BLACKJACK BOT FAILED:', err)
    process.exit(1)
  })
}

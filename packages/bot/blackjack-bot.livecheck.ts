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
 */
import { randomBytes } from 'crypto'
import { resolve } from 'path'

import { JsonRpcProvider, Provider } from 'ethers'

import {
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
import { BlackjackMoveItem, Message } from '@frank/cashweb/types/messages'
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
  resolveOutcome,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import { MonadStampClient } from '@frank/wallet/monad-stamp-client'
import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import {
  loadOrCreateIdentity,
  registerAndLog,
  requiredEnv,
  sendDirectMessageItems,
  sendDirectMessageText,
  setUpFundedStampClient,
} from './qwen-bot-common'
import { botStateDir } from './bot-state-dir'
import { botProfileFields } from './bot-directory'
import {
  BlackjackBotStateStore,
  BlackjackGameRecord,
  InvalidBlackjackGameIdError,
  normalizeBlackjackGameId,
  normalizePlayerAddress,
  normalizeWagerTxHash,
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

async function resolveAndReveal(params: {
  gameId: string
  record: BlackjackGameRecord
  identity: MonadIdentity
  senderPubKey: Buffer
  networkTag: string
  stampValueWei: bigint
  stampClient: MonadStampClient
  pool: MonadSubAccountPool
  mainAccountSigner: MonadAccountTxSigner
  provider: Provider
  state: BlackjackBotStateStore
}): Promise<void> {
  const {
    gameId,
    record,
    identity,
    senderPubKey,
    networkTag,
    stampValueWei,
    stampClient,
    pool,
    mainAccountSigner,
    provider,
    state,
  } = params
  if (record.authority !== 'verified-wager-sender') {
    throw new Error(
      'cannot resolve or pay a blackjack game without verified wager authority',
    )
  }
  const deck = deriveDeck(record.serverSeed, record.wagerTxHash, 0)
  const playerCards = playerCardsSoFar(deck, record.dealtCount)
  const playerValue = handValue(playerCards)
  // A double-down puts a second, independently-verified transfer of the same size into the pot --
  // never just a client-side-doubled number (see `BlackjackGameRecord.doubleWagerWei`'s own
  // header) -- so the payout base is the sum of the two real transfers actually received, not
  // `wagerWei * 2`.
  const effectiveWagerWei =
    record.doubled && record.doubleWagerWei !== undefined
      ? record.wagerWei + record.doubleWagerWei
      : record.wagerWei

  let dealerCards = dealInitialCards(deck).dealerCards
  let dealtCount = record.dealtCount
  // A player natural is final as dealt -- the dealer never draws further regardless of its own
  // up-card, matching standard casino rules (see resolveOutcome's own blackjack-vs-blackjack
  // handling for the push case this still needs to distinguish).
  if (!playerValue.bust && !playerValue.blackjack) {
    while (handValue(dealerCards).total < 17) {
      dealerCards = [...dealerCards, deck[dealtCount]]
      dealtCount += 1
    }
  }
  const outcome = playerValue.bust
    ? 'dealer_win'
    : resolveOutcome(playerValue, handValue(dealerCards))

  await state.setGame(gameId, { ...record, dealtCount, revealed: true })

  console.log(
    `[blackjack-bot] resolving game ${gameId}: player=${JSON.stringify(playerCards)} dealer=${JSON.stringify(dealerCards)} outcome=${outcome}`,
  )

  await sendDirectMessageItems({
    stampClient,
    pool,
    mainAccountSigner,
    provider,
    fromIdentity: identity,
    toAddress: record.playerAddress,
    toPubKey: senderPubKey,
    items: [
      {
        type: 'blackjack-move',
        gameId,
        action: 'reveal',
        dealerCards,
        serverSeed: record.serverSeed,
        outcome,
      },
    ],
    stampValueWei,
    networkTag,
  })

  const multiplier = payoutMultiplier(outcome)
  if (multiplier > 0) {
    const payoutWei =
      (BigInt(Math.round(multiplier * 1000)) * effectiveWagerWei) / 1000n
    console.log(
      `[blackjack-bot] paying out ${payoutWei} wei (${multiplier}x) to ${record.playerAddress} ...`,
    )
    const signedTx = await mainAccountSigner.buildAndSignTransfer(
      record.playerAddress,
      payoutWei,
    )
    const txHash = await mainAccountSigner.submit(signedTx)
    console.log(`[blackjack-bot] payout tx sent: ${txHash}`)
  } else {
    console.log('[blackjack-bot] dealer wins -- no payout, wager already received as the bet.')
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

export async function handleMove(params: {
  action: BlackjackMoveItem['action']
  hydrated: HydratedBlackjackMove
  senderAddress: string
  senderPubKey: Buffer
  minWagerWei: bigint
  maxWagerWei?: bigint
  state: BlackjackBotStateStore
  identity: MonadIdentity
  networkTag: string
  stampValueWei: bigint
  stampClient: MonadStampClient
  pool: MonadSubAccountPool
  mainAccountSigner: MonadAccountTxSigner
  provider: Provider
}): Promise<void> {
  const {
    action,
    hydrated,
    senderAddress,
    senderPubKey,
    minWagerWei,
    maxWagerWei = BLACKJACK_DEFAULT_MAX_WAGER_WEI,
    state,
    identity,
    networkTag,
    stampValueWei,
    stampClient,
    pool,
    mainAccountSigner,
    provider,
  } = params
  let gameId: string
  try {
    gameId = normalizeBlackjackGameId(
      (hydrated as unknown as { gameId: unknown }).gameId,
    )
  } catch {
    console.log(`[blackjack-bot] rejecting ${action}: invalid gameId`)
    await sendDirectMessageText({
      stampClient,
      pool,
      mainAccountSigner,
      provider,
      fromIdentity: identity,
      toAddress: senderAddress,
      toPubKey: senderPubKey,
      text: 'Blackjack: gameId must be a nonempty bounded string',
      stampValueWei,
      networkTag,
    })
    return
  }

  async function sendError(text: string) {
    console.log(`[blackjack-bot] rejecting ${action} for game ${gameId}: ${text}`)
    await sendDirectMessageText({
      stampClient,
      pool,
      mainAccountSigner,
      provider,
      fromIdentity: identity,
      toAddress: senderAddress,
      toPubKey: senderPubKey,
      text: formatBlackjackError(gameId, text),
      stampValueWei,
      networkTag,
    })
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
   * that is already claimed (e.g. this game's own stake). Returns text to append to the error. */
  async function refundRejected(
    txHash: string | undefined,
    transfer: HydratedBlackjackMove['verifiedWager'],
  ): Promise<string> {
    if (!txHash || !transfer) return ''
    let hash: string
    try {
      hash = normalizeWagerTxHash(txHash)
      if (
        normalizePlayerAddress(transfer.fromAddress) !== authenticatedPlayerAddress ||
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
      playerAddress: authenticatedPlayerAddress,
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
    if (wagerSenderAddress !== authenticatedPlayerAddress) {
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
        `wager ${wager.valueWei} wei is below the table minimum of ${minWagerWei} wei`,
      )
      return
    }
    if (wager.valueWei > maxWagerWei) {
      await rejectBet(
        `wager ${wager.valueWei} wei is above the table maximum of ${maxWagerWei} wei`,
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

    await sendDirectMessageItems({
      stampClient,
      pool,
      mainAccountSigner,
      provider,
      fromIdentity: identity,
      toAddress: record.playerAddress,
      toPubKey: senderPubKey,
      items: [
        {
          type: 'blackjack-move',
          gameId,
          action: 'deal',
          serverSeedHash: commitment.serverSeedHash,
          playerCards,
          dealerUpCard: dealerCards[0],
        },
      ],
      stampValueWei,
      networkTag,
    })

    if (handValue(playerCards).blackjack) {
      await resolveAndReveal({
        gameId,
        record,
        identity,
        senderPubKey,
        networkTag,
        stampValueWei,
        stampClient,
        pool,
        mainAccountSigner,
        provider,
        state,
      })
    }
    return
  }

  if (action === 'deal' || action === 'reveal') {
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
  if (record.playerAddress !== authenticatedPlayerAddress) {
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

    await sendDirectMessageItems({
      stampClient,
      pool,
      mainAccountSigner,
      provider,
      fromIdentity: identity,
      toAddress: record.playerAddress,
      toPubKey: senderPubKey,
      items: [{ type: 'blackjack-move', gameId, action: 'hit', playerCards }],
      stampValueWei,
      networkTag,
    })

    if (handValue(playerCards).bust) {
      await resolveAndReveal({
        gameId,
        record: { ...record, dealtCount: newDealtCount },
        identity,
        senderPubKey,
        networkTag,
        stampValueWei,
        stampClient,
        pool,
        mainAccountSigner,
        provider,
        state,
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
    if (doubleWagerSenderAddress !== authenticatedPlayerAddress) {
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
        `double-down wager must match your original wager exactly (${record.wagerWei} wei)`,
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

    await sendDirectMessageItems({
      stampClient,
      pool,
      mainAccountSigner,
      provider,
      fromIdentity: identity,
      toAddress: record.playerAddress,
      toPubKey: senderPubKey,
      items: [{ type: 'blackjack-move', gameId, action: 'double', playerCards }],
      stampValueWei,
      networkTag,
    })

    // Doubling is always exactly one more card then an automatic stand -- win, lose, or bust, the
    // hand is over, unlike an ordinary `hit` which only forces a reveal on a bust.
    await resolveAndReveal({
      gameId,
      record: updatedRecord,
      identity,
      senderPubKey,
      networkTag,
      stampValueWei,
      stampClient,
      pool,
      mainAccountSigner,
      provider,
      state,
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
      senderPubKey,
      networkTag,
      stampValueWei,
      stampClient,
      pool,
      mainAccountSigner,
      provider,
      state,
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

async function main() {
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

  const senderPubKeyCache = new Map<string, Buffer>()
  let since = Date.now()
  let handsResolved = 0
  let lastActivityAt = Date.now()

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad/inbox/<me> (signed mailbox read, since=<t>) every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )

  while (handsResolved < maxHands) {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      console.log(`\nNo activity within ${idleTimeoutMs}ms -- exiting.`)
      break
    }

    await retryPendingRefunds(state, mainAccountSigner)

    const stored = await fetchMonadMessagesSince({
      ...mailboxAuthFor(identity, relayBaseUrl),
      sinceMs: since,
    })
    let maxSeenTimestamp = since - 1

    for (const message of stored) {
      maxSeenTimestamp = Math.max(maxSeenTimestamp, message.timestamp)
      if (!message.message) continue

      const payloadHashHex = Buffer.from(
        message.message.payloadHash,
      ).toString('hex')
      if (state.hasProcessed(payloadHashHex)) continue
      state.addProcessed(payloadHashHex)

      const envelope = parseEnvelope(message.message.encryptedPayload)
      if (!envelope) continue
      if (!sameMonadEnvelopeAddress(envelope.to, identity.displayAddress)) continue
      if (sameMonadEnvelopeAddress(envelope.from, identity.displayAddress)) continue

      let senderPubKey = senderPubKeyCache.get(envelope.from)
      if (!senderPubKey) {
        senderPubKey = await fetchMonadIdentityPubKey({
          relayBaseUrl,
          address: envelope.from,
        })
        if (!senderPubKey) continue
        senderPubKeyCache.set(envelope.from, senderPubKey)
      }

      const rawPlaintext = tryDecryptEnvelope({
        envelope,
        myPrivateKey: identity.toBitcorePrivateKey(),
        senderPubKey,
      })
      if (rawPlaintext === undefined) {
        console.warn(
          `[blackjack-bot] rejected unauthenticated or undecryptable message ${payloadHashHex}`,
        )
        continue
      }

      let items
      try {
        items = deserializeMessageItems(rawPlaintext)
      } catch {
        continue // not a MessageItem[] payload -- ignore, same as qwen-bot's own text-only fallback
      }
      const moveRaw = items.find(
        (item): item is BlackjackMoveItem => item.type === 'blackjack-move',
      )
      if (!moveRaw) continue

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
        continue
      }

      lastActivityAt = Date.now()
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

      if (moveRaw.action === 'reveal' || (state.getGame(hydrated.gameId)?.revealed ?? false)) {
        handsResolved++
      }
      if (handsResolved >= maxHands) break
    }

    if (stored.length > 0) since = maxSeenTimestamp + 1
    await state.flush()
    await sleep(pollIntervalMs)
  }

  await state.Close()
  await closePool()
  console.log(`\nDone. Resolved ${handsResolved} hand${handsResolved === 1 ? '' : 's'}.`)
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(err => {
    console.error('BLACKJACK BOT FAILED:', err)
    process.exit(1)
  })
}

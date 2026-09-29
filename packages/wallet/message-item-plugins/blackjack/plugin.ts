/**
 * Registers the `blackjack-move` message item type with the shared plugin registry (`../index.ts`).
 * `hydrate()` is the one place a `bet` move's wager gets verified against a real on-chain
 * transaction instead of trusting any self-reported amount -- there is no amount field on the wire
 * type at all (see `BlackjackMoveItem`'s own header on `@frank/cashweb/types/messages`), so the
 * only way to know the real wager is to look up `wagerTxHash` here.
 */
import { Provider } from 'ethers'

import { BlackjackMoveItem } from '@frank/cashweb/types/messages'

import {
  BlackjackGameState,
  HydratedBlackjackMove,
  reduceBlackjackState,
} from './game'
import { registerMessageItemPlugin } from '../index'

/** Looks up `wagerTxHash` on-chain and reports what it actually shows -- confirmed or not, real
 * sender/recipient/value -- without judging whether it's "enough" or "to the right place" (that's
 * the caller's job, e.g. a bot comparing `toAddress` against its own identity, since this shared
 * module has no notion of "who am I" -- see this file's header). Returns `undefined` if the tx
 * doesn't exist, isn't confirmed yet, or the lookup itself fails (treated the same as "not
 * verified yet," never as "verified for zero" -- a caller must not treat a lookup failure as proof
 * the wager doesn't exist). */
async function verifyWagerTransaction(
  provider: Provider,
  wagerTxHash: string,
): Promise<HydratedBlackjackMove['verifiedWager']> {
  try {
    const tx = await provider.getTransaction(wagerTxHash)
    if (!tx || tx.to === null) return undefined
    const receipt = await provider.getTransactionReceipt(wagerTxHash)
    if (!receipt || receipt.status !== 1) return undefined
    return {
      fromAddress: tx.from,
      toAddress: tx.to,
      valueWei: tx.value,
    }
  } catch {
    return undefined
  }
}

registerMessageItemPlugin<BlackjackMoveItem, HydratedBlackjackMove, BlackjackGameState>({
  type: 'blackjack-move',
  async hydrate(raw, context) {
    const verifiedWager =
      raw.action === 'bet' && raw.wagerTxHash
        ? await verifyWagerTransaction(context.provider, raw.wagerTxHash)
        : undefined
    const verifiedDoubleWager =
      raw.action === 'double' && raw.doubleWagerTxHash
        ? await verifyWagerTransaction(context.provider, raw.doubleWagerTxHash)
        : undefined
    return {
      gameId: raw.gameId,
      action: raw.action,
      wagerTxHash: raw.wagerTxHash,
      doubleWagerTxHash: raw.doubleWagerTxHash,
      serverSeedHash: raw.serverSeedHash,
      playerCards: raw.playerCards,
      dealerUpCard: raw.dealerUpCard,
      dealerCards: raw.dealerCards,
      serverSeed: raw.serverSeed,
      outcome: raw.outcome,
      verifiedWager,
      verifiedDoubleWager,
      senderAddress: context.message.senderAddress,
    }
  },
  previewText(raw) {
    switch (raw.action) {
      case 'bet':
        return 'Placed a blackjack bet'
      case 'deal':
        return 'Blackjack hand dealt'
      case 'hit':
        return 'Hit'
      case 'double':
        return 'Doubled down'
      case 'stand':
        return 'Stood'
      case 'reveal':
        return 'Blackjack hand resolved'
    }
  },
  threadKey: raw => raw.gameId,
  reduceState: (prevState, hydrated) => reduceBlackjackState(prevState, hydrated),
})

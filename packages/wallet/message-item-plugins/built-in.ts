/**
 * The 5 message item types that existed before the plugin registry (`./index.ts`) did -- ported
 * here as a behavior-preserving refactor, not a redesign. Each plugin reproduces
 * exactly what its type's old scattered switch-case branches did; see the registry's own header for
 * the switches this replaces. Two real, live bugs get fixed as a side effect of routing everything
 * through one registry instead of independently-maintained switches: `p2pkh` previously had no
 * renderer at all (silently unrendered in `ChatMessage.vue`), and `reply`/`p2pkh` previously fell
 * through to a dangling reference to a variable (`nopInfo`) that no longer existed after an earlier
 * fix removed its declaration but missed this third use site -- a live `ReferenceError` waiting to
 * happen the next time either type was the last message in a chat.
 */
import {
  ImageItem,
  P2PKHSendItem,
  LiarsDiceItem,
  PokerItem,
  ReplyItem,
  RpsItem,
  SatoshiDiceItem,
  StealthItem,
  SwapOfferItem,
  TextItem,
} from '@frank/cashweb/types/messages'

import { registerMessageItemPlugin } from './index'

registerMessageItemPlugin<SwapOfferItem, SwapOfferItem>({
  type: 'swap-offer',
  hydrate: raw => raw,
  previewText: raw =>
    `Atomic swap offer: ${raw.offeredAmount} ${raw.offeredAsset} (${raw.offeredChain}) for ${raw.requestedAmount} ${raw.requestedAsset} (${raw.requestedChain})`,
  tallyValue: raw => raw.offeredAmount,
})

registerMessageItemPlugin<TextItem, TextItem>({
  type: 'text',
  hydrate: raw => raw,
  previewText: raw => raw.text,
})

registerMessageItemPlugin<ImageItem, ImageItem>({
  type: 'image',
  hydrate: raw => raw,
  previewText: () => 'Sent image',
})

registerMessageItemPlugin<StealthItem, StealthItem>({
  type: 'stealth',
  hydrate: raw => raw,
  previewText: raw => {
    const network = raw.networkTag ?? raw.chainId
    if (network) {
      return `Sent stealth payment (${network})`
    }
    return 'Sent stealth payment'
  },
  // Matches the pre-existing behavior exactly: reads the item's own self-reported `amount`, not a
  // chain-verified figure. See this hook's own doc comment on the registry for why that's a known,
  // separately-tracked gap (ticket #60), not something this port changes.
  tallyValue: raw => raw.amount,
})

registerMessageItemPlugin<ReplyItem, ReplyItem>({
  type: 'reply',
  hydrate: raw => raw,
  // Previously fell through to a dangling `nopInfo` reference in `getLatestMessage` (a live
  // ReferenceError) and had no notification-body handling either. A reply's own text lives in the
  // *replied-to* message, not this item, so a generic placeholder is the right behavior-preserving
  // choice here -- nothing before this registry ever resolved and inlined the original text either.
  previewText: () => 'Replied to a message',
})

registerMessageItemPlugin<P2PKHSendItem, P2PKHSendItem>({
  type: 'p2pkh',
  hydrate: raw => raw,
  // Previously had no renderer at all in `ChatMessage.vue` (silently unrendered) and no preview
  // text either. This is a legacy, Lotus-only send type -- `deserializeMessageItems`
  // (`packages/wallet/chain/monad-chain.ts`) already throws if one is ever encountered on Monad, so
  // in practice this only matters for historical Lotus-origin message content, if any is still
  // reachable at all.
  previewText: () => 'Sent a payment',
})

registerMessageItemPlugin<RpsItem, RpsItem>({
  type: 'rps',
  hydrate: raw => raw,
  previewText: raw => {
    if (raw.action === 'challenge') return 'Rock-Paper-Scissors Challenge'
    if (raw.action === 'start') return 'Rock-Paper-Scissors Match'
    if (raw.action === 'resolve') {
      return `RPS Result: ${raw.outcome === 'win' ? 'You won!' : raw.outcome === 'lose' ? 'You lost' : 'Tie'}`
    }
    return 'Rock-Paper-Scissors'
  },
})

registerMessageItemPlugin<SatoshiDiceItem, SatoshiDiceItem>({
  type: 'dice',
  hydrate: raw => raw,
  previewText: raw => {
    if (raw.action === 'result') {
      return `Satoshi Dice: Rolled ${raw.luckyNumber} (${raw.isWin ? 'Win!' : 'Loss'})`
    }
    return 'Satoshi Dice Roll'
  },
})

registerMessageItemPlugin<LiarsDiceItem, LiarsDiceItem>({
  type: 'liars-dice',
  hydrate: raw => raw,
  previewText: raw => {
    if (raw.action === 'create') return `Liar's Dice: Table created (${raw.tableId})`
    if (raw.action === 'join') return `Liar's Dice: Player joined`
    if (raw.action === 'bid' && raw.currentBid) {
      return `Liar's Dice Bid: ${raw.currentBid.quantity}x [${raw.currentBid.face}]`
    }
    if (raw.action === 'challenge') return `Liar's Dice: Called Liar!`
    if (raw.action === 'showdown') return `Liar's Dice: Showdown!`
    if (raw.action === 'settle') return `Liar's Dice: Table Settled!`
    return "Liar's Dice (Perudo)"
  },
})

registerMessageItemPlugin<PokerItem, PokerItem>({
  type: 'poker',
  hydrate: raw => raw,
  previewText: raw => {
    if (raw.action === 'create') return `Texas Hold'em Table created (${raw.tableId})`
    if (raw.action === 'join') return `Texas Hold'em: Player joined`
    if (raw.action === 'deal') return `Texas Hold'em: Hand dealt (pot: ${raw.pot})`
    if (raw.action === 'action' && raw.lastAction) {
      return `Poker: ${raw.lastAction.player.slice(0, 8)} ${raw.lastAction.action}${raw.lastAction.amount ? ` ${raw.lastAction.amount}` : ''}`
    }
    if (raw.action === 'showdown') return `Texas Hold'em: Showdown!`
    if (raw.action === 'settle') return `Texas Hold'em: Hand settled!`
    return "Texas Hold'em Poker"
  },
})



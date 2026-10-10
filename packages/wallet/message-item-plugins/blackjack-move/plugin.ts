/**
 * The dealer-bot `blackjack-move` message item type, installed by `initBlackjackMovePlugin`.
 * `hydrate()` is the one place a `bet` move's wager gets verified against a real on-chain
 * transaction instead of trusting any self-reported amount -- there is no amount field on the wire
 * type at all (see `BlackjackMoveItem`'s own header on `@frank/cashweb/types/messages`), so the
 * only way to know the real wager is to look up `wagerTxHash` here.
 *
 * Not carried on the canonical direct message path (`NOT_CARRIED_ITEM_TYPES` in `../wire.ts`), and
 * the hosted dealer no longer plays it. The type stays registered so stored messages render.
 */
import { Provider } from 'ethers'

import type { ParsedFrame } from '@frank/codec'
import { encodeBlackjackItem, projectBlackjackItem } from '@frank/codec'
import {
  BlackjackMoveItem,
  CanonicalBlackjackMoveItem,
} from '@frank/cashweb/types/messages'

import {
  BlackjackGameState,
  HydratedBlackjackMove,
  parseBlackjackWelcome,
  reduceBlackjackState,
} from '../blackjack/game'
import {
  requirePluginCapabilities,
  type MessageItemContext,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { decodeBlackjackMove, encodeBlackjackMove } from './codec'

/** Looks up `wagerTxHash` on-chain and reports what it actually shows -- confirmed or not, real
 * sender/recipient/value -- without judging whether it's "enough" or "to the right place" (that's
 * the caller's job, e.g. a bot comparing `toAddress` against its own identity, since this shared
 * module has no notion of "who am I" -- see this file's header). Returns `undefined` if the tx
 * doesn't exist, isn't confirmed yet, or the lookup itself fails (treated the same as "not
 * verified yet," never as "verified for zero" -- a caller must not treat a lookup failure as proof
 * the wager doesn't exist). */
/** Successful verifications only, per provider, keyed by lowercase tx hash, oldest evicted past
 * the bound. A confirmed receipt with status 1 is treated as final for display and for the bot's
 * checks; a deep reorg that drops it after the fact is not handled (same limit the uncached
 * lookup had between two checks). Failures/unverified results are never cached, so a transient
 * RPC error cannot stick, and a cached success is never lost to a later transient failure. */
const VERIFIED_CACHE_MAX = 256
const verifiedCaches = new WeakMap<
  Provider,
  Map<string, NonNullable<HydratedBlackjackMove['verifiedWager']>>
>()

async function verifyWagerTransaction(
  provider: Provider,
  wagerTxHash: string,
): Promise<HydratedBlackjackMove['verifiedWager']> {
  let cache = verifiedCaches.get(provider)
  if (!cache) {
    cache = new Map()
    verifiedCaches.set(provider, cache)
  }
  const key = wagerTxHash.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached
  const result = await lookupWagerTransaction(provider, wagerTxHash)
  if (result) {
    // Never overwrite an entry a concurrent lookup already stored.
    if (!cache.has(key)) cache.set(key, result)
    if (cache.size > VERIFIED_CACHE_MAX) {
      cache.delete(cache.keys().next().value as string)
    }
  }
  return result
}

async function lookupWagerTransaction(
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

/** Validate the complete closed writer shape before callers fund or send it. */
export function encodeCanonicalBlackjackItem(
  item: CanonicalBlackjackMoveItem,
): Uint8Array {
  return encodeBlackjackItem(item)
}

/** Accept only an already validated parsed type18 child from public authenticated content.
 * Keeps the original frame; never reparses a child with a fresh traversal budget.
 * The projection and frame are copy-owned by the public codec.
 */
export function projectCanonicalBlackjackItem(parsed: ParsedFrame): {
  frame: Uint8Array
  item: CanonicalBlackjackMoveItem
} {
  return projectBlackjackItem(parsed)
}

/** Shape is already established by the parent's validation. Wager lookup remains separate
 * from authenticated actor, game, directory and payment authority, which stay caller-owned.
 */
export async function hydrateCanonicalBlackjackItem(
  parsed: ParsedFrame,
  context: MessageItemContext,
): Promise<{
  frame: Uint8Array
  item: CanonicalBlackjackMoveItem
  hydrated: HydratedBlackjackMove
}> {
  const projected = projectCanonicalBlackjackItem(parsed)
  return {
    ...projected,
    hydrated: await hydrateBlackjackItem(
      {
        ...projected.item,
        playerCards:
          'playerCards' in projected.item
            ? projected.item.playerCards?.slice()
            : undefined,
        dealerCards:
          'dealerCards' in projected.item
            ? projected.item.dealerCards.slice()
            : undefined,
      },
      context,
    ),
  }
}

async function hydrateBlackjackItem(
  raw: BlackjackMoveItem,
  context: MessageItemContext,
): Promise<HydratedBlackjackMove> {
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
    welcome: parseBlackjackWelcome(raw),
    senderAddress: context.message.senderAddress,
  }
}

export function initBlackjackMovePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('blackjack-move', capabilities)
  registry.register<
    BlackjackMoveItem,
    HydratedBlackjackMove,
    BlackjackGameState
  >({
    type: 'blackjack-move',
    hydrate: hydrateBlackjackItem,
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
        case 'welcome':
          return 'Blackjack table open'
        default:
          // An action a newer dealer added: still a string, so a chat-list preview never breaks.
          return 'Blackjack'
      }
    },
    threadKey: raw => raw.gameId,
    reduceState: (prevState, hydrated) =>
      reduceBlackjackState(prevState, hydrated),
    encode: encodeBlackjackMove,
    decode: decodeBlackjackMove,
  })
}

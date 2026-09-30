import { Utxo } from './utxo'

export interface ReplyItem {
  type: 'reply'
  payloadDigest: string
}

export interface TextItem {
  type: 'text'
  text: string
}

export interface P2PKHSendItem {
  type: 'p2pkh'
  address: string
  amount: number
}

export interface StealthItem {
  type: 'stealth'
  amount: number
  txId?: string
  outputIndex?: number
}

export interface ImageItem {
  type: 'image'
  image: string
}

/**
 * One move in a provably-fair blackjack hand against a bot dealer (see `@frank/wallet/message-item-plugins/blackjack`
 * for the shared shuffle/hand-value logic and the message-item plugin that hydrates/verifies and
 * threads these into game state). Deliberately carries no self-reported amount field for `bet` --
 * the wager is a separate, independently-verified on-chain transfer referenced by `wagerTxHash`,
 * never a number trusted from this JSON payload. `gameId` scopes one hand (bet through reveal);
 * a new hand always gets a fresh `gameId`, there is no persistent "session" concept at the
 * protocol level.
 */
export interface BlackjackMoveItem {
  type: 'blackjack-move'
  gameId: string
  action: 'bet' | 'deal' | 'hit' | 'stand' | 'double' | 'reveal'
  /** `bet` only: the tx hash of the separate plain value transfer that *is* the wager. Also
   * doubles as the shuffle's client-seed entropy (see `@frank/wallet/message-item-plugins/blackjack`'s header) -- no
   * extra round trip needed to collect one. */
  wagerTxHash?: string
  /** `double` only: the tx hash of a *second* plain value transfer, matching the original wager --
   * a double-down doubles the bet in exchange for exactly one more card then an automatic stand,
   * and since the wager is never a self-reported field (see this type's own header), doubling it
   * needs a second independently-verified transfer, not just doubling a number client-side. */
  doubleWagerTxHash?: string
  /** `deal` only: the bot's commitment to its shuffle seed, generated and hashed *before* this
   * specific bet was ever seen (see `@frank/wallet/message-item-plugins/blackjack/deck.ts`'s header for why that
   * ordering is the entire fairness property this scheme relies on). */
  serverSeedHash?: string
  /** `deal`/`hit`/`double`: the player's full hand so far (always the complete cumulative hand,
   * not a diff from the previous message -- simpler to verify, and each message stays
   * self-contained). */
  playerCards?: number[]
  /** `deal` only: the dealer's single face-up card. */
  dealerUpCard?: number
  /** `stand`/`reveal`: the dealer's full hand once play resolves. */
  dealerCards?: number[]
  /** `reveal` only: the actual shuffle secret, published in plaintext so the player can
   * independently recompute the whole deck (`deriveDeck`) and confirm both the hash committed to
   * at `deal` and every card dealt since were exactly what a fair, undoctored shuffle would have
   * produced. */
  serverSeed?: string
  /** `reveal` only. */
  outcome?: 'player_win' | 'dealer_win' | 'push' | 'player_blackjack'
}

/**
 * A flat-price digital goods purchase against a vendor bot (ticket #63, "bot-driven ads / 1-click
 * purchase") -- simpler than `BlackjackMoveItem`'s case, since there's no fairness/randomness
 * protocol needed for "pay a fixed price, receive an item." No self-reported amount field on
 * `request` either, for the same reason as blackjack's `bet`: the price paid is that same
 * message's own real, relay-verified stamp value (`Message.stampValueWei`), never a number read
 * from this JSON payload. That's a deliberate difference from blackjack's wager, which needed a
 * *separate* transfer since a wager is a variable amount unsuited to doubling as the flat anti-spam
 * stamp fee -- a catalog item's price is naturally bounded and fixed, so it can just *be* the stamp.
 */
export interface DigitalGoodsItem {
  type: 'digital-goods'
  action: 'catalog' | 'request' | 'fulfill' | 'error'
  /** `catalog` only: what the vendor currently has for sale. */
  catalog?: Array<{ itemId: string; description: string; priceWei: string }>
  /** `request` only: which catalog item this message's own stamp payment is meant to buy. */
  itemId?: string
  /** `error` only: e.g. "payment below this item's price," "unknown itemId." */
  message?: string
}

/**
 * N-entrant, winner-takes-the-pot raffle against a bot (ticket TBD, "raffle bot demo"). Modeled
 * after `DigitalGoodsItem` for payment (a flat `entryPriceWei`, paid as that same message's own
 * relay-verified stamp -- no self-reported amount field, same reasoning as that type's own header)
 * and after `BlackjackMoveItem` for fairness (a `serverSeedHash` commitment published *before* the
 * round can know who its entrants will be, revealed at `draw` so anyone can independently replay
 * the winner selection -- see `@frank/wallet/message-item-plugins/raffle/draw.ts`).
 *
 * Deliberately winner-takes-100%-of-the-pot, no house cut and no bot-funded bonus on top: the only
 * money a `draw` ever pays out is `potWei`, which is arithmetically `entryPriceWei * entrants.length`
 * -- exactly what this round's entrants already paid in, nothing more. That's what makes a raffle
 * structurally undrainable in a way a bot that pays out from its own funds (e.g. a trivia bot
 * rewarding correct answers) is not: the payout can never exceed the collected pot because it *is*
 * the collected pot.
 */
export interface RaffleItem {
  type: 'raffle'
  raffleId: string
  action: 'announce' | 'enter' | 'joined' | 'draw' | 'error'
  /** `announce`/`joined`/`draw`: the flat price every entrant pays -- fixed for a round, verified
   * the same way `DigitalGoodsItem.priceWei` is (this message's own stamp value), never trusted
   * from a self-reported field on the wire. */
  entryPriceWei?: string
  /** `announce`/`joined`: how many entries this round takes before it closes and draws. */
  maxEntries?: number
  /** `announce`/`joined`: how many entries have been accepted so far, including this one for
   * `joined`. */
  entryCount?: number
  /** `announce`/`joined`: the bot's commitment to this round's draw seed -- generated and hashed
   * *before* this round accepted its first entry (see `@frank/wallet/message-item-plugins/raffle/draw.ts`'s header for
   * why that ordering is the entire fairness property this relies on). Same for every entrant in a
   * round. */
  serverSeedHash?: string
  /** `draw` only: the winning entrant's address. */
  winnerAddress?: string
  /** `draw` only: the actual draw secret, published in plaintext so anyone can independently
   * recompute `pickWinnerIndex` and confirm both the hash committed to earlier and the announced
   * winner were exactly what a fair, undoctored draw would have produced. */
  serverSeed?: string
  /** `draw` only: every entrant's address, in the order they joined -- needed (with
   * `entryTxHashes`) to independently replay the draw. */
  entrants?: string[]
  /** `draw` only: every entrant's own entry-payment transaction hash, same order as `entrants` --
   * this is what gets combined into the draw's client-seed entropy (see
   * `@frank/wallet/message-item-plugins/raffle/draw.ts`'s `combineEntrantEntropy`). */
  entryTxHashes?: string[]
  /** `draw` only: the total paid to the winner -- always `entryPriceWei * entrants.length`. */
  potWei?: string
  /** `error` only: e.g. "payment below this round's entry price," "already entered this round." */
  message?: string
}

export type MessageItem =
  | StealthItem
  | P2PKHSendItem
  | TextItem
  | ReplyItem
  | ImageItem
  | BlackjackMoveItem
  | DigitalGoodsItem
  | RaffleItem

export interface Message {
  outbound: boolean
  status: string
  receivedTime: number
  serverTime: number
  items: Array<MessageItem>
  outpoints: Array<Utxo>
  senderAddress: string
  /** Wei paid across this message's stamp transactions, for chains (Monad, ticket #42) that have no
   * UTXO/`outpoints` equivalent -- see `stores/chats.ts`'s header for the decision to add this
   * additively alongside `outpoints` rather than replace it. Always `undefined` for Lotus-origin
   * messages (`outpoints` is authoritative for those). */
  stampValueWei?: bigint
  /** Transaction details backing a non-UTXO chain's stamp payment. */
  stampPayments?: Array<{
    txHash: string
    destinationAddress: string
    valueWei: bigint
  }>
}

export interface MessageWrapper {
  message: Message
  index: string
  outbound: boolean
  senderAddress: string
  copartyAddress: string
}

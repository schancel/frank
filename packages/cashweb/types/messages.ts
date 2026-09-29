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
 * One move in a provably-fair blackjack hand against a bot dealer (see `@frank/wallet/blackjack`
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
  action: 'bet' | 'deal' | 'hit' | 'stand' | 'reveal'
  /** `bet` only: the tx hash of the separate plain value transfer that *is* the wager. Also
   * doubles as the shuffle's client-seed entropy (see `@frank/wallet/blackjack`'s header) -- no
   * extra round trip needed to collect one. */
  wagerTxHash?: string
  /** `deal` only: the bot's commitment to its shuffle seed, generated and hashed *before* this
   * specific bet was ever seen (see `@frank/wallet/blackjack/deck.ts`'s header for why that
   * ordering is the entire fairness property this scheme relies on). */
  serverSeedHash?: string
  /** `deal`/`hit`: the player's full hand so far (always the complete cumulative hand, not a diff
   * from the previous message -- simpler to verify, and each message stays self-contained). */
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

export type MessageItem =
  | StealthItem
  | P2PKHSendItem
  | TextItem
  | ReplyItem
  | ImageItem
  | BlackjackMoveItem

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

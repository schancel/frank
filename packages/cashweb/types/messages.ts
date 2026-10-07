import type {
  BlackjackHandV3Item,
  BlackjackItem,
  CanonicalChannelUpdateItem,
} from "@frank/codec";

import { Utxo } from "./utxo";

export interface ReplyItem {
  type: "reply";
  payloadDigest: string;
}

export interface TextItem {
  type: "text";
  text: string;
}

export interface P2PKHSendItem {
  type: "p2pkh";
  address: string;
  amount: number;
}

export interface StealthItem {
  type: "stealth";
  /** Network tag or identifier (e.g. 'MONT', 'MON1', 'SOLD', 'SOL1', 'XECT', 'XEC1', 'monad-testnet', or CAIP-2). */
  networkTag?: string;
  /** Key type identifying the curve family: 1 = secp256k1, 2 = ed25519. */
  keyType?: 1 | 2;
  /** Hex-encoded ephemeral public key used to derive the one-time stealth destination address and secret key. */
  ephemeralPubKey?: string;
  /** Hex-encoded raw transactions or transaction hashes. */
  transactions?: string[];
  /** Transferred value / amount */
  amount: number;
  /** Optional transaction memo. */
  memo?: string;

  /** @deprecated Use networkTag instead. */
  chainId?: string;
  /** @deprecated Use transactions array instead. */
  rawTx?: string;
  /** @deprecated Use transactions array instead. */
  solanaTx?: string;
  /** UTXO-specific outpoint fields (Lotus / eCash compatibility). */
  txId?: string;
  outputIndex?: number;
}

export interface ImageItem {
  type: "image";
  image: string;
}

/** One message of a peer-to-peer blackjack hand (type 18, schema 3). It carries no amount (a
 * wager, payout or refund is the stamp of the message) and no card: both sides compute the cards
 * from the entropy links the hand's messages open. See docs/protocol/blackjack-p2p.md. */
export type BlackjackHandItem = BlackjackHandV3Item;

/** Closed type18 shapes for explicit canonical consumers; no payment or actor authority. */
export type CanonicalBlackjackMoveItem = BlackjackItem;

/** Universal state channel update item (Type 24, #949/#950/#965). */
export type ChannelUpdateItem = CanonicalChannelUpdateItem;

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
  type: "blackjack-move";
  gameId: string;
  action: "bet" | "deal" | "hit" | "stand" | "double" | "reveal" | "welcome";
  /** `bet` only: the tx hash of the separate plain value transfer that *is* the wager. Also
   * doubles as the shuffle's client-seed entropy (see `@frank/wallet/message-item-plugins/blackjack`'s header) -- no
   * extra round trip needed to collect one. */
  wagerTxHash?: string;
  /** `double` only: the tx hash of a *second* plain value transfer, matching the original wager --
   * a double-down doubles the bet in exchange for exactly one more card then an automatic stand,
   * and since the wager is never a self-reported field (see this type's own header), doubling it
   * needs a second independently-verified transfer, not just doubling a number client-side. */
  doubleWagerTxHash?: string;
  /** `deal` only: the bot's commitment to its shuffle seed, generated and hashed *before* this
   * specific bet was ever seen (see `@frank/wallet/message-item-plugins/blackjack/deck.ts`'s header for why that
   * ordering is the entire fairness property this scheme relies on). */
  serverSeedHash?: string;
  /** `deal`/`hit`/`double`: the player's full hand so far (always the complete cumulative hand,
   * not a diff from the previous message -- simpler to verify, and each message stays
   * self-contained). */
  playerCards?: number[];
  /** `deal` only: the dealer's single face-up card. */
  dealerUpCard?: number;
  /** `stand`/`reveal`: the dealer's full hand once play resolves. */
  dealerCards?: number[];
  /** `reveal` only: the actual shuffle secret, published in plaintext so the player can
   * independently recompute the whole deck (`deriveDeck`) and confirm both the hash committed to
   * at `deal` and every card dealt since were exactly what a fair, undoctored shuffle would have
   * produced. */
  serverSeed?: string;
  /** `reveal` only. */
  outcome?: "player_win" | "dealer_win" | "push" | "player_blackjack";
  /** `welcome` only (dealer to player, #395): the table's minimum wager, a decimal wei string.
   * Untrusted advertising: the client parses it strictly (`parseBlackjackWelcome`) and the
   * dealer enforces its own limits regardless. */
  minWagerWei?: string;
  /** `welcome` only: the table's maximum wager, a decimal wei string. */
  maxWagerWei?: string;
  /** `welcome` only: hint, in wei, of what sending a bet message costs beyond the wager (its stamp
   * plus fees). A client that already assumes more keeps its own figure. */
  feeHintWei?: string;
  /** `welcome` only: a short plain-text summary of the house rules. */
  rules?: string;
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
  type: "digital-goods";
  action: "catalog" | "request" | "fulfill" | "error";
  /** `catalog` only: what the vendor currently has for sale. */
  catalog?: Array<{
    itemId: string;
    description: string;
    priceWei: string;
    /** Optional small `data:image/...;base64,...` preview shown next to the entry. Clients render
     * it only when it is such a data URI, never a remote URL (a URL would leak the viewer). */
    thumbnail?: string;
  }>;
  /** `request` only: which catalog item this message's own stamp payment is meant to buy. */
  itemId?: string;
  /** `error` only: e.g. "payment below this item's price," "unknown itemId." */
  message?: string;
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
  type: "raffle";
  raffleId: string;
  action: "announce" | "enter" | "joined" | "draw" | "error";
  /** `announce`/`joined`/`draw`: the flat price every entrant pays -- fixed for a round, verified
   * the same way `DigitalGoodsItem.priceWei` is (this message's own stamp value), never trusted
   * from a self-reported field on the wire. */
  entryPriceWei?: string;
  /** `announce`/`joined`: how many entries this round takes before it closes and draws. */
  maxEntries?: number;
  /** `announce`/`joined`: how many entries have been accepted so far, including this one for
   * `joined`. */
  entryCount?: number;
  /** `announce`/`joined`: the bot's commitment to this round's draw seed -- generated and hashed
   * *before* this round accepted its first entry (see `@frank/wallet/message-item-plugins/raffle/draw.ts`'s header for
   * why that ordering is the entire fairness property this relies on). Same for every entrant in a
   * round. */
  serverSeedHash?: string;
  /** `draw` only: the winning entrant's address. */
  winnerAddress?: string;
  /** `draw` only: the actual draw secret, published in plaintext so anyone can independently
   * recompute `pickWinnerIndex` and confirm both the hash committed to earlier and the announced
   * winner were exactly what a fair, undoctored draw would have produced. */
  serverSeed?: string;
  /** `draw` only: every entrant's address, in the order they joined -- needed (with
   * `entryTxHashes`) to independently replay the draw. */
  entrants?: string[];
  /** `draw` only: every entrant's own entry-payment transaction hash, same order as `entrants` --
   * this is what gets combined into the draw's client-seed entropy (see
   * `@frank/wallet/message-item-plugins/raffle/draw.ts`'s `combineEntrantEntropy`). */
  entryTxHashes?: string[];
  /** `draw` only: the total paid to the winner -- always `entryPriceWei * entrants.length`. */
  potWei?: string;
  /** `error` only: e.g. "payment below this round's entry price," "already entered this round." */
  message?: string;
}

export interface SwapOfferItem {
  type: "swap-offer";
  swapId: string;
  offeredChain: string;
  offeredAsset: string;
  offeredAmount: string;
  requestedChain: string;
  requestedAsset: string;
  requestedAmount: string;
  status: "pending" | "accepted" | "settled" | "cancelled" | "expired";
  initiatorAddress?: string;
  recipientAddress?: string;
  createdAt: number;
  expiresAt?: number;
  hashLock?: string;
  preimage?: string;
  legATxHash?: string;
  legBTxHash?: string;
  claimTxHash?: string;
  originInstanceId?: string;
}

export interface DeviceClaimItem {
  type: "device-claim";
  instanceId: string;
  deviceName?: string;
  claimedAt: number;
  leaseDurationMs?: number;
}

export interface RpsItem {
  type: "rps";
  action: "challenge" | "start" | "move" | "resolve";
  matchId?: string;
  commitHash?: string;
  playerMove?: "rock" | "paper" | "scissors";
  botMove?: "rock" | "paper" | "scissors";
  secretSalt?: string;
  wagerWei?: string;
  outcome?: "win" | "lose" | "tie";
  txHash?: string;
  opponentAddress?: string;
}

export interface SatoshiDiceItem {
  type: "dice";
  action: "table" | "roll" | "result";
  rollId?: string;
  target?: number;
  multiplier?: number;
  wagerWei?: string;
  luckyNumber?: number;
  isWin?: boolean;
  serverSecret?: string;
  userNonce?: string;
  payoutWei?: string;
  txHash?: string;
}

export interface LiarsDiceItem {
  type: "liars-dice";
  tableId: string;
  action:
    | "create"
    | "join"
    | "round_start"
    | "bid"
    | "challenge"
    | "showdown"
    | "settle";
  /** Buy-in required in wei per player. */
  buyInWei?: string;
  /** Maximum number of players allowed at table (default: 4). */
  maxPlayers?: number;
  /** Initial dice count per player (default: 5). */
  dicePerPlayer?: number;
  /** Addresses of joined players. */
  players?: string[];
  /** Remaining dice counts for each player, parallel to players array. */
  diceCounts?: number[];
  /** Active round number (1-indexed). */
  roundNumber?: number;
  /** Address of player whose turn it is to bid or challenge. */
  activePlayer?: string;
  /** Time remaining in seconds for active player's turn. */
  turnTimeoutSeconds?: number;
  /** Current highest bid. */
  currentBid?: {
    bidder: string;
    quantity: number;
    face: number; // 1 to 6
  };
  /** The challenger's address (when action === 'challenge'). */
  challenger?: string;
  /** Server's hash commitment for this round's server entropy. */
  serverCommit?: string;
  /** Revealed server entropy secret (at showdown). */
  serverSeed?: string;
  /** Player entropy hash commitments for this round. */
  playerCommits?: Record<string, string>;
  /** Revealed player secrets at showdown (player address -> seed). */
  playerSeeds?: Record<string, string>;
  /** Secret dice for the local player (during bidding, decrypted/known only to local player). */
  myDice?: number[];
  /** Revealed dice cups for all players at showdown (player address -> array of dice faces 1..6). */
  revealedCups?: Record<string, number[]>;
  /** Result of challenge at showdown. */
  challengeResult?: {
    bidQuantity: number;
    bidFace: number;
    actualCount: number;
    wildAcesCount: number;
    challengerWon: boolean;
    loserAddress: string;
    eliminated: boolean;
  };
  /** Final winner of the table game. */
  winnerAddress?: string;
  /** Total pot in wei awarded to winner. */
  potWei?: string;
  /** Optional transaction hash or stealth payout details for settlement. */
  txHash?: string;
  stealthAddress?: string;
}

export type PokerStreet =
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown"
  | "settled";
export type PokerActionType =
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "fold"
  | "all_in";

export interface PokerPlayerView {
  address: string;
  chips: number;
  currentStreetBet: number;
  totalHandBet: number;
  folded: boolean;
  isAllIn: boolean;
  isDealerButton: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  holeCards?: number[];
}

export interface PokerItem {
  type: "poker";
  tableId: string;
  action: "create" | "join" | "deal" | "action" | "showdown" | "settle";
  buyInWei?: string;
  smallBlind: number;
  bigBlind: number;
  street?: PokerStreet;
  pot: number;
  sidePots?: Array<{ amount: number; eligiblePlayers: string[] }>;
  currentBet?: number;
  minRaise?: number;
  activePlayer?: string;
  boardCards?: number[];
  players?: PokerPlayerView[];
  myHoleCards?: number[];
  lastAction?: {
    player: string;
    action: PokerActionType;
    amount?: number;
  };
  winners?: Array<{
    address: string;
    amount: number;
    handDescription?: string;
    best5Cards?: number[];
  }>;
  winnerAddress?: string;
  txHash?: string;
  stealthAddress?: string;
}

export type MessageItem =
  | StealthItem
  | P2PKHSendItem
  | TextItem
  | ReplyItem
  | ImageItem
  | BlackjackMoveItem
  | BlackjackHandItem
  | DigitalGoodsItem
  | RaffleItem
  | SwapOfferItem
  | DeviceClaimItem
  | RpsItem
  | SatoshiDiceItem
  | LiarsDiceItem
  | PokerItem
  | ChannelUpdateItem;

/** Why an outgoing direct message is not (yet) delivered (tickets #269/#270). Persisted with the
 * message so the failure and its manual Retry survive a reload. */
export type OutgoingFailureReason =
  /** The relay could not be reached or kept failing. Nothing was paid for; retry is safe. */
  | "unreachable"
  /** The relay has no messaging mailbox (404). Nothing was sent; retry is safe once it does. */
  | "unavailable"
  /** The relay refused the message for good (400/409/422...). The old payment can never land. */
  | "rejected"
  /** The app stopped while this was sending and no payment attempt was recorded for it. */
  | "interrupted"
  /** A payment attempt exists but neither delivery nor death of it could be established. A retry
   * may pay a second time, so it needs the user's explicit confirmation. */
  | "unverified"
  /** Another, earlier payment attempt completed while this one was being prepared, so this
   * draft may duplicate it. A retry needs the user's explicit confirmation. */
  | "recovered"
  /** The wallet could not prepare the message's stamp because the account lacks funds. */
  | "insufficient-funds"
  | "error";

/** Delivery bookkeeping for an outgoing (`outbound`) direct message that is not yet confirmed. */
export interface OutgoingDelivery {
  /** Bare-hex payload hash of the exact signed payment set built for this message, recorded
   * before that set is first submitted. While this attempt is live, a retry re-sends the same
   * bytes and never builds a new payment. Absent until a payment set exists. */
  attemptDigest?: string;
  /** Set on `status: 'error'`. */
  failureReason?: OutgoingFailureReason;
  /** Short technical detail for the failure (not localized). */
  detail?: string;
  /** In-memory only, never persisted: the wallet confirmed this session that the attempt is
   * still live (so "you will not be charged again" is true). Absent after a reload until the
   * first reconcile. */
  live?: boolean;
}

export interface Message {
  outbound: boolean;
  status: string;
  receivedTime: number;
  serverTime: number;
  items: Array<MessageItem>;
  outpoints: Array<Utxo>;
  senderAddress: string;
  /** Wei paid across this message's stamp transactions, for chains (Monad, ticket #42) that have no
   * UTXO/`outpoints` equivalent -- see `stores/chats.ts`'s header for the decision to add this
   * additively alongside `outpoints` rather than replace it. Always `undefined` for Lotus-origin
   * messages (`outpoints` is authoritative for those). */
  stampValueWei?: bigint;
  /** Transaction details backing a non-UTXO chain's stamp payment. */
  stampPayments?: Array<{
    txHash: string;
    destinationAddress: string;
    valueWei: bigint;
  }>;
  /** Present only while an outgoing message is unconfirmed. `status` is then `'pending'`
   * (sending), `'payment-pending'` (payment not yet confirmed; retried automatically with the same
   * bytes) or `'error'` (failed; the user may Retry or Discard). */
  delivery?: OutgoingDelivery;
}

export interface MessageWrapper {
  message: Message;
  index: string;
  outbound: boolean;
  senderAddress: string;
  copartyAddress: string;
}

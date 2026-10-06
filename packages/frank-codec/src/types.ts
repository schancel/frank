// Typed projections of the payload schemas in docs/protocol/cbor/*.cddl (schema version 1,
// type-4 schemas 1-3 and explicitly opted-in provisional schema 4).
//
// `F` is the representation of a required-type framed field (the opened child frame once
// validated, raw bytes in a draft) and `C` that of an open-field child.
import type { FrankValue } from './cbor'

export type UnknownFields = ReadonlyMap<bigint, FrankValue>

export interface AccountRef {
  keyType: number
  keyBytes: Uint8Array
}

export interface Timestamp {
  seconds: bigint
  nanoseconds: number
}

export interface PaymentMember {
  childIndex: number
  transactionId: Uint8Array
  /** 32-byte big-endian EVM quantity (C8) or satoshi uint64 bigint. */
  value: Uint8Array | bigint
  address: Uint8Array
  commitment: Uint8Array
  /** Optional UTXO output index (vout). */
  vout?: number
}

export interface SignatureEntry {
  algorithm: number
  signer: AccountRef
  signature: Uint8Array
}

export interface RelayBinding {
  relayId: Uint8Array
  endpoint: string
  identity: AccountRef
  expiry: Timestamp
  unknownFields: UnknownFields
}

/** One header of a profile entry (M4): the protobuf name/value set as a C11-sorted list. */
export interface ProfileHeader {
  name: string
  value: string
  unknownFields: UnknownFields
}

/** One migrated AddressEntry (M4): authored array order is preserved, never resorted. */
export interface ProfileEntry {
  kind: string
  headers: ProfileHeader[]
  body: Uint8Array
  unknownFields: UnknownFields
}

export interface KeyTransition<F> {
  /** The type-7 key-transition-statement frame. */
  statementFrame: F
  algorithm: number
  signer: AccountRef
  signature: Uint8Array
  unknownFields: UnknownFields
}

export interface JournalFact {
  timestamp: Timestamp
  factId: Uint8Array
  kind: number
  /** Opaque in version 1: retained exactly, never interpreted (README section 6). */
  payload: Uint8Array
  unknownFields: UnknownFields
}

export interface OpaqueSection {
  sectionType: number
  sectionSchemaVersion: number
  /** Retained exactly; never opened in version 1, even if it holds a Frank frame. */
  value: Uint8Array
}

export interface DirectMessageDelivery<F> {
  type: 1
  network: string
  destination: AccountRef
  /** The type-5 recipient-encrypted-payload frame. */
  payloadFrame: F
  /** T3 digest of the exact field-2 frame, as encoded (not verified at stages 1-9). */
  payloadDigest: Uint8Array
  payments: PaymentMember[]
  /** Optional long-term recipient identity P (key type 1). */
  recipient?: AccountRef
  /** Optional Chaum-Pedersen DLEQ proof (64 bytes). */
  dleqProof?: Uint8Array
  unknownFields: UnknownFields
}

export interface DirectoryAttestation<F> {
  type: 2
  /** The type-4 directory-statement frame. */
  statementFrame: F
  signatures: SignatureEntry[]
  unknownFields: UnknownFields
}

export interface MailboxCheckpoint {
  type: 3
  network: string
  owner: AccountRef
  checkpointId: Uint8Array
  timestamp: Timestamp
  facts: JournalFact[]
  sections?: OpaqueSection[]
  unknownFields: UnknownFields
}

export interface DirectoryStatement<F> {
  type: 4
  network: string
  subject: AccountRef
  revision: bigint
  timestamp: Timestamp
  relays: RelayBinding[]
  keyTransitions?: KeyTransition<F>[]
  expiry?: Timestamp
  recoveryAuthorities?: AccountRef[]
  /** The frame's envelope `schema_version`, kept for the S10a.2 same-subject schema order. */
  schemaVersion: number
  /** Field 8, the stamp key `P'` (S10a.1). Required from schema 2, undefined in schema 1. */
  stampKey?: AccountRef
  /** Field 9, the migrated profile entries (M4); absent when empty. Schema 3 only. */
  profileEntries?: ProfileEntry[]
  /** Provisional schema-4 roles; absent in schemas 1–3. */
  preview?: PreviewDirectoryRoles
  /** Advertised curve spend keys (field 14). */
  spendKeys?: AccountRef[]
  unknownFields: UnknownFields
}

/** Required schema-4 fields, never inferred from the subject or a profile. */
export interface PreviewDirectoryRoles {
  messageDhKey: AccountRef
  mailboxKeyGeneration: bigint
  stampKeyGeneration: bigint
  predecessor: Uint8Array | null
}

interface RecipientEncryptedPayloadCommon {
  type: 5
  network: string
  sender: AccountRef
  recipient: AccountRef
  suite: number
  /** Field 5 in schema 2, `E = e*G`; field 6 in legacy proof schema 1. */
  ephemeralPoint: Uint8Array
  /** Field 6 in schema 2, `X = e*P'`; field 7 in legacy proof schema 1. */
  sharedPoint: Uint8Array
  /** Field 7 in schema 2; field 8 in legacy proof schema 1. */
  dleqProof: Uint8Array
  unknownFields: UnknownFields
}

export interface RecipientEncryptedPayloadV1
  extends RecipientEncryptedPayloadCommon {
  readonly schemaVersion: 1
  nonce: Uint8Array
  ciphertext: Uint8Array
}

export interface RecipientEncryptedPayloadV2
  extends RecipientEncryptedPayloadCommon {
  readonly schemaVersion: 2
  /** Field 4: the complete deterministic-CBOR crypto-box v2 envelope. */
  cryptoBoxEnvelope: Uint8Array
}

export type RecipientEncryptedPayload =
  | RecipientEncryptedPayloadV1
  | RecipientEncryptedPayloadV2

export interface EncryptedMessageContent<F> {
  type: 6
  network: string
  messageId: Uint8Array
  /** The type-8 message-content-revision frame. */
  revisionFrame: F
  contentDigest: Uint8Array
  unknownFields: UnknownFields
}

export interface KeyTransitionStatement {
  type: 7
  network: string
  subject: AccountRef
  priorAuthority: AccountRef
  revision: bigint
  newKey: AccountRef
  unknownFields: UnknownFields
}

interface TopicPostCommon {
  type: 9
  network: string
  /** Exact UTF-8, never normalized (S12). */
  topic: string
  /** T1 hash of the parent type-9 frame; absent for a top-level post. */
  parentHash?: Uint8Array
  /** Opaque in version 1. */
  body: Uint8Array
  unknownFields: UnknownFields
}

export type ForumEntry =
  | {
      kind: 'post'
      title?: string
      url?: string
      message?: string
      unknownFields: UnknownFields
    }
  | {
      kind: 'unsupported'
      kindId: bigint
      placeholder: 'Unsupported content'
      fields: UnknownFields
    }

export interface ForumContent {
  authored: Timestamp
  entries: ForumEntry[]
  unknownFields: UnknownFields
}

/** Schema 1 is always opaque, even when its bytes happen to contain CBOR. */
export type TopicPost<C = ForumContent> = TopicPostCommon &
  ({ schemaVersion: 1; content?: never } | { schemaVersion: 2; content: C })

export interface ForumAggregate {
  negative: boolean
  /** Exact unsigned 256-bit big-endian magnitude. */
  magnitude: Uint8Array
}

interface ForumCursorCommon {
  bytes: Uint8Array
  network: string
  revision: bigint
  epoch: Uint8Array
  incarnation: bigint
}
export type ForumCursor = ForumCursorCommon &
  (
    | {
        family: 13
        topic: string
        since: Timestamp
        last: { timestamp: Timestamp; hash: Uint8Array }
      }
    | { family: 14; last: string }
  )

export interface ForumView<F> {
  type: 12
  network: string
  postFrame: F
  author: Uint8Array
  authorBurnTx: Uint8Array
  transactionHash: Uint8Array
  firstVisible: Timestamp
  block: bigint
  transactionIndex: bigint
  aggregate: ForumAggregate
  revision: bigint
  epoch: Uint8Array
  unknownFields: UnknownFields
}
export interface ForumTopicPage<F, K = ForumCursor> {
  type: 13
  network: string
  topic: string
  since: Timestamp
  revision: bigint
  rows: F[]
  nextCursor?: K
  requestCursor?: K
  epoch: Uint8Array
  unknownFields: UnknownFields
}
export interface ForumDiscoveryEntry {
  topic: string
  count: bigint
  lastActivity: Timestamp
  unknownFields: UnknownFields
}
export interface ForumDiscoveryPage<K = ForumCursor> {
  type: 14
  network: string
  revision: bigint
  entries: ForumDiscoveryEntry[]
  nextCursor?: K
  requestCursor?: K
  epoch: Uint8Array
  unknownFields: UnknownFields
}
interface ForumOperationCommon<F> {
  type: 15
  network: string
  submittedFrame: F
  targetHash: Uint8Array
  transactionHash: Uint8Array
  sender: Uint8Array
  direction: 0 | 1
  value: bigint
  revision: bigint
  epoch: Uint8Array
  unknownFields: UnknownFields
}
/** Classification is a relay claim, never transaction verification or wallet authority. */
export type ForumOperationStatus<F> = ForumOperationCommon<F> &
  (
    | {
        state: 0 | 3
        evidence: 'unverified-request'
        block?: never
        transactionIndex?: never
      }
    | {
        state: 1
        evidence: 'relay-observed'
        block?: never
        transactionIndex?: never
      }
    | {
        state: 2
        evidence: 'relay-observed'
        block: bigint
        transactionIndex: bigint
      }
  )

export interface TopicPostSubmission<F> {
  type: 10
  network: string
  /** The type-9 topic-post frame. */
  postFrame: F
  /** Raw signed chain transaction that burns for the post (T7, T8). */
  burnTx: Uint8Array
  unknownFields: UnknownFields
}

export interface TopicVoteSubmission {
  type: 11
  network: string
  /** T1 hash of the target type-9 frame. */
  targetHash: Uint8Array
  /** Raw signed chain transaction that burns for the vote (T7, T8). */
  burnTx: Uint8Array
  unknownFields: UnknownFields
}

export interface MessageContentRevision<C> {
  type: 8
  items: C[]
  unknownFields: UnknownFields
}

export interface ContainerMessageItem<C> {
  type: 16
  items: C[]
  unknownFields: UnknownFields
}

export interface TextMessageItem {
  type: 17
  text: string
  unknownFields: UnknownFields
}

export interface StealthMessageItem {
  type: 19
  networkTag: string
  ephemeralPubKey: AccountRef
  transactions: Uint8Array[]
  amount: bigint
  memo?: string
  unknownFields: UnknownFields
}

export interface ParticipantBalance {
  participant: AccountRef
  /** 32-byte big-endian EVM quantity (C8) or satoshi / native uint64 bigint. */
  balance: Uint8Array | bigint
}

export interface ChainAllocation {
  networkTag: string
  /** Empty for native currency, or token identifier bytes. */
  token: Uint8Array
  balances: ParticipantBalance[]
}

export interface ChannelUpdateItem {
  type: 24
  channelId: Uint8Array
  appId: string
  sequenceNumber: number
  allocations: ChainAllocation[]
  appState: Uint8Array
  signatures: SignatureEntry[]
  settlementRef?: Uint8Array
  unknownFields: UnknownFields
}

export type DiceAction = 'commit' | 'reveal' | 'roll'

export interface DiceGamePayload {
  round: number | bigint
  action: DiceAction
  seedCommitment: Uint8Array
  revealSeed?: Uint8Array
  targetRoll?: number
  wager: Uint8Array | bigint
  unknownFields?: UnknownFields
}

export interface PokerGamePayload {
  handId: Uint8Array
  phase: string
  action: string
  cardCommitments?: Uint8Array[]
  keys?: Uint8Array[]
  unknownFields?: UnknownFields
}

export interface SwapOfferPayload {
  swapId: Uint8Array
  makerAsset: Uint8Array
  makerAmount: Uint8Array | bigint
  takerAsset: Uint8Array
  takerAmount: Uint8Array | bigint
  expiration: number | bigint
  htlcHash?: Uint8Array
  unknownFields?: UnknownFields
}

export interface RafflePayload {
  raffleId: Uint8Array
  ticketPrice: Uint8Array | bigint
  ticketsSold: number | bigint
  winningHash?: Uint8Array
  unknownFields?: UnknownFields
}


/** The nine closed blackjack shapes. H and Q distinguish wire bytes from presentation text. */
export type BlackjackFields<H, Q> = { gameId: string } & (
  | { action: 'bet'; wagerTxHash: H }
  | {
      action: 'deal'
      serverSeedHash: H
      playerCards: readonly number[]
      dealerUpCard: number
    }
  | { action: 'hit'; playerCards?: never }
  | { action: 'hit'; playerCards: readonly number[] }
  | { action: 'stand' }
  | { action: 'double'; doubleWagerTxHash: H; playerCards?: never }
  | {
      action: 'double'
      playerCards: readonly number[]
      doubleWagerTxHash?: never
    }
  | {
      action: 'reveal'
      dealerCards: readonly number[]
      serverSeed: string
      outcome: 'player_win' | 'dealer_win' | 'push' | 'player_blackjack'
    }
  | {
      action: 'welcome'
      minWagerWei: Q
      maxWagerWei: Q
      feeHintWei?: Q
      rules?: string
    }
)

/** Closed type-18 projection; exact frame bytes remain on the enclosing ParsedFrame. */
export type BlackjackMessageItem = { type: 18; schema?: never } & BlackjackFields<
  Uint8Array,
  Uint8Array
>

/** The ten closed schema-2 shapes of a peer-to-peer hand (docs/protocol/blackjack-p2p.md).
 * No shape carries an amount of money: a wager, payout or refund is the message's own stamp. */
export type BlackjackHandFields<H, Q> = { gameId: string } & (
  | { action: 'challenge'; role: 'dealer'; maxBetWei: Q; commitment: H }
  | { action: 'challenge'; role: 'player'; maxBetWei: Q; commitment?: never }
  | { action: 'accept'; maxBetWei: Q; commitment: H }
  | { action: 'bet' }
  | {
      action: 'deal'
      playerCards: readonly number[]
      dealerUpCard: number
    }
  | { action: 'hit' }
  | { action: 'stand' }
  | { action: 'double' }
  | { action: 'card'; playerCards: readonly number[] }
  | {
      action: 'reveal'
      dealerCards: readonly number[]
      seed: string
      outcome: 'player_win' | 'dealer_win' | 'push' | 'player_blackjack'
    }
  | { action: 'refund'; ref: H }
)

/** Closed type-18 schema-2 projection. */
export type BlackjackHandMessageItem = {
  type: 18
  schema: 2
} & BlackjackHandFields<Uint8Array, Uint8Array>

/** The ten closed schema-3 shapes of a peer-to-peer hand with entropy from both sides
 * (docs/protocol/blackjack-p2p.md). No shape states a card or an outcome: both sides compute them
 * from the links opened so far. `seq` and `prev` chain the hand's messages: `seq` counts the
 * messages before this one, `prev` is the payload digest of the previous one. A challenge is
 * message 0 and has no `prev`. No shape carries an amount of money. */
export type BlackjackHandV3Fields<H, Q> = { gameId: string; seq: number } & (
  | {
      action: 'challenge'
      role: 'dealer'
      maxBetWei: Q
      commitment: H
      prev?: never
    }
  | {
      action: 'challenge'
      role: 'player'
      maxBetWei: Q
      commitment?: never
      prev?: never
    }
  | { action: 'accept'; maxBetWei: Q; commitment: H; prev: H }
  | { action: 'bet'; commitment: H; prev: H }
  | {
      action: 'deal' | 'hit' | 'stand' | 'double' | 'card' | 'reveal'
      link: H
      prev: H
    }
  | { action: 'refund'; ref: H; prev: H }
)

/** Closed type-18 schema-3 projection. */
export type BlackjackHandV3MessageItem = {
  type: 18
  schema: 3
} & BlackjackHandV3Fields<Uint8Array, Uint8Array>

export type TypedPayload<F, C, P = ForumContent, K = ForumCursor> =
  | DirectMessageDelivery<F>
  | DirectoryAttestation<F>
  | MailboxCheckpoint
  | DirectoryStatement<F>
  | RecipientEncryptedPayload
  | EncryptedMessageContent<F>
  | KeyTransitionStatement
  | TopicPost<P>
  | TopicPostSubmission<F>
  | TopicVoteSubmission
  | ForumView<F>
  | ForumTopicPage<F, K>
  | ForumDiscoveryPage<K>
  | ForumOperationStatus<F>
  | MessageContentRevision<C>
  | ContainerMessageItem<C>
  | TextMessageItem
  | BlackjackMessageItem
  | BlackjackHandMessageItem
  | BlackjackHandV3MessageItem
  | StealthMessageItem
  | ChannelUpdateItem

/** Why a frame was kept only as opaque bytes. */
export type RetentionReason =
  | 'unknown-type'
  | 'unsupported-frame-version'
  | 'unsupported-min-reader'

/** An exact, uninterpreted frame. The bytes are never reconstructed (E4, V4). */
export interface RetainedFrame {
  kind: 'retained'
  reason: RetentionReason
  frame: Uint8Array
  /** Present unless the envelope was never read (an unsupported frame version). */
  typeId?: number
  schemaVersion?: number
  minReaderVersion?: number
}

/** A frame that passed the stages required by the requested operation. */
export interface ParsedFrame {
  kind: 'parsed'
  /** The exact original frame bytes, header included. Do not mutate; never re-encode. */
  frame: Uint8Array
  typeId: number
  schemaVersion: number
  minReaderVersion: number
  /** The exact payload item bytes. */
  payloadBytes: Uint8Array
  /** The generic decoded payload item. */
  payload: FrankValue
  /**
   * `exact` when the schema version is supported (V6.2), `newer-schema` when a newer schema is
   * read through the reader's highest supported projection (V6.3).
   */
  projection: 'exact' | 'newer-schema'
  /** Present when the requested operation reached stage 8 (typed). */
  typed?: FinalPayload
}

export type ChildFrame = ParsedFrame | RetainedFrame
export type FinalPayload = TypedPayload<ParsedFrame, ChildFrame>
export type DraftPayload = TypedPayload<
  Uint8Array,
  Uint8Array,
  Uint8Array,
  Uint8Array
>

/** Result of `operation: 'frame'`: stages 1-4 passed. */
export interface FrameOnly {
  kind: 'frame'
  frame: Uint8Array
  version: number
  body: Uint8Array
}

export type ValidationResult = FrameOnly | ParsedFrame | RetainedFrame

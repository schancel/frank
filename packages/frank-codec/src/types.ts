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
  /** 32-byte big-endian EVM quantity (C8). */
  value: Uint8Array
  address: Uint8Array
  commitment: Uint8Array
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

export interface TopicPost {
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

export type TypedPayload<F, C> =
  | DirectMessageDelivery<F>
  | DirectoryAttestation<F>
  | MailboxCheckpoint
  | DirectoryStatement<F>
  | RecipientEncryptedPayload
  | EncryptedMessageContent<F>
  | KeyTransitionStatement
  | TopicPost
  | TopicPostSubmission<F>
  | TopicVoteSubmission
  | MessageContentRevision<C>
  | ContainerMessageItem<C>
  | TextMessageItem

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
export type DraftPayload = TypedPayload<Uint8Array, Uint8Array>

/** Result of `operation: 'frame'`: stages 1-4 passed. */
export interface FrameOnly {
  kind: 'frame'
  frame: Uint8Array
  version: number
  body: Uint8Array
}

export type ValidationResult = FrameOnly | ParsedFrame | RetainedFrame

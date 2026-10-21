// Stage 8.1 (type-specific limits), 8.2 (CDDL structure and ranges) and 8.3 (allocated
// identifiers) for the version-1 payload schemas.
import { DEFAULT_FEATURE_CODEC_MAP } from './blackjack-schema'
import type { FrankValue } from './cbor'
import {
  ACCOUNT_REF,
  ACCOUNT_REF_SHAPE,
  CHAIN_ALLOCATION,
  CHAIN_ALLOCATION_SHAPE,
  CHANNEL_UPDATE_ITEM,
  CHANNEL_UPDATE_ITEM_SHAPE,
  CONTAINER_MESSAGE_ITEM,
  CONTAINER_MESSAGE_ITEM_SHAPE,
  DIRECTORY_ATTESTATION,
  DIRECTORY_ATTESTATION_SHAPE,
  DIRECTORY_STATEMENT,
  DIRECTORY_STATEMENT_V1_SHAPE,
  DIRECTORY_STATEMENT_V2_SHAPE,
  DIRECTORY_STATEMENT_V3_SHAPE,
  DIRECTORY_STATEMENT_V4_SHAPE,
  DIRECT_MESSAGE_DELIVERY,
  DIRECT_MESSAGE_DELIVERY_V1_SHAPE,
  DIRECT_MESSAGE_DELIVERY_V2_SHAPE,
  EMAIL_ATTACHMENT,
  EMAIL_ATTACHMENT_SHAPE,
  EMAIL_MESSAGE_ITEM,
  EMAIL_MESSAGE_ITEM_SHAPE,
  EMAIL_PARTY,
  EMAIL_PARTY_SHAPE,
  ENCRYPTED_MESSAGE_CONTENT,
  ENCRYPTED_MESSAGE_CONTENT_SHAPE,
  ENCRYPTION_SUITE_DM_AUTH_XCHACHA,
  ENCRYPTION_SUITE_PROOF,
  FORUM_AGGREGATE,
  FORUM_AGGREGATE_SHAPE,
  FORUM_CONTENT,
  FORUM_CONTENT_SHAPE,
  FORUM_CURSOR_LAST,
  FORUM_CURSOR_LAST_SHAPE,
  FORUM_DISCOVERY_CURSOR,
  FORUM_DISCOVERY_CURSOR_SHAPE,
  FORUM_DISCOVERY_ENTRY,
  FORUM_DISCOVERY_ENTRY_SHAPE,
  FORUM_DISCOVERY_PAGE,
  FORUM_DISCOVERY_PAGE_SHAPE,
  FORUM_ENTRY,
  FORUM_ENTRY_KIND,
  FORUM_GAME_ENTRY,
  FORUM_GAME_ENTRY_SHAPE,
  FORUM_OPERATION_STATE,
  FORUM_OPERATION_STATUS,
  FORUM_OPERATION_STATUS_SHAPE,
  FORUM_POST_ENTRY,
  FORUM_POST_ENTRY_SHAPE,
  FORUM_SINGLE_VIEW,
  FORUM_SINGLE_VIEW_SHAPE,
  FORUM_TOPIC_CURSOR,
  FORUM_TOPIC_CURSOR_SHAPE,
  FORUM_TOPIC_PAGE,
  FORUM_TOPIC_PAGE_SHAPE,
  FORWARDING_DELIVERY_ENVELOPE,
  FORWARDING_DELIVERY_ENVELOPE_SHAPE,
  I64_MAX,
  I64_MIN,
  JOURNAL_FACT,
  JOURNAL_FACT_SHAPE,
  KEY_TRANSITION,
  KEY_TRANSITION_SHAPE,
  KEY_TRANSITION_STATEMENT,
  KEY_TRANSITION_STATEMENT_SHAPE,
  KEY_TYPE,
  MAILBOX_CHECKPOINT,
  MAILBOX_CHECKPOINT_SHAPE,
  MAX_CHANNEL_ALLOCATIONS,
  MAX_CHANNEL_APP_STATE_BYTES,
  MAX_CHANNEL_SIGNATURES,
  MAX_CHANNEL_UPDATE_FRAME_BYTES,
  MAX_CIPHERTEXT_BYTES,
  MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES,
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES,
  MAX_EMAIL_RECIPIENTS,
  MAX_FORUM_CURSOR_BYTES,
  MAX_FORUM_ENTRIES,
  MAX_FORUM_PAGE_BYTES,
  MAX_FORUM_ROWS,
  MAX_FORUM_VIEW_BYTES,
  MAX_FORWARDING_DELIVERY_FRAME_BYTES,
  MAX_FRAME_BYTES,
  MAX_JOURNAL_FACTS,
  MAX_MESSAGE_ITEMS_PER_ARRAY,
  MAX_OPAQUE_SECTIONS,
  MAX_PAYMENT_MEMBERS,
  MAX_PLUGIN_ITEM_PAYLOAD_BYTES,
  MAX_PLUGIN_ITEM_TYPE_BYTES,
  MAX_RELAY_BINDINGS,
  MAX_SIGNATURES,
  MAX_TEXT_STRING_BYTES,
  MAX_TOPIC_BODY_BYTES,
  MAX_TOPIC_FRAME_BYTES,
  MAX_TOPIC_VOTE_FRAME_BYTES,
  MESSAGE_CONTENT_REVISION,
  MESSAGE_CONTENT_REVISION_SHAPE,
  OPAQUE_SECTION,
  OPAQUE_SECTION_SHAPE,
  PARTICIPANT_BALANCE,
  PARTICIPANT_BALANCE_SHAPE,
  PAYMENT_MEMBER,
  PAYMENT_MEMBER_SHAPE,
  PAYMENT_TRANSFER,
  PAYMENT_TRANSFER_SHAPE,
  PLUGIN_MESSAGE_ITEM,
  PLUGIN_MESSAGE_ITEM_SHAPE,
  PROFILE_ENTRY,
  PROFILE_ENTRY_SHAPE,
  PROFILE_HEADER,
  PROFILE_HEADER_SHAPE,
  RECIPIENT_ENCRYPTED_PAYLOAD_V1,
  RECIPIENT_ENCRYPTED_PAYLOAD_V1_SHAPE,
  RECIPIENT_ENCRYPTED_PAYLOAD_V2,
  RECIPIENT_ENCRYPTED_PAYLOAD_V2_SHAPE,
  RELAY_BINDING,
  RELAY_BINDING_SHAPE,
  SIGNATURE_ALGORITHM,
  SIGNATURE_ENTRY,
  SIGNATURE_ENTRY_SHAPE,
  STEALTH_ASSET_MESSAGE_ITEM,
  STEALTH_ASSET_MESSAGE_ITEM_SHAPE,
  STEALTH_ASSET_TRANSFER,
  STEALTH_ASSET_TRANSFER_SHAPE,
  STEALTH_DERIVATION_SCHEME,
  STEALTH_MESSAGE_ITEM,
  STEALTH_MESSAGE_ITEM_SHAPE,
  STEALTH_METADATA,
  STEALTH_METADATA_SHAPE,
  TEXT_MESSAGE_ITEM,
  TEXT_MESSAGE_ITEM_SHAPE,
  TIMESTAMP,
  TIMESTAMP_SHAPE,
  TOKEN_TRANSFER,
  TOKEN_TRANSFER_SHAPE,
  TOPIC_POST,
  TOPIC_POST_SHAPE,
  TOPIC_POST_SUBMISSION,
  TOPIC_POST_SUBMISSION_SHAPE,
  TOPIC_VOTE_SUBMISSION,
  TOPIC_VOTE_SUBMISSION_SHAPE,
  TYPE_CHANNEL_UPDATE,
  TYPE_CONTAINER_MESSAGE_ITEM,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_DIRECTORY_STATEMENT,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_EMAIL_MESSAGE_ITEM,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_VIEW,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
  TYPE_KEY_TRANSITION_STATEMENT,
  TYPE_MAILBOX_CHECKPOINT,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_PLUGIN_MESSAGE_ITEM,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_STEALTH_MESSAGE_ITEM,
  TYPE_TEXT_MESSAGE_ITEM,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
  U32_MAX,
  U64_MAX,
} from './constants'
import { isCompressedPoint, isProofEncoding } from './point'
import {
  asList,
  bad,
  bstr,
  EMAIL_MESSAGE_ID_MAX_BYTES,
  EMAIL_MESSAGE_ID_MIN_BYTES,
  at,
  atItem,
  fail,
  fields,
  isEmailMessageId,
  isMap,
  shaped,
  tstr,
  u32ish,
  uintRange,
  type FeatureCodecDescriptor,
  type MapView,
  type SchemaVersionContext,
} from './schema-primitives'
import type {
  AccountRef,
  AccountType,
  BotRole,
  DirectMessageDelivery,
  ForwardingDeliveryEnvelope,
  DraftPayload,
  JournalFact,
  KeyTransition,
  OpaqueSection,
  PaymentMember,
  PaymentTransfer,
  TokenTransfer,
  StealthMetadata,
  StealthAssetTransfer,
  ProfileEntry,
  ProfileHeader,
  RelayBinding,
  SignatureEntry,
  Timestamp,
  ForumContent,
  ForumCursor,
  ForumAggregate,
  TopicPost,
  ChainAllocation,
  ParticipantBalance,
  EmailParty,
  EmailAttachment,
  EmailMessageItem,
} from './types'

export {
  asList,
  bad,
  bstr,
  fields,
  isMap,
  tstr,
  u32ish,
  type FeatureCodecDescriptor,
  type MapView,
  type SchemaVersionContext,
}

// ---------------------------------------------------------------------------------------------
// Value getters (8.2)
// ---------------------------------------------------------------------------------------------

const NETWORK_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/

function networkTag(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 64)
  if (!NETWORK_TAG.test(s)) throw bad(path, 'network tag does not match S1')
  return s
}

function emailMessageId(v: FrankValue | undefined, path: string): string {
  const s = tstr(
    v,
    path,
    EMAIL_MESSAGE_ID_MIN_BYTES,
    EMAIL_MESSAGE_ID_MAX_BYTES,
  )
  if (!isEmailMessageId(s))
    throw bad(path, 'expected an RFC 5322 <local@domain> message ID')
  return s
}

// S4: scheme, then only bytes 0x21..0x7e excluding " < > \ ^ ` { | }.
const ENDPOINT = /^[A-Za-z][A-Za-z0-9+.-]*:[!#-;=?-[\]_a-z~]*$/

function endpoint(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 2048)
  // The class above is bytes 21,23-3b,3d,3f-5b,5d,5f,61-7a,7e: everything 21-7e except
  // 22 " 3c < 3e > 5c \ 5e ^ 60 ` 7b { 7c | 7d }.
  if (!ENDPOINT.test(s)) throw bad(path, 'endpoint violates S4')
  return s
}

const FORBIDDEN_TEXT_CONTROL_CHARACTER =
  // eslint-disable-next-line no-control-regex -- Conversation names deliberately reject controls.
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u

function conversationName(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 512)
  if (s.trim().length === 0) {
    throw bad(path, 'conversation name cannot be whitespace-only')
  }
  if (FORBIDDEN_TEXT_CONTROL_CHARACTER.test(s)) {
    throw bad(path, 'conversation name contains forbidden control character')
  }
  return s
}

const KEY_LENGTHS: ReadonlyMap<number, number> = new Map([
  [KEY_TYPE.secp256k1, 33],
  [KEY_TYPE.ed25519, 32],
  [KEY_TYPE.secp256k1XOnly, 32],
])

function account(v: FrankValue | undefined, path: string): AccountRef {
  const K = ACCOUNT_REF
  const m = shaped(v, path, ACCOUNT_REF_SHAPE, false)
  const keyType = u32ish(m.get(K.keyType), at(path, K.keyType), 0, 65535)
  const keyBytes = bstr(m.get(K.keyBytes), at(path, K.keyBytes), 1, 128)
  const expected = KEY_LENGTHS.get(keyType)
  if (expected !== undefined && keyBytes.length !== expected) {
    throw bad(
      at(path, K.keyBytes),
      `key type ${keyType} requires ${expected} key bytes (S2)`,
    )
  }
  return { keyType, keyBytes }
}

function directoryAccount(
  v: FrankValue | undefined,
  path: string,
  preview: boolean,
): AccountRef {
  const key = account(v, path)
  if (preview && key.keyType !== KEY_TYPE.secp256k1)
    throw bad(path, 'directory preview key type must be 1')
  return key
}

/** A type-11 stamp point (T3b encoding rules): 33 compressed bytes on the curve. */
function point(v: FrankValue | undefined, path: string): Uint8Array {
  const b = bstr(v, path, 33, 33)
  if (!isCompressedPoint(b))
    throw bad(path, 'not a valid compressed secp256k1 point (T3b)')
  return b
}

/** The type-11 DLEQ proof `c || s` (T3b encoding rules): 64 bytes, both scalars in 1..n-1. */
function proof(v: FrankValue | undefined, path: string): Uint8Array {
  const b = bstr(v, path, 64, 64)
  if (!isProofEncoding(b)) throw bad(path, 'proof scalar outside 1..n-1 (T3b)')
  return b
}

function timestamp(v: FrankValue | undefined, path: string): Timestamp {
  const K = TIMESTAMP
  const m = shaped(v, path, TIMESTAMP_SHAPE, false)
  const seconds = m.get(K.seconds)
  if (typeof seconds !== 'bigint' || seconds < I64_MIN || seconds > I64_MAX) {
    throw bad(at(path, K.seconds), 'seconds must be an i64')
  }
  return {
    seconds,
    nanoseconds: u32ish(
      m.get(K.nanoseconds),
      at(path, K.nanoseconds),
      0,
      999999999,
    ),
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.1
// ---------------------------------------------------------------------------------------------

const PLUGIN_ITEM_TYPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether `value` may name a plugin item type in a type-27 frame: 1..64 characters of lowercase
 * ASCII letters and digits, in groups separated by single hyphens. */
export function isPluginItemType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_PLUGIN_ITEM_TYPE_BYTES &&
    PLUGIN_ITEM_TYPE.test(value)
  )
}

/** Root frame length limits of R2 and R3. Only a root frame is charged. */
export function checkRootFrameLimit(
  typeId: number,
  frameLength: number,
  schemaVersion = 1,
  featureCodecs: ReadonlyMap<
    number,
    FeatureCodecDescriptor
  > = DEFAULT_FEATURE_CODEC_MAP,
): boolean {
  const feature = featureCodecs.get(typeId)
  if (feature?.maxFrameBytes !== undefined)
    return frameLength <= feature.maxFrameBytes
  if (typeId === TYPE_CHANNEL_UPDATE)
    return frameLength <= MAX_CHANNEL_UPDATE_FRAME_BYTES
  if (typeId === TYPE_FORWARDING_DELIVERY_ENVELOPE)
    return frameLength <= MAX_FORWARDING_DELIVERY_FRAME_BYTES
  if (typeId === TYPE_EMAIL_MESSAGE_ITEM)
    return frameLength <= MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES
  if (typeId === TYPE_DIRECTORY_STATEMENT && schemaVersion >= 4)
    return frameLength <= 262_144
  if (typeId === TYPE_DIRECT_MESSAGE_DELIVERY) return frameLength <= 1_048_576
  if (typeId === TYPE_DIRECTORY_ATTESTATION) return frameLength <= 262_144
  if (typeId === TYPE_TOPIC_POST || typeId === TYPE_TOPIC_POST_SUBMISSION)
    return frameLength <= MAX_TOPIC_FRAME_BYTES
  if (typeId === TYPE_TOPIC_VOTE_SUBMISSION)
    return frameLength <= MAX_TOPIC_VOTE_FRAME_BYTES
  if (typeId === TYPE_FORUM_VIEW || typeId === TYPE_FORUM_OPERATION_STATUS)
    return frameLength <= MAX_FORUM_VIEW_BYTES
  if (typeId === TYPE_FORUM_TOPIC_PAGE || typeId === TYPE_FORUM_DISCOVERY_PAGE)
    return frameLength <= MAX_FORUM_PAGE_BYTES
  return frameLength <= MAX_FRAME_BYTES
}

function tooMany(v: FrankValue | undefined, limit: number): boolean {
  return Array.isArray(v) && v.length > limit
}

/** Reads R2-R4 counts from the decoded fields, before typed conversion. */
export function checkTypeLimits(
  typeId: number,
  payload: FrankValue,
  schemaVersion = 1,
  featureCodecs: ReadonlyMap<
    number,
    FeatureCodecDescriptor
  > = DEFAULT_FEATURE_CODEC_MAP,
): void {
  const feature = featureCodecs.get(typeId)
  if (feature) {
    feature.checkTypeLimits?.(payload, schemaVersion)
    return
  }
  if (!isMap(payload)) return
  const over = (what: string): never => {
    throw fail(
      'resource',
      '8.1',
      'root/payload',
      `${what} exceeds its limit (R2-R4)`,
    )
  }
  const f = (k: number) => payload.get(BigInt(k))
  switch (typeId) {
    case TYPE_DIRECT_MESSAGE_DELIVERY:
      if (tooMany(f(DIRECT_MESSAGE_DELIVERY.payments), MAX_PAYMENT_MEMBERS))
        over('payment members')
      break
    case TYPE_FORWARDING_DELIVERY_ENVELOPE:
      if (
        tooMany(f(FORWARDING_DELIVERY_ENVELOPE.payments), MAX_PAYMENT_MEMBERS)
      )
        over('payment members')
      break
    case TYPE_DIRECTORY_ATTESTATION:
      if (tooMany(f(DIRECTORY_ATTESTATION.signatures), MAX_SIGNATURES))
        over('signatures')
      break
    case TYPE_MAILBOX_CHECKPOINT:
      if (tooMany(f(MAILBOX_CHECKPOINT.facts), MAX_JOURNAL_FACTS))
        over('journal facts')
      if (tooMany(f(MAILBOX_CHECKPOINT.sections), MAX_OPAQUE_SECTIONS))
        over('opaque sections')
      break
    case TYPE_DIRECTORY_STATEMENT:
      if (tooMany(f(DIRECTORY_STATEMENT.relays), MAX_RELAY_BINDINGS))
        over('relay bindings')
      break
    case TYPE_RECIPIENT_ENCRYPTED_PAYLOAD: {
      if (schemaVersion >= 2) {
        const e = f(RECIPIENT_ENCRYPTED_PAYLOAD_V2.cryptoBoxEnvelope)
        if (
          e instanceof Uint8Array &&
          e.length > MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES
        )
          over('crypto-box envelope')
      } else {
        const c = f(RECIPIENT_ENCRYPTED_PAYLOAD_V1.ciphertext)
        if (c instanceof Uint8Array && c.length > MAX_CIPHERTEXT_BYTES)
          over('ciphertext')
      }
      break
    }
    case TYPE_TOPIC_POST: {
      const b = f(TOPIC_POST.body)
      if (b instanceof Uint8Array && b.length > MAX_TOPIC_BODY_BYTES)
        over('topic body')
      break
    }
    case TYPE_FORUM_TOPIC_PAGE:
    case TYPE_FORUM_DISCOVERY_PAGE: {
      const K = FORUM_TOPIC_PAGE
      const page =
        typeId === TYPE_FORUM_TOPIC_PAGE
          ? {
              rows: K.rows,
              cursors: [K.nextCursor, K.requestCursor],
            }
          : {
              rows: FORUM_DISCOVERY_PAGE.entries,
              cursors: [
                FORUM_DISCOVERY_PAGE.nextCursor,
                FORUM_DISCOVERY_PAGE.requestCursor,
              ],
            }
      if (tooMany(f(page.rows), MAX_FORUM_ROWS)) over('Forum rows')
      for (const key of page.cursors) {
        const cursor = f(key)
        if (
          cursor instanceof Uint8Array &&
          cursor.length > MAX_FORUM_CURSOR_BYTES
        )
          over('Forum cursor')
      }
      break
    }
    case TYPE_MESSAGE_CONTENT_REVISION:
      if (
        tooMany(f(MESSAGE_CONTENT_REVISION.items), MAX_MESSAGE_ITEMS_PER_ARRAY)
      )
        over('message items')
      break
    case TYPE_CONTAINER_MESSAGE_ITEM:
      if (tooMany(f(CONTAINER_MESSAGE_ITEM.items), MAX_MESSAGE_ITEMS_PER_ARRAY))
        over('message items')
      break
    case TYPE_CHANNEL_UPDATE: {
      const K = CHANNEL_UPDATE_ITEM
      const appState = f(K.appState)
      if (
        appState instanceof Uint8Array &&
        appState.length > MAX_CHANNEL_APP_STATE_BYTES
      )
        over('app state')
      if (tooMany(f(K.allocations), MAX_CHANNEL_ALLOCATIONS))
        over('chain allocations')
      if (tooMany(f(K.signatures), MAX_CHANNEL_SIGNATURES))
        over('channel signatures')
      break
    }
    case TYPE_PLUGIN_MESSAGE_ITEM: {
      const data = f(PLUGIN_MESSAGE_ITEM.data)
      if (
        data instanceof Uint8Array &&
        data.length > MAX_PLUGIN_ITEM_PAYLOAD_BYTES
      )
        over('plugin item bytes')
      break
    }
    case TYPE_EMAIL_MESSAGE_ITEM: {
      const K = EMAIL_MESSAGE_ITEM
      if (tooMany(f(K.to), MAX_EMAIL_RECIPIENTS)) over('to recipients')
      if (tooMany(f(K.cc), MAX_EMAIL_RECIPIENTS)) over('cc recipients')
      if (tooMany(f(K.attachments), MAX_EMAIL_ATTACHMENTS)) over('attachments')
      break
    }
    default:
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.2
// ---------------------------------------------------------------------------------------------

const framed = (v: FrankValue | undefined, path: string): Uint8Array =>
  bstr(v, path, 9, MAX_FRAME_BYTES)

function paymentMember(v: FrankValue | undefined, path: string): PaymentMember {
  const K = PAYMENT_MEMBER
  const m = shaped(v, path, PAYMENT_MEMBER_SHAPE, false)
  const rawVal = m.get(K.value)
  let value: Uint8Array | bigint
  if (rawVal instanceof Uint8Array) {
    value = bstr(rawVal, at(path, K.value), 32, 32)
  } else if (typeof rawVal === 'bigint') {
    value = uintRange(rawVal, at(path, K.value), 0n, 0xffffffffffffffffn)
  } else {
    throw bad(
      at(path, K.value),
      'expected a 32-byte string or an unsigned integer',
    )
  }
  const txField = bstr(
    m.get(K.transactionId),
    at(path, K.transactionId),
    1,
    128,
  )
  const rawTx = m.has(K.rawTx)
    ? bstr(m.get(K.rawTx), at(path, K.rawTx), 1, 16384)
    : undefined
  return {
    childIndex: u32ish(
      m.get(K.childIndex),
      at(path, K.childIndex),
      0,
      2147483647,
    ),
    transactionId: txField,
    value,
    address: bstr(m.get(K.address), at(path, K.address), 1, 128),
    commitment: bstr(m.get(K.commitment), at(path, K.commitment), 32, 32),
    vout: m.has(K.vout)
      ? u32ish(m.get(K.vout), at(path, K.vout), 0, 4294967295)
      : undefined,
    ...(rawTx !== undefined ? { rawTx } : {}),
  }
}

export function stealthMetadata(
  v: FrankValue | undefined,
  path = 'stealth-metadata',
): StealthMetadata {
  const K = STEALTH_METADATA
  const m = shaped(v, path, STEALTH_METADATA_SHAPE, false)
  let viewTag: number | Uint8Array | undefined
  if (m.has(K.viewTag)) {
    const rawTag = m.get(K.viewTag)
    if (typeof rawTag === 'bigint') {
      viewTag = u32ish(rawTag, at(path, K.viewTag), 0, 65535)
    } else if (rawTag instanceof Uint8Array) {
      viewTag = bstr(rawTag, at(path, K.viewTag), 1, 32)
    } else {
      throw bad(
        at(path, K.viewTag),
        'expected an unsigned integer or a byte string',
      )
    }
  }
  return {
    ephemeralPubKey: account(
      m.get(K.ephemeralPubKey),
      at(path, K.ephemeralPubKey),
    ),
    ...(viewTag !== undefined ? { viewTag } : {}),
  }
}

export function paymentTransfer(
  v: FrankValue | undefined,
  path = 'payment-transfer',
): PaymentTransfer {
  const K = PAYMENT_TRANSFER
  const m = shaped(v, path, PAYMENT_TRANSFER_SHAPE, false)
  const rawVal = m.get(K.value)
  let value: Uint8Array | bigint
  if (rawVal instanceof Uint8Array) {
    value = bstr(rawVal, at(path, K.value), 32, 32)
  } else if (typeof rawVal === 'bigint') {
    value = uintRange(rawVal, at(path, K.value), 0n, U64_MAX)
  } else {
    throw bad(
      at(path, K.value),
      'expected a 32-byte string or an unsigned integer',
    )
  }

  const txField = bstr(m.get(K.txId), at(path, K.txId), 1, 128)
  const rawTx = m.has(K.rawTx)
    ? bstr(m.get(K.rawTx), at(path, K.rawTx), 1, 16384)
    : undefined

  return {
    networkTag: tstr(m.get(K.networkTag), at(path, K.networkTag), 1, 64),
    txId: txField,
    vout: m.has(K.vout)
      ? u32ish(m.get(K.vout), at(path, K.vout), 0, 4294967295)
      : undefined,
    destination: bstr(m.get(K.destination), at(path, K.destination), 1, 128),
    value,
    token: m.has(K.token)
      ? bstr(m.get(K.token), at(path, K.token), 1, 128)
      : undefined,
    stealthMetadata: m.has(K.stealthMetadata)
      ? stealthMetadata(m.get(K.stealthMetadata), at(path, K.stealthMetadata))
      : undefined,
    commitment: m.has(K.commitment)
      ? bstr(m.get(K.commitment), at(path, K.commitment), 32, 32)
      : undefined,
    ...(rawTx !== undefined ? { rawTx } : {}),
  }
}

function stealthAssetTransfer(
  v: FrankValue | undefined,
  path: string,
): StealthAssetTransfer {
  const K = STEALTH_ASSET_TRANSFER
  const m = shaped(v, path, STEALTH_ASSET_TRANSFER_SHAPE, false)
  const transfer = paymentTransfer(m.get(K.transfer), at(path, K.transfer))
  if (transfer.stealthMetadata === undefined)
    throw bad(
      at(at(path, K.transfer), PAYMENT_TRANSFER.stealthMetadata),
      'a recipient payment requires stealth metadata',
    )
  if (
    typeof transfer.value === 'bigint'
      ? transfer.value === 0n
      : transfer.value.every(byte => byte === 0)
  )
    throw bad(
      at(at(path, K.transfer), PAYMENT_TRANSFER.value),
      'a recipient payment requires a positive amount',
    )
  const derivationScheme = u32ish(
    m.get(K.derivationScheme),
    at(path, K.derivationScheme),
    1,
    U32_MAX,
  )
  const recipientSpendKey = account(
    m.get(K.recipientSpendKey),
    at(path, K.recipientSpendKey),
  )
  if (
    recipientSpendKey.keyType !==
    transfer.stealthMetadata.ephemeralPubKey.keyType
  )
    throw bad(
      at(path, K.recipientSpendKey),
      'recipient and ephemeral key types differ',
    )
  const tokenProgram = m.has(K.tokenProgram)
    ? bstr(m.get(K.tokenProgram), at(path, K.tokenProgram), 32, 32)
    : undefined
  const derivationContext = m.has(K.derivationContext)
    ? bstr(m.get(K.derivationContext), at(path, K.derivationContext), 1, 1024)
    : undefined
  if (tokenProgram !== undefined && transfer.token === undefined)
    throw bad(
      at(path, K.tokenProgram),
      'a token program requires a token identifier',
    )
  if (
    derivationScheme === STEALTH_DERIVATION_SCHEME.secp256k1EcdhAddV1 &&
    (recipientSpendKey.keyType !== KEY_TYPE.secp256k1 ||
      tokenProgram !== undefined ||
      derivationContext !== undefined)
  )
    throw bad(
      path,
      'secp256k1-ecdh-add-v1 requires secp keys and no program or context',
    )
  return {
    transfer,
    derivationScheme,
    recipientSpendKey,
    tokenProgram,
    derivationContext,
  }
}

export function tokenTransfer(
  v: FrankValue | undefined,
  path = 'token-transfer',
  allow = false,
): TokenTransfer {
  const K = TOKEN_TRANSFER
  const m = shaped(v, path, TOKEN_TRANSFER_SHAPE, allow)
  const rawAmount = m.get(K.amount)
  let amount: bigint
  if (typeof rawAmount === 'bigint') {
    if (rawAmount < 0n)
      throw bad(at(path, K.amount), 'amount must be non-negative')
    amount = rawAmount
  } else if (rawAmount instanceof Uint8Array) {
    if (rawAmount.length === 0) {
      amount = 0n
    } else {
      let hex = ''
      for (let i = 0; i < rawAmount.length; i++) {
        hex += rawAmount[i].toString(16).padStart(2, '0')
      }
      amount = BigInt('0x' + hex)
    }
  } else {
    throw bad(at(path, K.amount), 'expected unsigned integer or biguint')
  }

  return {
    chainNamespace: tstr(
      m.get(K.chainNamespace),
      at(path, K.chainNamespace),
      1,
      64,
    ),
    contractAddress: tstr(
      m.get(K.contractAddress),
      at(path, K.contractAddress),
      1,
      128,
    ),
    amount,
    decimals: u32ish(m.get(K.decimals), at(path, K.decimals), 0, 255),
    symbol: tstr(m.get(K.symbol), at(path, K.symbol), 1, 32),
    rawTxOrPermit: m.has(K.rawTxOrPermit)
      ? bstr(m.get(K.rawTxOrPermit), at(path, K.rawTxOrPermit), 1, 65536)
      : undefined,
  }
}

function signatureEntry(
  v: FrankValue | undefined,
  path: string,
): SignatureEntry {
  const K = SIGNATURE_ENTRY
  const m = shaped(v, path, SIGNATURE_ENTRY_SHAPE, false)
  return {
    algorithm: u32ish(m.get(K.algorithm), at(path, K.algorithm), 0, 65535),
    signer: account(m.get(K.signer), at(path, K.signer)),
    signature: bstr(m.get(K.signature), at(path, K.signature), 1, 512),
  }
}

function participantBalance(
  v: FrankValue | undefined,
  path: string,
): ParticipantBalance {
  const K = PARTICIPANT_BALANCE
  const m = shaped(v, path, PARTICIPANT_BALANCE_SHAPE, false)
  const rawVal = m.get(K.balance)
  let balance: Uint8Array | bigint
  if (rawVal instanceof Uint8Array) {
    balance = bstr(rawVal, at(path, K.balance), 32, 32)
  } else if (typeof rawVal === 'bigint') {
    balance = uintRange(rawVal, at(path, K.balance), 0n, U64_MAX)
  } else {
    throw bad(
      at(path, K.balance),
      'expected a 32-byte string or an unsigned integer',
    )
  }
  return {
    participant: account(m.get(K.participant), at(path, K.participant)),
    balance,
  }
}

function chainAllocation(
  v: FrankValue | undefined,
  path: string,
): ChainAllocation {
  const K = CHAIN_ALLOCATION
  const m = shaped(v, path, CHAIN_ALLOCATION_SHAPE, false)
  return {
    networkTag: networkTag(m.get(K.networkTag), at(path, K.networkTag)),
    token: bstr(m.get(K.token), at(path, K.token), 0, 128),
    balances: asList(m.get(K.balances), at(path, K.balances), 2, 16).map(
      (b, i) => participantBalance(b, `${at(path, K.balances)}[${i}]`),
    ),
  }
}

function relayBinding(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
  preview = false,
): RelayBinding {
  const K = RELAY_BINDING
  const m = shaped(v, path, RELAY_BINDING_SHAPE, allow)
  return {
    relayId: bstr(m.get(K.relayId), at(path, K.relayId), 16, 64),
    endpoint: endpoint(m.get(K.endpoint), at(path, K.endpoint)),
    identity: directoryAccount(
      m.get(K.identity),
      at(path, K.identity),
      preview,
    ),
    expiry: timestamp(m.get(K.expiry), at(path, K.expiry)),
    unknownFields: m.unknown,
  }
}

function keyTransition(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): KeyTransition<Uint8Array> {
  const K = KEY_TRANSITION
  const m = shaped(v, path, KEY_TRANSITION_SHAPE, allow)
  return {
    statementFrame: framed(m.get(K.statementFrame), at(path, K.statementFrame)),
    algorithm: u32ish(m.get(K.algorithm), at(path, K.algorithm), 0, 65535),
    signer: account(m.get(K.signer), at(path, K.signer)),
    signature: bstr(m.get(K.signature), at(path, K.signature), 1, 512),
    unknownFields: m.unknown,
  }
}

function journalFact(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): JournalFact {
  const K = JOURNAL_FACT
  const m = shaped(v, path, JOURNAL_FACT_SHAPE, allow)
  return {
    timestamp: timestamp(m.get(K.timestamp), at(path, K.timestamp)),
    factId: bstr(m.get(K.factId), at(path, K.factId), 16, 16),
    kind: u32ish(m.get(K.kind), at(path, K.kind), 0, 65535),
    payload: bstr(m.get(K.payload), at(path, K.payload), 0, 8_388_608),
    unknownFields: m.unknown,
  }
}

function opaqueSection(v: FrankValue | undefined, path: string): OpaqueSection {
  const K = OPAQUE_SECTION
  const m = shaped(v, path, OPAQUE_SECTION_SHAPE, false)
  return {
    sectionType: u32ish(
      m.get(K.sectionType),
      at(path, K.sectionType),
      0,
      U32_MAX,
    ),
    sectionSchemaVersion: u32ish(
      m.get(K.sectionSchemaVersion),
      at(path, K.sectionSchemaVersion),
      1,
      U32_MAX,
    ),
    value: bstr(m.get(K.value), at(path, K.value), 0, 8_388_608),
  }
}

function profileHeader(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): ProfileHeader {
  const K = PROFILE_HEADER
  const m = shaped(v, path, PROFILE_HEADER_SHAPE, allow)
  return {
    name: tstr(m.get(K.name), at(path, K.name), 0, MAX_TEXT_STRING_BYTES),
    value: tstr(m.get(K.value), at(path, K.value), 0, MAX_TEXT_STRING_BYTES),
    unknownFields: m.unknown,
  }
}

function profileEntry(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): ProfileEntry {
  const K = PROFILE_ENTRY
  const m = shaped(v, path, PROFILE_ENTRY_SHAPE, allow)
  const headers = asList(m.get(K.headers), at(path, K.headers), 0, 64)
  return {
    kind: tstr(m.get(K.kind), at(path, K.kind), 0, MAX_TEXT_STRING_BYTES),
    headers: headers.map((e, i) =>
      profileHeader(e, `${at(path, K.headers)}[${i}]`, allow),
    ),
    body: bstr(m.get(K.body), at(path, K.body), 0, 8_388_608),
    unknownFields: m.unknown,
  }
}

/**
 * Stage 8.2: converts a generic payload to the typed draft of `typeId`, applying the CDDL
 * structure and range rules. Framed fields stay raw bytes until stage 8.4 opens them.
 */
export function parseForumContent(
  value: FrankValue,
  allow: boolean,
  path: string,
): ForumContent {
  const K = FORUM_GAME_ENTRY
  if (
    value instanceof Map &&
    tooMany(value.get(BigInt(FORUM_CONTENT.entries)), MAX_FORUM_ENTRIES)
  )
    throw fail('resource', '8.1', path, 'Forum content exceeds 64 entries')
  const m = shaped(value, path, FORUM_CONTENT_SHAPE, allow)
  return {
    authored: timestamp(
      m.get(FORUM_CONTENT.authored),
      at(path, FORUM_CONTENT.authored),
    ),
    unknownFields: m.unknown,
    entries: asList(
      m.get(FORUM_CONTENT.entries),
      at(path, FORUM_CONTENT.entries),
      1,
      MAX_FORUM_ENTRIES,
    ).map((entry, i) => {
      const p = `${at(path, FORUM_CONTENT.entries)}[${i}]`
      if (!(entry instanceof Map)) throw bad(p, 'expected entry map')
      const kind = uintRange(
        entry.get(BigInt(FORUM_ENTRY.kind)),
        at(p, FORUM_ENTRY.kind),
        0n,
        U64_MAX,
      )
      if (kind === BigInt(FORUM_ENTRY_KIND.game)) {
        const e = shaped(entry, p, FORUM_GAME_ENTRY_SHAPE, allow)
        return {
          kind: 'game' as const,
          gameType: tstr(e.get(K.gameType), at(p, K.gameType), 1, 64),
          tableId: tstr(e.get(K.tableId), at(p, K.tableId), 1, 128),
          hostAddress: tstr(e.get(K.hostAddress), at(p, K.hostAddress), 1, 128),
          ...(e.has(K.buyInAmount)
            ? {
                buyInAmount: tstr(
                  e.get(K.buyInAmount),
                  at(p, K.buyInAmount),
                  0,
                  64,
                ),
              }
            : {}),
          ...(e.has(K.currentPlayers)
            ? {
                currentPlayers: u32ish(
                  e.get(K.currentPlayers),
                  at(p, K.currentPlayers),
                  0,
                  1000,
                ),
              }
            : {}),
          ...(e.has(K.maxPlayers)
            ? {
                maxPlayers: u32ish(
                  e.get(K.maxPlayers),
                  at(p, K.maxPlayers),
                  0,
                  1000,
                ),
              }
            : {}),
          ...(e.has(K.botAddress)
            ? {
                botAddress: tstr(
                  e.get(K.botAddress),
                  at(p, K.botAddress),
                  0,
                  128,
                ),
              }
            : {}),
          ...(e.has(K.title)
            ? {
                title: tstr(e.get(K.title), at(p, K.title), 0, 512),
              }
            : {}),
          ...(e.has(K.message)
            ? {
                message: tstr(
                  e.get(K.message),
                  at(p, K.message),
                  0,
                  MAX_TEXT_STRING_BYTES,
                ),
              }
            : {}),
          unknownFields: e.unknown,
        }
      }
      if (kind !== BigInt(FORUM_ENTRY_KIND.post)) {
        if (!allow) throw bad(p, 'unallocated Forum entry kind')
        return {
          kind: 'unsupported' as const,
          kindId: kind,
          placeholder: 'Unsupported content' as const,
          fields: entry,
        }
      }
      const e = shaped(entry, p, FORUM_POST_ENTRY_SHAPE, allow)
      return {
        kind: 'post' as const,
        ...(e.has(FORUM_POST_ENTRY.title)
          ? {
              title: tstr(
                e.get(FORUM_POST_ENTRY.title),
                at(p, FORUM_POST_ENTRY.title),
                0,
                MAX_TEXT_STRING_BYTES,
              ),
            }
          : {}),
        ...(e.has(FORUM_POST_ENTRY.url)
          ? {
              url: tstr(
                e.get(FORUM_POST_ENTRY.url),
                at(p, FORUM_POST_ENTRY.url),
                0,
                MAX_TEXT_STRING_BYTES,
              ),
            }
          : {}),
        ...(e.has(FORUM_POST_ENTRY.message)
          ? {
              message: tstr(
                e.get(FORUM_POST_ENTRY.message),
                at(p, FORUM_POST_ENTRY.message),
                0,
                MAX_TEXT_STRING_BYTES,
              ),
            }
          : {}),
        unknownFields: e.unknown,
      }
    }),
  }
}

function forumAggregate(
  value: FrankValue | undefined,
  path: string,
): ForumAggregate {
  const K = FORUM_AGGREGATE
  const m = shaped(value, path, FORUM_AGGREGATE_SHAPE, false)
  const negative = m.get(K.negative),
    magnitude = bstr(m.get(K.magnitude), at(path, K.magnitude), 32, 32)
  if (typeof negative !== 'boolean')
    throw bad(at(path, K.negative), 'expected boolean sign')
  if (negative && magnitude.every(b => b === 0))
    throw bad(path, 'negative zero')
  return { negative, magnitude }
}

/** The cursor item has already passed canonical decoding with its enclosing counters. */
export function parseForumCursor(
  value: FrankValue,
  bytes: Uint8Array,
  path: string,
): ForumCursor {
  if (!(value instanceof Map)) throw bad(path, 'expected cursor map')
  const T = FORUM_TOPIC_CURSOR
  const family = u32ish(
    value.get(BigInt(T.family)),
    at(path, T.family),
    TYPE_FORUM_TOPIC_PAGE,
    TYPE_FORUM_DISCOVERY_PAGE,
  )
  const m = shaped(
    value,
    path,
    family === TYPE_FORUM_TOPIC_PAGE
      ? FORUM_TOPIC_CURSOR_SHAPE
      : FORUM_DISCOVERY_CURSOR_SHAPE,
    false,
  )
  // The two cursor shapes share keys 0-3 and 7.
  const common = {
    bytes,
    network: networkTag(m.get(T.network), at(path, T.network)),
    revision: uintRange(m.get(T.revision), at(path, T.revision), 0n, U64_MAX),
    epoch: bstr(m.get(T.epoch), at(path, T.epoch), 16, 16),
    incarnation: uintRange(
      m.get(T.incarnation),
      at(path, T.incarnation),
      0n,
      U64_MAX,
    ),
  }
  if (family === TYPE_FORUM_DISCOVERY_PAGE) {
    const D = FORUM_DISCOVERY_CURSOR
    return {
      ...common,
      family,
      last: tstr(m.get(D.last), at(path, D.last), 1, 512),
    }
  }
  const lastPath = at(path, T.last)
  const L = FORUM_CURSOR_LAST
  const last = shaped(m.get(T.last), lastPath, FORUM_CURSOR_LAST_SHAPE, false)
  return {
    ...common,
    family: TYPE_FORUM_TOPIC_PAGE,
    topic: tstr(m.get(T.topic), at(path, T.topic), 1, 512),
    since: timestamp(m.get(T.since), at(path, T.since)),
    last: {
      timestamp: timestamp(last.get(L.timestamp), at(lastPath, L.timestamp)),
      hash: bstr(last.get(L.hash), at(lastPath, L.hash), 32, 32),
    },
  }
}

function emailParty(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): EmailParty {
  const K = EMAIL_PARTY
  const m = shaped(v, path, EMAIL_PARTY_SHAPE, allow)
  const res: EmailParty = {
    address: tstr(m.get(K.address), at(path, K.address), 3, 320),
    unknownFields: m.unknown,
  }
  if (m.has(K.name)) {
    res.name = tstr(m.get(K.name), at(path, K.name), 1, 256)
  }
  if (m.has(K.frankAccount)) {
    res.frankAccount = account(m.get(K.frankAccount), at(path, K.frankAccount))
  }
  return res
}

function emailAttachment(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): EmailAttachment {
  const K = EMAIL_ATTACHMENT
  const m = shaped(v, path, EMAIL_ATTACHMENT_SHAPE, allow)
  const res: EmailAttachment = {
    filename: tstr(m.get(K.filename), at(path, K.filename), 1, 256),
    contentType: tstr(m.get(K.contentType), at(path, K.contentType), 1, 128),
    content: bstr(m.get(K.content), at(path, K.content), 0, 8_388_608),
    unknownFields: m.unknown,
  }
  if (m.has(K.contentId)) {
    res.contentId = tstr(m.get(K.contentId), at(path, K.contentId), 1, 128)
  }
  return res
}

export function parseDraft(
  typeId: number,
  payload: FrankValue,
  allow: boolean,
  schema: SchemaVersionContext = {
    envelope: 1,
    effective: 1,
  },
  featureCodecs: ReadonlyMap<
    number,
    FeatureCodecDescriptor
  > = DEFAULT_FEATURE_CODEC_MAP,
): DraftPayload {
  const K = DIRECTORY_STATEMENT
  const feature = featureCodecs.get(typeId)
  if (feature) {
    return feature.parseDraft(payload, allow, schema)
  }
  const P = 'root/payload'
  switch (typeId) {
    case TYPE_DIRECT_MESSAGE_DELIVERY: {
      const K = DIRECT_MESSAGE_DELIVERY
      // Schema 2 carries an unpaid message: the payment list may be empty or absent. Schema 1
      // keeps its required list of at least one member. Same rule as frank-cbor's `parse_draft`.
      const unpaidAllowed = schema.effective >= 2
      const m = unpaidAllowed
        ? shaped(payload, P, DIRECT_MESSAGE_DELIVERY_V2_SHAPE, allow)
        : shaped(payload, P, DIRECT_MESSAGE_DELIVERY_V1_SHAPE, allow)
      const res: DirectMessageDelivery<Uint8Array> = {
        type: TYPE_DIRECT_MESSAGE_DELIVERY,
        network: networkTag(m.get(K.network), at(P, K.network)),
        destination: account(m.get(K.destination), at(P, K.destination)),
        payloadFrame: framed(m.get(K.payloadFrame), at(P, K.payloadFrame)),
        payloadDigest: bstr(
          m.get(K.payloadDigest),
          at(P, K.payloadDigest),
          32,
          32,
        ),
        payments: m.has(K.payments)
          ? asList(
              m.get(K.payments),
              at(P, K.payments),
              unpaidAllowed ? 0 : 1,
              MAX_PAYMENT_MEMBERS,
            ).map((e, i) => paymentMember(e, `${at(P, K.payments)}[${i}]`))
          : [],
        unknownFields: m.unknown,
      }
      if (m.has(K.recipient)) {
        const recipient = account(m.get(K.recipient), at(P, K.recipient))
        if (recipient.keyType !== KEY_TYPE.secp256k1) {
          throw bad(at(P, K.recipient), 'recipient key type must be 1')
        }
        res.recipient = recipient
      }
      if (m.has(K.dleqProof)) {
        res.dleqProof = proof(m.get(K.dleqProof), at(P, K.dleqProof))
      }
      return res
    }
    case TYPE_DIRECTORY_ATTESTATION: {
      const K = DIRECTORY_ATTESTATION
      const m = shaped(payload, P, DIRECTORY_ATTESTATION_SHAPE, allow)
      return {
        type: TYPE_DIRECTORY_ATTESTATION,
        statementFrame: framed(
          m.get(K.statementFrame),
          at(P, K.statementFrame),
        ),
        signatures: asList(
          m.get(K.signatures),
          at(P, K.signatures),
          1,
          MAX_SIGNATURES,
        ).map((e, i) => signatureEntry(e, `${at(P, K.signatures)}[${i}]`)),
        unknownFields: m.unknown,
      }
    }
    case TYPE_MAILBOX_CHECKPOINT: {
      const K = MAILBOX_CHECKPOINT
      const m = shaped(payload, P, MAILBOX_CHECKPOINT_SHAPE, allow)
      const cp: DraftPayload = {
        type: TYPE_MAILBOX_CHECKPOINT,
        network: networkTag(m.get(K.network), at(P, K.network)),
        owner: account(m.get(K.owner), at(P, K.owner)),
        checkpointId: bstr(
          m.get(K.checkpointId),
          at(P, K.checkpointId),
          16,
          16,
        ),
        timestamp: timestamp(m.get(K.timestamp), at(P, K.timestamp)),
        facts: asList(m.get(K.facts), at(P, K.facts), 0, MAX_JOURNAL_FACTS).map(
          (e, i) => journalFact(e, `${at(P, K.facts)}[${i}]`, allow),
        ),
        unknownFields: m.unknown,
      }
      if (m.has(K.sections)) {
        cp.sections = asList(
          m.get(K.sections),
          at(P, K.sections),
          0,
          MAX_OPAQUE_SECTIONS,
        ).map((e, i) => opaqueSection(e, `${at(P, K.sections)}[${i}]`))
      }
      return cp
    }
    case TYPE_DIRECTORY_STATEMENT: {
      // Fields 5-7 are optional at every schema; field 8 (the stamp key) is required from
      // schema 2 and undefined in schema 1, where C12 makes it a schema error (S10a.1); field
      // 9 (the profile entries, M4) is optional from schema 3, where a schema-2 reader reads
      // the statement through V6.3 and retains it. `effective` is the exact version, or the
      // reader's highest supported schema when a newer frame is read through V6.3.
      const preview = schema.effective >= 4
      const shape = preview
        ? DIRECTORY_STATEMENT_V4_SHAPE
        : schema.effective >= 3
        ? DIRECTORY_STATEMENT_V3_SHAPE
        : schema.effective >= 2
        ? DIRECTORY_STATEMENT_V2_SHAPE
        : DIRECTORY_STATEMENT_V1_SHAPE
      const m = shaped(payload, P, shape, allow)
      // These allocated old meanings remain unsupported even in a future V6 projection.
      if (
        preview &&
        [K.keyTransitions, K.recoveryAuthorities, K.profileEntries].some(k =>
          m.has(k),
        )
      )
        throw bad(
          P,
          'transitions, recovery and profiles are unsupported in directory preview',
        )
      const st: DraftPayload = {
        type: TYPE_DIRECTORY_STATEMENT,
        network: networkTag(m.get(K.network), at(P, K.network)),
        subject: directoryAccount(m.get(K.subject), at(P, K.subject), preview),
        revision: uintRange(m.get(K.revision), at(P, K.revision), 0n, U64_MAX),
        timestamp: timestamp(m.get(K.timestamp), at(P, K.timestamp)),
        relays: asList(
          m.get(K.relays),
          at(P, K.relays),
          1,
          preview ? 1 : MAX_RELAY_BINDINGS,
        ).map((e, i) =>
          relayBinding(e, `${at(P, K.relays)}[${i}]`, allow, preview),
        ),
        schemaVersion: schema.envelope,
        unknownFields: m.unknown,
      }
      if (m.has(K.stampKey))
        st.stampKey = directoryAccount(
          m.get(K.stampKey),
          at(P, K.stampKey),
          preview,
        )
      if (preview) {
        st.preview = {
          messageDhKey: directoryAccount(
            m.get(K.messageDhKey),
            at(P, K.messageDhKey),
            true,
          ),
          mailboxKeyGeneration: uintRange(
            m.get(K.mailboxKeyGeneration),
            at(P, K.mailboxKeyGeneration),
            0n,
            U64_MAX,
          ),
          stampKeyGeneration: uintRange(
            m.get(K.stampKeyGeneration),
            at(P, K.stampKeyGeneration),
            0n,
            U64_MAX,
          ),
          predecessor:
            m.get(K.predecessorHash) === null
              ? null
              : bstr(
                  m.get(K.predecessorHash),
                  at(P, K.predecessorHash),
                  32,
                  32,
                ),
        }
      }
      // Field 9 is interpreted only by a reader whose highest type-1 schema is 3; a schema-2
      // reader projects the statement through V6.3 and retains it as an unknown field.
      if (m.has(K.profileEntries) && schema.effective >= 3) {
        st.profileEntries = asList(
          m.get(K.profileEntries),
          at(P, K.profileEntries),
          1,
          64,
        ).map((e, i) =>
          profileEntry(e, `${at(P, K.profileEntries)}[${i}]`, allow),
        )
      }
      if (m.has(K.username)) {
        const val14 = m.get(K.username)
        if (typeof val14 === 'string') {
          st.canonicalUsername = tstr(val14, at(P, K.username), 3, 32)
        } else if (Array.isArray(val14)) {
          st.spendKeys = asList(val14, at(P, K.username), 1, 8).map((e, i) =>
            account(e, `${at(P, K.username)}[${i}]`),
          )
        } else {
          st.canonicalUsername = tstr(val14, at(P, K.username), 3, 32)
        }
      }
      if (m.has(K.accountType)) {
        st.accountType = Number(
          uintRange(m.get(K.accountType), at(P, K.accountType), 0n, 3n),
        ) as AccountType
      }
      if (m.has(K.botRole)) {
        st.botRole = Number(
          uintRange(m.get(K.botRole), at(P, K.botRole), 0n, 7n),
        ) as BotRole
      }
      if (m.has(K.keyTransitions)) {
        st.keyTransitions = asList(
          m.get(K.keyTransitions),
          at(P, K.keyTransitions),
          1,
          16,
        ).map((e, i) =>
          keyTransition(e, `${at(P, K.keyTransitions)}[${i}]`, allow),
        )
      }
      if (m.has(K.expiry))
        st.expiry = timestamp(m.get(K.expiry), at(P, K.expiry))
      if (m.has(K.recoveryAuthorities)) {
        st.recoveryAuthorities = asList(
          m.get(K.recoveryAuthorities),
          at(P, K.recoveryAuthorities),
          1,
          8,
        ).map((e, i) => account(e, `${at(P, K.recoveryAuthorities)}[${i}]`))
      }
      return st
    }
    case TYPE_RECIPIENT_ENCRYPTED_PAYLOAD: {
      const K = RECIPIENT_ENCRYPTED_PAYLOAD_V1
      if (schema.effective >= 2) {
        const m = shaped(
          payload,
          P,
          RECIPIENT_ENCRYPTED_PAYLOAD_V2_SHAPE,
          allow,
        )
        return {
          type: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
          schemaVersion: 2,
          network: networkTag(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.network),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.network),
          ),
          sender: account(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.sender),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.sender),
          ),
          recipient: account(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.recipient),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.recipient),
          ),
          suite: u32ish(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.suite),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.suite),
            0,
            65535,
          ),
          cryptoBoxEnvelope: bstr(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.cryptoBoxEnvelope),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.cryptoBoxEnvelope),
            1,
            MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES,
          ),
          ephemeralPoint: point(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.ephemeralPoint),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.ephemeralPoint),
          ),
          sharedPoint: point(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.sharedPoint),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.sharedPoint),
          ),
          dleqProof: proof(
            m.get(RECIPIENT_ENCRYPTED_PAYLOAD_V2.dleqProof),
            at(P, RECIPIENT_ENCRYPTED_PAYLOAD_V2.dleqProof),
          ),
          unknownFields: m.unknown,
        }
      }
      const m = shaped(payload, P, RECIPIENT_ENCRYPTED_PAYLOAD_V1_SHAPE, allow)
      return {
        type: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
        schemaVersion: 1,
        network: networkTag(m.get(K.network), at(P, K.network)),
        sender: account(m.get(K.sender), at(P, K.sender)),
        recipient: account(m.get(K.recipient), at(P, K.recipient)),
        suite: u32ish(m.get(K.suite), at(P, K.suite), 0, 65535),
        nonce: bstr(m.get(K.nonce), at(P, K.nonce), 1, 64),
        ciphertext: bstr(
          m.get(K.ciphertext),
          at(P, K.ciphertext),
          1,
          MAX_CIPHERTEXT_BYTES,
        ),
        ephemeralPoint: point(m.get(K.ephemeralPoint), at(P, K.ephemeralPoint)),
        sharedPoint: point(m.get(K.sharedPoint), at(P, K.sharedPoint)),
        dleqProof: proof(m.get(K.dleqProof), at(P, K.dleqProof)),
        unknownFields: m.unknown,
      }
    }
    case TYPE_ENCRYPTED_MESSAGE_CONTENT: {
      const K = ENCRYPTED_MESSAGE_CONTENT
      // Field 4 is optional on the wire: writers should always send it, and a reader files a
      // message without one under the conversation it would itself open with the sender.
      const m = shaped(payload, P, ENCRYPTED_MESSAGE_CONTENT_SHAPE, allow)
      const convName = m.has(K.conversationName)
        ? conversationName(m.get(K.conversationName), at(P, K.conversationName))
        : undefined
      const transfer = m.has(K.tokenTransfer)
        ? tokenTransfer(m.get(K.tokenTransfer), at(P, K.tokenTransfer), allow)
        : undefined
      return {
        type: TYPE_ENCRYPTED_MESSAGE_CONTENT,
        network: networkTag(m.get(K.network), at(P, K.network)),
        messageId: bstr(m.get(K.messageId), at(P, K.messageId), 16, 16),
        revisionFrame: framed(m.get(K.revisionFrame), at(P, K.revisionFrame)),
        contentDigest: bstr(
          m.get(K.contentDigest),
          at(P, K.contentDigest),
          32,
          32,
        ),
        conversationId: m.has(K.conversationId)
          ? bstr(m.get(K.conversationId), at(P, K.conversationId), 16, 16)
          : undefined,
        conversationName: convName,
        tokenTransfer: transfer,
        unknownFields: m.unknown,
      }
    }
    case TYPE_KEY_TRANSITION_STATEMENT: {
      const K = KEY_TRANSITION_STATEMENT
      const m = shaped(payload, P, KEY_TRANSITION_STATEMENT_SHAPE, allow)
      return {
        type: TYPE_KEY_TRANSITION_STATEMENT,
        network: networkTag(m.get(K.network), at(P, K.network)),
        subject: account(m.get(K.subject), at(P, K.subject)),
        priorAuthority: account(
          m.get(K.priorAuthority),
          at(P, K.priorAuthority),
        ),
        revision: uintRange(m.get(K.revision), at(P, K.revision), 1n, U64_MAX),
        newKey: account(m.get(K.newKey), at(P, K.newKey)),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TOPIC_POST: {
      const K = TOPIC_POST
      const m = shaped(payload, P, TOPIC_POST_SHAPE, allow)
      const body = bstr(m.get(K.body), at(P, K.body), 1, MAX_TOPIC_BODY_BYTES)
      const post: TopicPost<Uint8Array> = {
        type: TYPE_TOPIC_POST,
        network: networkTag(m.get(K.network), at(P, K.network)),
        topic: tstr(m.get(K.topic), at(P, K.topic), 1, 512),
        body,
        ...(schema.effective >= 2
          ? { schemaVersion: 2 as const, content: body }
          : { schemaVersion: 1 as const }),
        unknownFields: m.unknown,
      }
      if (m.has(K.parentHash))
        post.parentHash = bstr(m.get(K.parentHash), at(P, K.parentHash), 32, 32)
      if (m.has(K.author)) {
        const raw = m.get(K.author)
        if (raw instanceof Map) {
          post.from = account(raw, at(P, K.author))
        } else {
          post.from = bstr(raw, at(P, K.author), 20, 33)
        }
      }
      if (m.has(K.signature))
        post.signature = bstr(m.get(K.signature), at(P, K.signature), 1, 512)
      return post
    }
    case TYPE_FORUM_VIEW: {
      const K = FORUM_SINGLE_VIEW
      const m = shaped(payload, P, FORUM_SINGLE_VIEW_SHAPE, allow)
      return {
        type: TYPE_FORUM_VIEW,
        network: networkTag(m.get(K.network), at(P, K.network)),
        postFrame: framed(m.get(K.postFrame), at(P, K.postFrame)),
        author: bstr(m.get(K.author), at(P, K.author), 20, 20),
        authorBurnTx: bstr(
          m.get(K.authorBurnTx),
          at(P, K.authorBurnTx),
          1,
          16384,
        ),
        transactionHash: bstr(
          m.get(K.transactionHash),
          at(P, K.transactionHash),
          32,
          32,
        ),
        firstVisible: timestamp(m.get(K.firstVisible), at(P, K.firstVisible)),
        block: uintRange(m.get(K.block), at(P, K.block), 0n, U64_MAX),
        transactionIndex: uintRange(
          m.get(K.transactionIndex),
          at(P, K.transactionIndex),
          0n,
          U64_MAX,
        ),
        aggregate: forumAggregate(m.get(K.aggregate), at(P, K.aggregate)),
        revision: uintRange(m.get(K.revision), at(P, K.revision), 0n, U64_MAX),
        epoch: bstr(m.get(K.epoch), at(P, K.epoch), 16, 16),
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORUM_TOPIC_PAGE: {
      const K = FORUM_TOPIC_PAGE
      const m = shaped(payload, P, FORUM_TOPIC_PAGE_SHAPE, allow)
      return {
        type: TYPE_FORUM_TOPIC_PAGE,
        network: networkTag(m.get(K.network), at(P, K.network)),
        topic: tstr(m.get(K.topic), at(P, K.topic), 1, 512),
        since: timestamp(m.get(K.since), at(P, K.since)),
        revision: uintRange(m.get(K.revision), at(P, K.revision), 0n, U64_MAX),
        rows: asList(m.get(K.rows), at(P, K.rows), 0, MAX_FORUM_ROWS).map(
          (row, i) => framed(row, `${at(P, K.rows)}[${i}]`),
        ),
        nextCursor: m.has(K.nextCursor)
          ? bstr(
              m.get(K.nextCursor),
              at(P, K.nextCursor),
              1,
              MAX_FORUM_CURSOR_BYTES,
            )
          : undefined,
        requestCursor: m.has(K.requestCursor)
          ? bstr(
              m.get(K.requestCursor),
              at(P, K.requestCursor),
              1,
              MAX_FORUM_CURSOR_BYTES,
            )
          : undefined,
        epoch: bstr(m.get(K.epoch), at(P, K.epoch), 16, 16),
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORUM_DISCOVERY_PAGE: {
      const K = FORUM_DISCOVERY_PAGE
      const m = shaped(payload, P, FORUM_DISCOVERY_PAGE_SHAPE, allow)
      return {
        type: TYPE_FORUM_DISCOVERY_PAGE,
        network: networkTag(m.get(K.network), at(P, K.network)),
        revision: uintRange(m.get(K.revision), at(P, K.revision), 0n, U64_MAX),
        entries: asList(
          m.get(K.entries),
          at(P, K.entries),
          0,
          MAX_FORUM_ROWS,
        ).map((row, i) => {
          const path = `${at(P, K.entries)}[${i}]`,
            r = shaped(row, path, FORUM_DISCOVERY_ENTRY_SHAPE, allow)
          return {
            topic: tstr(
              r.get(FORUM_DISCOVERY_ENTRY.topic),
              at(path, FORUM_DISCOVERY_ENTRY.topic),
              1,
              512,
            ),
            count: uintRange(
              r.get(FORUM_DISCOVERY_ENTRY.count),
              at(path, FORUM_DISCOVERY_ENTRY.count),
              0n,
              U64_MAX,
            ),
            lastActivity: timestamp(
              r.get(FORUM_DISCOVERY_ENTRY.lastActivity),
              at(path, FORUM_DISCOVERY_ENTRY.lastActivity),
            ),
            unknownFields: r.unknown,
          }
        }),
        nextCursor: m.has(K.nextCursor)
          ? bstr(
              m.get(K.nextCursor),
              at(P, K.nextCursor),
              1,
              MAX_FORUM_CURSOR_BYTES,
            )
          : undefined,
        requestCursor: m.has(K.requestCursor)
          ? bstr(
              m.get(K.requestCursor),
              at(P, K.requestCursor),
              1,
              MAX_FORUM_CURSOR_BYTES,
            )
          : undefined,
        epoch: bstr(m.get(K.epoch), at(P, K.epoch), 16, 16),
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORUM_OPERATION_STATUS: {
      const K = FORUM_OPERATION_STATUS
      const m = shaped(payload, P, FORUM_OPERATION_STATUS_SHAPE, allow)
      const common = {
        type: TYPE_FORUM_OPERATION_STATUS,
        network: networkTag(m.get(K.network), at(P, K.network)),
        submittedFrame: framed(
          m.get(K.submittedFrame),
          at(P, K.submittedFrame),
        ),
        targetHash: bstr(m.get(K.targetHash), at(P, K.targetHash), 32, 32),
        transactionHash: bstr(
          m.get(K.transactionHash),
          at(P, K.transactionHash),
          32,
          32,
        ),
        sender: bstr(m.get(K.sender), at(P, K.sender), 20, 20),
        direction: u32ish(m.get(K.direction), at(P, K.direction), 0, 1) as
          | 0
          | 1,
        value: uintRange(m.get(K.value), at(P, K.value), 0n, U64_MAX),
        revision: uintRange(m.get(K.revision), at(P, K.revision), 0n, U64_MAX),
        epoch: bstr(m.get(K.epoch), at(P, K.epoch), 16, 16),
        unknownFields: m.unknown,
      }
      const { pending: PENDING, confirmed: CONFIRMED } = FORUM_OPERATION_STATE
      const state = u32ish(m.get(K.state), at(P, K.state), 0, 3)
      if (
        m.has(K.block) !== (state === CONFIRMED) ||
        m.has(K.transactionIndex) !== (state === CONFIRMED)
      )
        throw bad(P, 'confirmation position iff confirmed')
      if (
        (state === PENDING || state === CONFIRMED) &&
        (common.value === 0n || common.value > I64_MAX)
      )
        throw bad(at(P, K.value), 'observed burn outside 1..i64::MAX')
      if (state === CONFIRMED)
        return {
          ...common,
          state,
          evidence: 'relay-observed',
          block: uintRange(m.get(K.block), at(P, K.block), 0n, U64_MAX),
          transactionIndex: uintRange(
            m.get(K.transactionIndex),
            at(P, K.transactionIndex),
            0n,
            U64_MAX,
          ),
        }
      if (state === PENDING)
        return { ...common, state, evidence: 'relay-observed' }
      return {
        ...common,
        state: state as 0 | 3,
        evidence: 'unverified-request',
      }
    }
    case TYPE_TOPIC_POST_SUBMISSION: {
      const K = TOPIC_POST_SUBMISSION
      const m = shaped(payload, P, TOPIC_POST_SUBMISSION_SHAPE, allow)
      return {
        type: TYPE_TOPIC_POST_SUBMISSION,
        network: networkTag(m.get(K.network), at(P, K.network)),
        postFrame: framed(m.get(K.postFrame), at(P, K.postFrame)),
        burnTx: bstr(m.get(K.burnTx), at(P, K.burnTx), 1, 16384),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TOPIC_VOTE_SUBMISSION: {
      const K = TOPIC_VOTE_SUBMISSION
      const m = shaped(payload, P, TOPIC_VOTE_SUBMISSION_SHAPE, allow)
      return {
        type: TYPE_TOPIC_VOTE_SUBMISSION,
        network: networkTag(m.get(K.network), at(P, K.network)),
        targetHash: bstr(m.get(K.targetHash), at(P, K.targetHash), 32, 32),
        burnTx: bstr(m.get(K.burnTx), at(P, K.burnTx), 1, 16384),
        unknownFields: m.unknown,
      }
    }
    case TYPE_MESSAGE_CONTENT_REVISION: {
      const K = MESSAGE_CONTENT_REVISION
      const m = shaped(payload, P, MESSAGE_CONTENT_REVISION_SHAPE, allow)
      if (m.get(K.network) !== 'frank')
        throw bad(
          at(P, K.network),
          'the type-20 domain must be the text "frank"',
        )
      return {
        type: TYPE_MESSAGE_CONTENT_REVISION,
        items: asList(
          m.get(K.items),
          at(P, K.items),
          1,
          MAX_MESSAGE_ITEMS_PER_ARRAY,
        ).map((e, i) => framed(e, `${at(P, K.items)}[${i}]`)),
        unknownFields: m.unknown,
      }
    }
    case TYPE_CONTAINER_MESSAGE_ITEM: {
      const K = CONTAINER_MESSAGE_ITEM
      const m = shaped(payload, P, CONTAINER_MESSAGE_ITEM_SHAPE, allow)
      return {
        type: TYPE_CONTAINER_MESSAGE_ITEM,
        items: asList(
          m.get(K.items),
          at(P, K.items),
          1,
          MAX_MESSAGE_ITEMS_PER_ARRAY,
        ).map((e, i) => framed(e, `${at(P, K.items)}[${i}]`)),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TEXT_MESSAGE_ITEM: {
      const m = shaped(payload, P, TEXT_MESSAGE_ITEM_SHAPE, allow)
      return {
        type: TYPE_TEXT_MESSAGE_ITEM,
        text: tstr(
          m.get(TEXT_MESSAGE_ITEM.text),
          at(P, TEXT_MESSAGE_ITEM.text),
          0,
          262144,
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_STEALTH_MESSAGE_ITEM: {
      const K = STEALTH_MESSAGE_ITEM
      if (schema.effective >= 2) {
        const m = shaped(payload, P, STEALTH_ASSET_MESSAGE_ITEM_SHAPE, allow)
        return {
          type: TYPE_STEALTH_MESSAGE_ITEM,
          transfers: asList(
            m.get(STEALTH_ASSET_MESSAGE_ITEM.transfers),
            at(P, STEALTH_ASSET_MESSAGE_ITEM.transfers),
            1,
            16,
          ).map((entry, index) =>
            stealthAssetTransfer(
              entry,
              `${at(P, STEALTH_ASSET_MESSAGE_ITEM.transfers)}[${index}]`,
            ),
          ),
          memo: m.has(STEALTH_ASSET_MESSAGE_ITEM.memo)
            ? tstr(
                m.get(STEALTH_ASSET_MESSAGE_ITEM.memo),
                at(P, STEALTH_ASSET_MESSAGE_ITEM.memo),
                0,
                1024,
              )
            : undefined,
          unknownFields: m.unknown,
        }
      }
      const m = shaped(payload, P, STEALTH_MESSAGE_ITEM_SHAPE, allow)
      return {
        type: TYPE_STEALTH_MESSAGE_ITEM,
        networkTag: tstr(m.get(K.networkTag), at(P, K.networkTag), 1, 64),
        ephemeralPubKey: account(
          m.get(K.ephemeralPubKey),
          at(P, K.ephemeralPubKey),
        ),
        transactions: asList(
          m.get(K.transactions),
          at(P, K.transactions),
          1,
          16,
        ).map((e, i) => bstr(e, `${at(P, K.transactions)}[${i}]`, 1, 16384)),
        amount: uintRange(m.get(K.amount), at(P, K.amount), 0n, U64_MAX),
        memo: m.has(K.memo)
          ? tstr(m.get(K.memo), at(P, K.memo), 0, 1024)
          : undefined,
        unknownFields: m.unknown,
      }
    }
    case TYPE_CHANNEL_UPDATE: {
      const K = CHANNEL_UPDATE_ITEM
      const m = shaped(payload, P, CHANNEL_UPDATE_ITEM_SHAPE, allow)
      return {
        type: TYPE_CHANNEL_UPDATE,
        channelId: bstr(m.get(K.channelId), at(P, K.channelId), 32, 32),
        appId: tstr(m.get(K.appId), at(P, K.appId), 1, 64),
        sequenceNumber: u32ish(
          m.get(K.sequenceNumber),
          at(P, K.sequenceNumber),
          0,
          4294967295,
        ),
        allocations: asList(
          m.get(K.allocations),
          at(P, K.allocations),
          1,
          8,
        ).map((a, i) => chainAllocation(a, `${at(P, K.allocations)}[${i}]`)),
        appState: bstr(m.get(K.appState), at(P, K.appState), 0, 65536),
        signatures: asList(m.get(K.signatures), at(P, K.signatures), 1, 4).map(
          (s, i) => signatureEntry(s, `${at(P, K.signatures)}[${i}]`),
        ),
        settlementRef: m.has(K.settlementRef)
          ? bstr(m.get(K.settlementRef), at(P, K.settlementRef), 1, 128)
          : undefined,
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORWARDING_DELIVERY_ENVELOPE: {
      const K = FORWARDING_DELIVERY_ENVELOPE
      const m = shaped(payload, P, FORWARDING_DELIVERY_ENVELOPE_SHAPE, allow)
      const res: ForwardingDeliveryEnvelope<Uint8Array> = {
        type: TYPE_FORWARDING_DELIVERY_ENVELOPE,
        network: networkTag(m.get(K.network), at(P, K.network)),
        destination: account(m.get(K.destination), at(P, K.destination)),
        payloadFrame: framed(m.get(K.payloadFrame), at(P, K.payloadFrame)),
        payloadDigest: bstr(
          m.get(K.payloadDigest),
          at(P, K.payloadDigest),
          32,
          32,
        ),
        payments: asList(
          m.get(K.payments),
          at(P, K.payments),
          1,
          MAX_PAYMENT_MEMBERS,
        ).map((e, i) => paymentMember(e, `${at(P, K.payments)}[${i}]`)),
        unknownFields: m.unknown,
      }
      if (m.has(K.endpoint)) {
        res.endpoint = tstr(m.get(K.endpoint), at(P, K.endpoint), 1, 256)
      }
      if (m.has(K.expiresAt)) {
        res.expiresAt = u32ish(
          m.get(K.expiresAt),
          at(P, K.expiresAt),
          0,
          4294967295,
        )
      }
      return res
    }
    case TYPE_EMAIL_MESSAGE_ITEM: {
      const K = EMAIL_MESSAGE_ITEM
      const m = shaped(payload, P, EMAIL_MESSAGE_ITEM_SHAPE, allow)
      const res: EmailMessageItem = {
        type: TYPE_EMAIL_MESSAGE_ITEM,
        messageId: emailMessageId(m.get(K.messageId), at(P, K.messageId)),
        from: emailParty(m.get(K.from), at(P, K.from), allow),
        to: asList(m.get(K.to), at(P, K.to), 1, MAX_EMAIL_RECIPIENTS).map(
          (e, i) => emailParty(e, `${at(P, K.to)}[${i}]`, allow),
        ),
        subject: tstr(m.get(K.subject), at(P, K.subject), 0, 1024),
        textBody: tstr(m.get(K.textBody), at(P, K.textBody), 0, 262144),
        unknownFields: m.unknown,
      }
      if (m.has(K.cc)) {
        res.cc = asList(m.get(K.cc), at(P, K.cc), 0, MAX_EMAIL_RECIPIENTS).map(
          (e, i) => emailParty(e, `${at(P, K.cc)}[${i}]`, allow),
        )
      }
      if (m.has(K.htmlBody)) {
        res.htmlBody = tstr(m.get(K.htmlBody), at(P, K.htmlBody), 0, 524288)
      }
      if (m.has(K.inReplyTo)) {
        res.inReplyTo = emailMessageId(m.get(K.inReplyTo), at(P, K.inReplyTo))
      }
      if (m.has(K.references)) {
        res.references = asList(
          m.get(K.references),
          at(P, K.references),
          0,
          64,
        ).map((e, i) => emailMessageId(e, `${at(P, K.references)}[${i}]`))
      }
      if (m.has(K.attachments)) {
        res.attachments = asList(
          m.get(K.attachments),
          at(P, K.attachments),
          0,
          MAX_EMAIL_ATTACHMENTS,
        ).map((e, i) =>
          emailAttachment(e, `${at(P, K.attachments)}[${i}]`, allow),
        )
      }
      if (m.has(K.replyTo)) {
        res.replyTo = emailParty(m.get(K.replyTo), at(P, K.replyTo), allow)
      }
      return res
    }
    case TYPE_PLUGIN_MESSAGE_ITEM: {
      const K = PLUGIN_MESSAGE_ITEM
      const m = shaped(payload, P, PLUGIN_MESSAGE_ITEM_SHAPE, allow)
      const itemType = tstr(
        m.get(K.itemType),
        at(P, K.itemType),
        1,
        MAX_PLUGIN_ITEM_TYPE_BYTES,
      )
      if (!isPluginItemType(itemType))
        throw bad(
          at(P, K.itemType),
          'a plugin item type is lowercase letters and digits in hyphen-separated groups',
        )
      return {
        type: TYPE_PLUGIN_MESSAGE_ITEM,
        itemType,
        data: bstr(
          m.get(K.data),
          at(P, K.data),
          0,
          MAX_PLUGIN_ITEM_PAYLOAD_BYTES,
        ),
        unknownFields: m.unknown,
      }
    }
    default:
      throw new Error(`parseDraft: type ${typeId} has no schema`)
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.3
// ---------------------------------------------------------------------------------------------

const unsupported = (path: string, message: string) =>
  fail('unsupported', '8.3', path, message)

const ALLOCATED_KEY_TYPES: ReadonlySet<number> = new Set(
  Object.values(KEY_TYPE),
)

function checkKeyType(a: AccountRef, path: string): void {
  if (!ALLOCATED_KEY_TYPES.has(a.keyType)) {
    throw unsupported(path, `unallocated key type ${a.keyType} (S2)`)
  }
}

/** S2b: algorithm / key type / signature-length pairing. */
function checkSignatureShape(
  algorithm: number,
  signer: AccountRef,
  signature: Uint8Array,
  path: string,
): void {
  let keyType: number
  let ok: boolean
  switch (algorithm) {
    case SIGNATURE_ALGORITHM.secp256k1EcdsaDer:
      keyType = KEY_TYPE.secp256k1
      ok = signature.length >= 8 && signature.length <= 72
      break
    case SIGNATURE_ALGORITHM.bip340Schnorr:
      keyType = KEY_TYPE.secp256k1XOnly
      ok = signature.length === 64
      break
    case SIGNATURE_ALGORITHM.bchSchnorr:
      keyType = KEY_TYPE.secp256k1
      ok = signature.length === 64
      break
    case SIGNATURE_ALGORITHM.ed25519:
      keyType = KEY_TYPE.ed25519
      ok = signature.length === 64
      break
    default:
      throw unsupported(
        path,
        `unallocated signature algorithm ${algorithm} (S2a)`,
      )
  }
  if (signer.keyType !== keyType || !ok) {
    throw unsupported(
      path,
      'algorithm/key-type/length combination is not allocated (S2b)',
    )
  }
}

/** Stage 8.3: allocated-identifier checks that need only the draft. */
export function checkAllocated(
  d: DraftPayload,
  featureCodecs: ReadonlyMap<
    number,
    FeatureCodecDescriptor
  > = DEFAULT_FEATURE_CODEC_MAP,
): void {
  const feature = featureCodecs.get(d.type)
  if (feature) {
    feature.checkAllocated?.(d)
    return
  }
  const P = 'root/payload'
  switch (d.type) {
    case TYPE_DIRECT_MESSAGE_DELIVERY: {
      const K = DIRECT_MESSAGE_DELIVERY
      checkKeyType(d.destination, at(P, K.destination))
      if (d.recipient) checkKeyType(d.recipient, at(P, K.recipient))
      break
    }
    case TYPE_DIRECTORY_ATTESTATION:
      d.signatures.forEach((s, i) => {
        const p = atItem(P, DIRECTORY_ATTESTATION.signatures, i)
        checkKeyType(s.signer, at(p, SIGNATURE_ENTRY.signer))
        checkSignatureShape(s.algorithm, s.signer, s.signature, p)
      })
      break
    case TYPE_MAILBOX_CHECKPOINT:
      checkKeyType(d.owner, at(P, MAILBOX_CHECKPOINT.owner))
      break
    case TYPE_DIRECTORY_STATEMENT: {
      const K = DIRECTORY_STATEMENT
      checkKeyType(d.subject, at(P, K.subject))
      d.relays.forEach((r, i) =>
        checkKeyType(
          r.identity,
          at(atItem(P, K.relays, i), RELAY_BINDING.identity),
        ),
      )
      if (d.stampKey) checkKeyType(d.stampKey, at(P, K.stampKey))
      if (d.preview) checkKeyType(d.preview.messageDhKey, at(P, K.messageDhKey))
      d.keyTransitions?.forEach((t, i) => {
        const p = atItem(P, K.keyTransitions, i)
        checkKeyType(t.signer, at(p, KEY_TRANSITION.signer))
        checkSignatureShape(t.algorithm, t.signer, t.signature, p)
      })
      d.recoveryAuthorities?.forEach((a, i) =>
        checkKeyType(a, atItem(P, K.recoveryAuthorities, i)),
      )
      break
    }
    case TYPE_RECIPIENT_ENCRYPTED_PAYLOAD: {
      // Fields 1-3 have the same keys in schemas 1 and 2.
      const K = RECIPIENT_ENCRYPTED_PAYLOAD_V2
      checkKeyType(d.sender, at(P, K.sender))
      checkKeyType(d.recipient, at(P, K.recipient))
      if (
        (d.schemaVersion === 1 && d.suite !== ENCRYPTION_SUITE_PROOF) ||
        (d.schemaVersion === 2 && d.suite !== ENCRYPTION_SUITE_DM_AUTH_XCHACHA)
      ) {
        throw unsupported(
          at(P, K.suite),
          `encryption suite ${d.suite} is unallocated (S2c)`,
        )
      }
      break
    }
    case TYPE_KEY_TRANSITION_STATEMENT: {
      const K = KEY_TRANSITION_STATEMENT
      checkKeyType(d.subject, at(P, K.subject))
      checkKeyType(d.priorAuthority, at(P, K.priorAuthority))
      checkKeyType(d.newKey, at(P, K.newKey))
      break
    }
    case TYPE_STEALTH_MESSAGE_ITEM:
      if ('transfers' in d) {
        d.transfers.forEach((entry, index) => {
          const p = atItem(P, STEALTH_ASSET_MESSAGE_ITEM.transfers, index)
          checkKeyType(
            entry.recipientSpendKey,
            at(p, STEALTH_ASSET_TRANSFER.recipientSpendKey),
          )
          checkKeyType(
            entry.transfer.stealthMetadata!.ephemeralPubKey,
            at(
              at(
                at(p, STEALTH_ASSET_TRANSFER.transfer),
                PAYMENT_TRANSFER.stealthMetadata,
              ),
              STEALTH_METADATA.ephemeralPubKey,
            ),
          )
        })
      } else
        checkKeyType(
          d.ephemeralPubKey,
          at(P, STEALTH_MESSAGE_ITEM.ephemeralPubKey),
        )
      break
    case TYPE_CHANNEL_UPDATE: {
      const K = CHANNEL_UPDATE_ITEM
      d.allocations.forEach((a, i) => {
        a.balances.forEach((b, j) => {
          checkKeyType(
            b.participant,
            at(
              atItem(atItem(P, K.allocations, i), CHAIN_ALLOCATION.balances, j),
              PARTICIPANT_BALANCE.participant,
            ),
          )
        })
      })
      d.signatures.forEach((s, i) => {
        const p = atItem(P, K.signatures, i)
        checkKeyType(s.signer, at(p, SIGNATURE_ENTRY.signer))
        checkSignatureShape(s.algorithm, s.signer, s.signature, p)
      })
      break
    }
    case TYPE_FORWARDING_DELIVERY_ENVELOPE:
      checkKeyType(
        d.destination,
        at(P, FORWARDING_DELIVERY_ENVELOPE.destination),
      )
      break
    case TYPE_EMAIL_MESSAGE_ITEM: {
      const K = EMAIL_MESSAGE_ITEM
      const account = EMAIL_PARTY.frankAccount
      if (d.from.frankAccount)
        checkKeyType(d.from.frankAccount, at(at(P, K.from), account))
      d.to.forEach((p, i) => {
        if (p.frankAccount)
          checkKeyType(p.frankAccount, at(atItem(P, K.to, i), account))
      })
      d.cc?.forEach((p, i) => {
        if (p.frankAccount)
          checkKeyType(p.frankAccount, at(atItem(P, K.cc, i), account))
      })
      if (d.replyTo?.frankAccount)
        checkKeyType(d.replyTo.frankAccount, at(at(P, K.replyTo), account))
      break
    }
    default:
  }
}

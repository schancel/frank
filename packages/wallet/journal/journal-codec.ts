/**
 * Canonical CBOR codecs for self-addressed journal message items:
 * - `outbox-message` ({@link OutboxMessageItem})
 * - `message-tombstone` ({@link MessageTombstoneItem})
 * - `journal-checkpoint` ({@link JournalCheckpointItem})
 */
import { standaloneItemBudget } from '@frank/codec'
import type {
  JournalCheckpointConversationEntry,
  JournalCheckpointItem,
  MessageTombstoneItem,
  OutboxMessageItem,
} from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  MessageItemEncodeError,
  type MessageItemDecodeContext,
} from '../message-item-plugins/registry'
import {
  amount,
  cborItemCodec,
  evmAddress,
  hash32,
  hex,
  listOf,
  matching,
  opt,
  recordOf,
  req,
  str,
  struct,
  timestampMs,
  type Field,
} from '../message-item-plugins/shared/cbor-fields'

export const MAX_JOURNAL_SUBJECT_BYTES = 160
export const MAX_OUTBOX_ITEM_FRAMES = 32
export const MAX_OUTBOX_ITEM_FRAME_BYTES = 65_536
export const MAX_CHECKPOINT_CONVERSATIONS = 1024
export const MAX_CHECKPOINT_TOMBSTONES_PER_CONVERSATION = 1024

const uuidField: Field<string> = matching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'a lowercase UUID',
)

const subjectField: Field<string> = matching(
  /^(?:|\S(?:[^\r\n\0]*\S)?)$/,
  'a trimmed subject with no line breaks',
)
const boundedSubjectField: Field<string> = {
  enc: (v, path) =>
    subjectField.enc(str(MAX_JOURNAL_SUBJECT_BYTES).enc(v, path) as string, path),
  dec: (v, path) =>
    subjectField.dec(str(MAX_JOURNAL_SUBJECT_BYTES).dec(v, path), path),
}

const compressedPubKeyField: Field<string> = matching(
  /^0[23][0-9a-fA-F]{64}$/,
  'a 33-byte compressed secp256k1 public key in hex',
)

const defaultDecodeContext = (): MessageItemDecodeContext => ({
  budget: standaloneItemBudget(),
})

// ---------------------------------------------------------------------------
// 1. OutboxMessageItem Codec ('outbox-message')
// ---------------------------------------------------------------------------

const rawOutboxMessageCodec = cborItemCodec<OutboxMessageItem>(
  'outbox-message',
  {
    payloadDigest: req(0, hash32),
    recipientAddress: req(1, evmAddress),
    sentAt: req(2, timestampMs),
    conversationId: opt(3, uuidField),
    conversationName: opt(4, boundedSubjectField),
    messageId: opt(5, uuidField),
    stampValueWei: opt(6, amount),
    recipientPublicKey: opt(7, compressedPubKeyField),
    itemFrames: opt(
      8,
      listOf(hex(1, MAX_OUTBOX_ITEM_FRAME_BYTES), MAX_OUTBOX_ITEM_FRAMES),
    ),
    text: opt(9, str(16_384, 1)),
  },
)

export const outboxMessageCodec = {
  encode(item: OutboxMessageItem): Uint8Array {
    return rawOutboxMessageCodec.encode(item)
  },
  decode(
    bytes: Uint8Array,
    context: MessageItemDecodeContext = defaultDecodeContext(),
  ): OutboxMessageItem {
    return rawOutboxMessageCodec.decode(bytes, context)
  },
}

// ---------------------------------------------------------------------------
// 2. MessageTombstoneItem Codec ('message-tombstone')
// ---------------------------------------------------------------------------

const rawMessageTombstoneCodec = cborItemCodec<MessageTombstoneItem>(
  'message-tombstone',
  {
    conversationId: req(0, uuidField),
    peer: req(1, evmAddress),
    payloadDigest: req(2, hash32),
    deletedAt: req(3, timestampMs),
  },
)

export const messageTombstoneCodec = {
  encode(item: MessageTombstoneItem): Uint8Array {
    return rawMessageTombstoneCodec.encode(item)
  },
  decode(
    bytes: Uint8Array,
    context: MessageItemDecodeContext = defaultDecodeContext(),
  ): MessageTombstoneItem {
    return rawMessageTombstoneCodec.decode(bytes, context)
  },
}

// ---------------------------------------------------------------------------
// 3. JournalCheckpointItem Codec ('journal-checkpoint')
// ---------------------------------------------------------------------------

const checkpointConversationEntryField =
  struct<JournalCheckpointConversationEntry>({
    conversationId: req(0, uuidField),
    peer: req(1, evmAddress),
    clearedBefore: opt(2, timestampMs),
    readUpTo: opt(3, timestampMs),
    subject: opt(4, boundedSubjectField),
    subjectSetAt: opt(5, timestampMs),
    tombstones: opt(
      6,
      recordOf(
        hash32,
        timestampMs,
        MAX_CHECKPOINT_TOMBSTONES_PER_CONVERSATION,
      ),
    ),
  })

const rawJournalCheckpointCodec = cborItemCodec<JournalCheckpointItem>(
  'journal-checkpoint',
  {
    checkpointTimestamp: req(0, timestampMs),
    conversations: req(
      1,
      listOf(checkpointConversationEntryField, MAX_CHECKPOINT_CONVERSATIONS),
    ),
  },
)

function checkCheckpointItem(item: JournalCheckpointItem): string | undefined {
  for (const entry of item.conversations) {
    if ((entry.subject === undefined) !== (entry.subjectSetAt === undefined)) {
      return 'subject and subjectSetAt must be present together'
    }
  }
  return undefined
}

export const journalCheckpointCodec = {
  encode(item: JournalCheckpointItem): Uint8Array {
    const bytes = rawJournalCheckpointCodec.encode(item)
    const refused = checkCheckpointItem(item)
    if (refused) throw new MessageItemEncodeError('journal-checkpoint', refused)
    return bytes
  },
  decode(
    bytes: Uint8Array,
    context: MessageItemDecodeContext = defaultDecodeContext(),
  ): JournalCheckpointItem {
    const item = rawJournalCheckpointCodec.decode(bytes, context)
    const refused = checkCheckpointItem(item)
    if (refused) throw new MessageItemDecodeError('journal-checkpoint', refused)
    return item
  },
}

/**
 * Formal Join-Semilattice State for Multi-Device Chat & Account Journals.
 *
 * Every state component is a mathematical join-semilattice $(S, \sqcup)$ satisfying:
 *   1. Commutativity:  $a \sqcup b = b \sqcup a$
 *   2. Associativity:  $(a \sqcup b) \sqcup c = a \sqcup (b \sqcup c)$
 *   3. Idempotence:    $a \sqcup a = a$
 *
 * Pure TypeScript — zero Pinia, Vue, or DOM dependencies.
 */
import type {
  ConversationStateItem,
  JournalCheckpointConversationEntry,
  JournalCheckpointItem,
  MessageItem,
  MessageTombstoneItem,
  OutboxMessageItem,
} from '@frank/cashweb/types/messages'
import {
  formatConversationId,
  uuidv5Bytes,
} from '@frank/cashweb/relay/conversation-id'

// ---------------------------------------------------------------------------
// 1. Delivery Status Join-Semilattice: sending < error < confirmed
// ---------------------------------------------------------------------------

export type DeliveryStatus = 'sending' | 'error' | 'confirmed'

export const DELIVERY_STATUS_RANK: Readonly<Record<DeliveryStatus, number>> = {
  sending: 0,
  error: 1,
  confirmed: 2,
}

/**
 * Normalizes any store or wire message status string into the canonical {@link DeliveryStatus}
 * semilattice carrier (`sending < error < confirmed`).
 */
export function toDeliveryStatus(status: string | undefined): DeliveryStatus {
  if (status === 'confirmed') return 'confirmed'
  if (status === 'error') return 'error'
  return 'sending'
}

/**
 * Least upper bound on delivery status: `sending < error < confirmed`.
 */
export function joinDeliveryStatus(
  a: DeliveryStatus,
  b: DeliveryStatus,
): DeliveryStatus {
  return DELIVERY_STATUS_RANK[a] >= DELIVERY_STATUS_RANK[b] ? a : b
}

// ---------------------------------------------------------------------------
// 2. Timestamp Authority Join-Semilattice
// ---------------------------------------------------------------------------

export interface TimestampedAuthority {
  readonly serverTime: number
  readonly receivedTime?: number
  readonly localTime?: boolean
}

export interface ResolvedTimestampAuthority {
  readonly serverTime: number
  readonly receivedTime: number
  readonly localTime: boolean
}

function minPositiveOrMax(a: number, b: number): number {
  if (a > 0 && b > 0) return Math.min(a, b)
  return Math.max(a, b)
}

/**
 * Joins two timestamp observations for the same message digest:
 * - Relay-assigned timestamps (`localTime === false`) strictly dominate optimistic local
 *   timestamps (`localTime === true`), regardless of numeric value or arrival order.
 * - Between two authoritative relay observations (`localTime === false`), the earliest positive
 *   delivery timestamp wins deterministically.
 * - Between two optimistic local observations (`localTime === true`), the earliest positive
 *   timestamp wins deterministically.
 */
export function joinMessageTimestamp(
  a: TimestampedAuthority,
  b: TimestampedAuthority,
): ResolvedTimestampAuthority {
  const aLocal = a.localTime === true
  const bLocal = b.localTime === true
  const aReceived = a.receivedTime ?? a.serverTime
  const bReceived = b.receivedTime ?? b.serverTime

  if (!aLocal && bLocal) {
    return {
      serverTime: a.serverTime,
      receivedTime: aReceived,
      localTime: false,
    }
  }
  if (aLocal && !bLocal) {
    return {
      serverTime: b.serverTime,
      receivedTime: bReceived,
      localTime: false,
    }
  }
  return {
    serverTime: minPositiveOrMax(a.serverTime, b.serverTime),
    receivedTime: minPositiveOrMax(aReceived, bReceived),
    localTime: aLocal && bLocal,
  }
}

// ---------------------------------------------------------------------------
// 3. LWW Subject Register Join-Semilattice
// ---------------------------------------------------------------------------

export interface SubjectRegister {
  readonly subject: string | undefined
  readonly subjectSetAt: number
}

export const BOTTOM_SUBJECT_REGISTER: SubjectRegister = Object.freeze({
  subject: undefined,
  subjectSetAt: 0,
})

/**
 * Trims a subject and normalizes empty/whitespace-only strings to `undefined`.
 */
export function normalizeSubject(
  subject: string | undefined,
): string | undefined {
  if (subject === undefined) return undefined
  const trimmed = subject.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Least upper bound on `(subject, subjectSetAt)`:
 * - Higher `subjectSetAt` strictly wins.
 * - Tie-breaker on equal `subjectSetAt`: lexicographically greater normalized subject text
 *   (`(a.subject ?? '') >= (b.subject ?? '')`), where `undefined` (removed/empty) maps to `''`.
 */
export function joinSubjectRegister(
  a: SubjectRegister,
  b: SubjectRegister,
): SubjectRegister {
  const normA = normalizeSubject(a.subject)
  const normB = normalizeSubject(b.subject)
  const setAtA = Math.max(0, a.subjectSetAt)
  const setAtB = Math.max(0, b.subjectSetAt)

  if (setAtA !== setAtB) {
    return setAtA > setAtB
      ? { subject: normA, subjectSetAt: setAtA }
      : { subject: normB, subjectSetAt: setAtB }
  }
  return (normA ?? '') >= (normB ?? '')
    ? { subject: normA, subjectSetAt: setAtA }
    : { subject: normB, subjectSetAt: setAtB }
}

// ---------------------------------------------------------------------------
// 4. Canonical Message Total Order & Deterministic Collision Derivation
// ---------------------------------------------------------------------------

export interface CanonicalOrderable {
  readonly serverTime: number
  readonly payloadDigest: string
}

/**
 * Total order on messages: primary key `serverTime` ascending, tie-breaker `payloadDigest`
 * lexicographical ascending.
 */
export function compareCanonicalOrder(
  a: CanonicalOrderable,
  b: CanonicalOrderable,
): number {
  if (a.serverTime !== b.serverTime) return a.serverTime - b.serverTime
  if (a.payloadDigest === b.payloadDigest) return 0
  return a.payloadDigest < b.payloadDigest ? -1 : 1
}

const NULL_UUID_NAMESPACE_BYTES = new Uint8Array(16)

/**
 * Deterministic UUIDv5 collision ID for a message claiming `logicalMessageId` whose `payloadDigest`
 * collides with an earlier holder from another conversation or sender.
 */
export function deriveCollidedLogicalId(
  logicalMessageId: string,
  payloadDigest: string,
): string {
  return formatConversationId(
    uuidv5Bytes(
      NULL_UUID_NAMESPACE_BYTES,
      `${logicalMessageId}:${payloadDigest}`,
    ),
  )
}

// ---------------------------------------------------------------------------
// 5. Message Record & Logical Message Join-Semilattice
// ---------------------------------------------------------------------------

export interface SemilatticeMessageRecord {
  readonly payloadDigest: string
  readonly conversationId: string
  readonly senderAddress: string
  readonly destinationAddress: string
  readonly outbound: boolean
  readonly status: DeliveryStatus
  readonly serverTime: number
  readonly localTime: boolean
  readonly value: number
  readonly items: readonly MessageItem[]
  readonly logicalMessageId?: string
  readonly revisionDigest?: string
  readonly conversationName?: string
}

function chooseDeterministicString(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}

function chooseDeterministicItems(
  a: readonly MessageItem[],
  b: readonly MessageItem[],
): readonly MessageItem[] {
  if (a.length !== b.length) return a.length > b.length ? a : b
  const jsonA = JSON.stringify(a)
  const jsonB = JSON.stringify(b)
  return jsonA >= jsonB ? a : b
}

/**
 * Joins two observations of the same physical message (`payloadDigest`).
 */
export function joinMessageRecord(
  a: SemilatticeMessageRecord,
  b: SemilatticeMessageRecord,
): SemilatticeMessageRecord {
  if (a.payloadDigest !== b.payloadDigest) {
    throw new Error(
      `Cannot join message records with distinct payloadDigests: ${a.payloadDigest} vs ${b.payloadDigest}`,
    )
  }
  const ts = joinMessageTimestamp(a, b)
  const status = joinDeliveryStatus(a.status, b.status)
  const logicalMessageId = chooseDeterministicString(
    a.logicalMessageId,
    b.logicalMessageId,
  )
  const revisionDigest = chooseDeterministicString(
    a.revisionDigest,
    b.revisionDigest,
  )
  const conversationName = chooseDeterministicString(
    normalizeSubject(a.conversationName),
    normalizeSubject(b.conversationName),
  )

  return {
    payloadDigest: a.payloadDigest,
    conversationId: chooseDeterministicString(
      a.conversationId,
      b.conversationId,
    )!,
    senderAddress: chooseDeterministicString(
      a.senderAddress.toLowerCase(),
      b.senderAddress.toLowerCase(),
    )!,
    destinationAddress: chooseDeterministicString(
      a.destinationAddress.toLowerCase(),
      b.destinationAddress.toLowerCase(),
    )!,
    outbound: a.outbound || b.outbound,
    status,
    serverTime: ts.serverTime,
    localTime: ts.localTime,
    value: Math.max(a.value, b.value),
    items: chooseDeterministicItems(a.items, b.items),
    ...(logicalMessageId !== undefined ? { logicalMessageId } : {}),
    ...(revisionDigest !== undefined ? { revisionDigest } : {}),
    ...(conversationName !== undefined ? { conversationName } : {}),
  }
}

export interface SemilatticeDeliveryEntry {
  readonly deliveryDigest: string
  readonly recipientAddress: string
  readonly status: DeliveryStatus
  readonly timestamp: number
  readonly localTime: boolean
  readonly attemptDigest?: string
}

export interface SemilatticeRevisionEntry {
  readonly revisionDigest: string
  readonly timestamp: number
  readonly localTime: boolean
  readonly items: readonly MessageItem[]
  readonly deliveries: readonly SemilatticeDeliveryEntry[]
}

export interface SemilatticeLogicalMessageRecord {
  readonly messageId: string
  readonly conversationId: string
  readonly senderAddress: string
  readonly createdAt: number
  readonly activeRevisionDigest: string
  readonly revisions: readonly SemilatticeRevisionEntry[]
}

/**
 * Joins two delivery entries for the same `deliveryDigest`.
 */
export function joinDeliveryEntry(
  a: SemilatticeDeliveryEntry,
  b: SemilatticeDeliveryEntry,
): SemilatticeDeliveryEntry {
  const ts = joinMessageTimestamp(
    { serverTime: a.timestamp, localTime: a.localTime },
    { serverTime: b.timestamp, localTime: b.localTime },
  )
  const attemptDigest = chooseDeterministicString(
    a.attemptDigest,
    b.attemptDigest,
  )
  return {
    deliveryDigest: a.deliveryDigest,
    recipientAddress: chooseDeterministicString(
      a.recipientAddress.toLowerCase(),
      b.recipientAddress.toLowerCase(),
    )!,
    status: joinDeliveryStatus(a.status, b.status),
    timestamp: ts.serverTime,
    localTime: ts.localTime,
    ...(attemptDigest !== undefined ? { attemptDigest } : {}),
  }
}

/**
 * Joins two revision entries for the same `revisionDigest`.
 */
export function joinRevisionEntry(
  a: SemilatticeRevisionEntry,
  b: SemilatticeRevisionEntry,
): SemilatticeRevisionEntry {
  const ts = joinMessageTimestamp(
    { serverTime: a.timestamp, localTime: a.localTime },
    { serverTime: b.timestamp, localTime: b.localTime },
  )
  const deliveryMap = new Map<string, SemilatticeDeliveryEntry>()
  for (const d of a.deliveries) {
    deliveryMap.set(d.deliveryDigest, d)
  }
  for (const d of b.deliveries) {
    const existing = deliveryMap.get(d.deliveryDigest)
    deliveryMap.set(d.deliveryDigest, existing ? joinDeliveryEntry(existing, d) : d)
  }
  const deliveries = [...deliveryMap.values()].sort((x, y) =>
    compareCanonicalOrder(
      { serverTime: x.timestamp, payloadDigest: x.deliveryDigest },
      { serverTime: y.timestamp, payloadDigest: y.deliveryDigest },
    ),
  )
  return {
    revisionDigest: a.revisionDigest,
    timestamp: ts.serverTime,
    localTime: ts.localTime,
    items: chooseDeterministicItems(a.items, b.items),
    deliveries,
  }
}

/**
 * Deterministic total order on revisions to select `activeRevisionDigest`:
 * latest `(timestamp, revisionDigest)` wins.
 */
export function selectActiveRevisionDigest(
  revisions: readonly SemilatticeRevisionEntry[],
): string {
  if (revisions.length === 0) {
    throw new Error('Cannot select activeRevisionDigest from empty revisions')
  }
  let best = revisions[0]
  for (let i = 1; i < revisions.length; i++) {
    const candidate = revisions[i]
    const cmp = compareCanonicalOrder(
      { serverTime: best.timestamp, payloadDigest: best.revisionDigest },
      {
        serverTime: candidate.timestamp,
        payloadDigest: candidate.revisionDigest,
      },
    )
    if (cmp <= 0) {
      best = candidate
    }
  }
  return best.revisionDigest
}

/**
 * Joins two logical message records sharing the same `(messageId, conversationId, senderAddress)`.
 */
export function joinLogicalMessageRecord(
  a: SemilatticeLogicalMessageRecord,
  b: SemilatticeLogicalMessageRecord,
): SemilatticeLogicalMessageRecord {
  if (a.messageId !== b.messageId) {
    throw new Error(
      `Cannot join logical messages with distinct messageIds: ${a.messageId} vs ${b.messageId}`,
    )
  }
  if (
    a.conversationId !== b.conversationId ||
    a.senderAddress.toLowerCase() !== b.senderAddress.toLowerCase()
  ) {
    throw new Error(
      `Logical message ${a.messageId} collision across conversation/sender must be resolved before joining`,
    )
  }
  const revMap = new Map<string, SemilatticeRevisionEntry>()
  for (const r of a.revisions) {
    revMap.set(r.revisionDigest, r)
  }
  for (const r of b.revisions) {
    const existing = revMap.get(r.revisionDigest)
    revMap.set(r.revisionDigest, existing ? joinRevisionEntry(existing, r) : r)
  }
  const revisions = [...revMap.values()].sort((x, y) =>
    compareCanonicalOrder(
      { serverTime: x.timestamp, payloadDigest: x.revisionDigest },
      { serverTime: y.timestamp, payloadDigest: y.revisionDigest },
    ),
  )
  const createdAt = revisions.reduce(
    (min, r) => minPositiveOrMax(min, r.timestamp),
    minPositiveOrMax(a.createdAt, b.createdAt),
  )
  return {
    messageId: a.messageId,
    conversationId: a.conversationId,
    senderAddress: a.senderAddress.toLowerCase(),
    createdAt,
    activeRevisionDigest: selectActiveRevisionDigest(revisions),
    revisions,
  }
}

// ---------------------------------------------------------------------------
// 6. Conversation Semilattice State & Pure Projection
// ---------------------------------------------------------------------------

export interface ConversationSemilatticeState {
  readonly conversationId: string
  readonly peer: string
  readonly clearedBefore: number
  readonly readUpTo: number
  readonly lastReceived: number
  readonly subject: string | undefined
  readonly subjectSetAt: number
  /** G-Set of tombstoned message digests mapped to their deletion timestamp (ms). */
  readonly tombstones: Readonly<Record<string, number>>
  /** Map of physical messages keyed by `payloadDigest`. */
  readonly messages: Readonly<Record<string, SemilatticeMessageRecord>>
}

export function createBottomConversationState(
  conversationId: string,
  peer: string,
): ConversationSemilatticeState {
  return {
    conversationId,
    peer: peer.toLowerCase(),
    clearedBefore: 0,
    readUpTo: 0,
    lastReceived: 0,
    subject: undefined,
    subjectSetAt: 0,
    tombstones: {},
    messages: {},
  }
}

/**
 * Joins two conversation semilattice states for the same `conversationId`.
 * Satisfies commutativity, associativity, and idempotence.
 */
export function joinConversationState(
  a: ConversationSemilatticeState,
  b: ConversationSemilatticeState,
): ConversationSemilatticeState {
  if (a.conversationId !== b.conversationId) {
    throw new Error(
      `Cannot join conversations with distinct IDs: ${a.conversationId} vs ${b.conversationId}`,
    )
  }

  const peer =
    chooseDeterministicString(
      a.peer ? a.peer.toLowerCase() : undefined,
      b.peer ? b.peer.toLowerCase() : undefined,
    ) ?? ''

  const clearedBefore = Math.max(a.clearedBefore, b.clearedBefore)
  const readUpTo = Math.max(a.readUpTo, b.readUpTo)

  // Join tombstones (monotone max timestamp per digest)
  const tombstones: Record<string, number> = { ...a.tombstones }
  for (const [digest, deletedAt] of Object.entries(b.tombstones)) {
    tombstones[digest] = Math.max(tombstones[digest] ?? 0, deletedAt)
  }

  // Join messages by payloadDigest
  const messages: Record<string, SemilatticeMessageRecord> = { ...a.messages }
  for (const [digest, msgB] of Object.entries(b.messages)) {
    const msgA = messages[digest]
    messages[digest] = msgA ? joinMessageRecord(msgA, msgB) : msgB
  }

  // Join subject register across explicit registers and message-carried conversationName
  let subjectReg = joinSubjectRegister(
    { subject: a.subject, subjectSetAt: a.subjectSetAt },
    { subject: b.subject, subjectSetAt: b.subjectSetAt },
  )
  let lastReceived = Math.max(a.lastReceived, b.lastReceived)

  for (const msg of Object.values(messages)) {
    if (!msg.localTime) {
      lastReceived = Math.max(lastReceived, msg.serverTime)
    }
    if (msg.conversationName !== undefined && !msg.localTime) {
      subjectReg = joinSubjectRegister(subjectReg, {
        subject: msg.conversationName,
        subjectSetAt: msg.serverTime,
      })
    }
  }

  return {
    conversationId: a.conversationId,
    peer,
    clearedBefore,
    readUpTo,
    lastReceived,
    subject: subjectReg.subject,
    subjectSetAt: subjectReg.subjectSetAt,
    tombstones,
    messages,
  }
}

export interface ProjectedConversationView {
  readonly conversationId: string
  readonly peer: string
  readonly subject: string | undefined
  readonly subjectSetAt: number
  readonly clearedBefore: number
  readonly readUpTo: number
  readonly lastReceived: number
  readonly deleted: boolean
  readonly visibleMessages: readonly SemilatticeMessageRecord[]
  readonly totalValue: number
  readonly totalUnreadMessages: number
  readonly totalUnreadValue: number
}

/**
 * Pure projection of a {@link ConversationSemilatticeState} into visible sorted messages and
 * accounting counters (`totalValue`, `totalUnreadMessages`, `totalUnreadValue`).
 *
 * Because this is a pure function of the joined semilattice state, the counters are guaranteed to
 * be independent of message arrival order, duplicate delivery, or watermarks arriving before
 * messages.
 */
export function projectConversationView(
  state: ConversationSemilatticeState,
  activeConversationId?: string | null,
): ProjectedConversationView {
  const visibleMessages = Object.values(state.messages)
    .filter(msg => {
      if (msg.payloadDigest in state.tombstones) return false
      if (state.clearedBefore > 0 && msg.serverTime <= state.clearedBefore) {
        return false
      }
      return true
    })
    .sort(compareCanonicalOrder)

  const isActive =
    activeConversationId !== undefined &&
    activeConversationId !== null &&
    state.conversationId === activeConversationId

  let effectiveReadUpTo = state.readUpTo
  if (isActive) {
    for (const msg of visibleMessages) {
      if (!msg.outbound) {
        effectiveReadUpTo = Math.max(effectiveReadUpTo, msg.serverTime)
      }
    }
  }

  let totalValue = 0
  let totalUnreadMessages = 0
  let totalUnreadValue = 0

  for (const msg of visibleMessages) {
    const val = Number.isFinite(msg.value) && msg.value > 0 ? msg.value : 0
    if (!msg.outbound) {
      totalValue += val
      if (msg.serverTime > effectiveReadUpTo) {
        totalUnreadMessages += 1
        totalUnreadValue += val
      }
    }
  }

  return {
    conversationId: state.conversationId,
    peer: state.peer,
    subject: state.subject,
    subjectSetAt: state.subjectSetAt,
    clearedBefore: state.clearedBefore,
    readUpTo: effectiveReadUpTo,
    lastReceived: state.lastReceived,
    deleted: state.clearedBefore > 0 && visibleMessages.length === 0,
    visibleMessages,
    totalValue,
    totalUnreadMessages,
    totalUnreadValue,
  }
}

// ---------------------------------------------------------------------------
// 7. Account-Wide Journal Semilattice State & Compaction
// ---------------------------------------------------------------------------

export interface JournalSemilatticeState {
  readonly conversations: Readonly<Record<string, ConversationSemilatticeState>>
  readonly lastReceived: number
  readonly checkpointTimestamp: number
}

export const BOTTOM_JOURNAL_STATE: JournalSemilatticeState = Object.freeze({
  conversations: Object.freeze({}),
  lastReceived: 0,
  checkpointTimestamp: 0,
})

/**
 * Joins two account-wide journal semilattice states.
 * Commutative, associative, and idempotent.
 */
export function joinJournalState(
  a: JournalSemilatticeState,
  b: JournalSemilatticeState,
): JournalSemilatticeState {
  const conversations: Record<string, ConversationSemilatticeState> = {
    ...a.conversations,
  }
  for (const [convId, convB] of Object.entries(b.conversations)) {
    const convA = conversations[convId]
    conversations[convId] = convA ? joinConversationState(convA, convB) : convB
  }

  let lastReceived = Math.max(a.lastReceived, b.lastReceived)
  for (const conv of Object.values(conversations)) {
    lastReceived = Math.max(lastReceived, conv.lastReceived)
  }

  return {
    conversations,
    lastReceived,
    checkpointTimestamp: Math.max(
      a.checkpointTimestamp,
      b.checkpointTimestamp,
    ),
  }
}

export type JournalEvent =
  | {
      readonly kind: 'message'
      readonly record: SemilatticeMessageRecord
      readonly peer: string
    }
  | {
      readonly kind: 'conversation-state'
      readonly item: ConversationStateItem
    }
  | {
      readonly kind: 'outbox-message'
      readonly item: OutboxMessageItem
      readonly ownAddress: string
      readonly defaultConversationId: string
      readonly decodedItems?: readonly MessageItem[]
      readonly value?: number
    }
  | {
      readonly kind: 'message-tombstone'
      readonly item: MessageTombstoneItem
    }
  | {
      readonly kind: 'journal-checkpoint'
      readonly item: JournalCheckpointItem
    }

/**
 * Converts a single {@link JournalEvent} into a delta {@link JournalSemilatticeState} so that
 * `applyJournalEvent(state, event)` is simply `joinJournalState(state, eventToDeltaState(event))`.
 *
 * Because every event acts by semilattice join ($\sqcup$), applying any set of events in any
 * permutation order or with arbitrary duplication produces the exact same state.
 */
export function eventToDeltaState(event: JournalEvent): JournalSemilatticeState {
  switch (event.kind) {
    case 'message': {
      const { record, peer } = event
      const base = createBottomConversationState(record.conversationId, peer)
      const subjectReg =
        record.conversationName !== undefined && !record.localTime
          ? {
              subject: normalizeSubject(record.conversationName),
              subjectSetAt: record.serverTime,
            }
          : BOTTOM_SUBJECT_REGISTER
      const lastReceived = record.localTime ? 0 : record.serverTime
      const conv: ConversationSemilatticeState = {
        ...base,
        lastReceived,
        subject: subjectReg.subject,
        subjectSetAt: subjectReg.subjectSetAt,
        messages: { [record.payloadDigest]: record },
      }
      return {
        conversations: { [record.conversationId]: conv },
        lastReceived,
        checkpointTimestamp: 0,
      }
    }

    case 'conversation-state': {
      const { item } = event
      const base = createBottomConversationState(item.conversationId, item.peer)
      const hasSubject =
        item.subject !== undefined && item.subjectSetAt !== undefined
      const conv: ConversationSemilatticeState = {
        ...base,
        clearedBefore: item.clearedBefore ?? 0,
        readUpTo: item.readUpTo ?? 0,
        subject: hasSubject ? normalizeSubject(item.subject) : undefined,
        subjectSetAt: hasSubject ? item.subjectSetAt! : 0,
      }
      return {
        conversations: { [item.conversationId]: conv },
        lastReceived: 0,
        checkpointTimestamp: 0,
      }
    }

    case 'outbox-message': {
      const {
        item,
        ownAddress,
        defaultConversationId,
        decodedItems,
        value = 0,
      } = event
      const conversationId = item.conversationId ?? defaultConversationId
      const items: readonly MessageItem[] =
        decodedItems ??
        (item.text !== undefined ? [{ type: 'text', text: item.text }] : [])
      const record: SemilatticeMessageRecord = {
        payloadDigest: item.payloadDigest,
        conversationId,
        senderAddress: ownAddress.toLowerCase(),
        destinationAddress: item.recipientAddress.toLowerCase(),
        outbound: true,
        status: 'confirmed',
        serverTime: item.sentAt,
        localTime: false,
        value,
        items,
        ...(item.messageId !== undefined
          ? { logicalMessageId: item.messageId }
          : {}),
        ...(item.conversationName !== undefined
          ? { conversationName: item.conversationName }
          : {}),
      }
      return eventToDeltaState({
        kind: 'message',
        record,
        peer: item.recipientAddress.toLowerCase(),
      })
    }

    case 'message-tombstone': {
      const { item } = event
      const base = createBottomConversationState(item.conversationId, item.peer)
      const conv: ConversationSemilatticeState = {
        ...base,
        tombstones: { [item.payloadDigest]: item.deletedAt },
      }
      return {
        conversations: { [item.conversationId]: conv },
        lastReceived: 0,
        checkpointTimestamp: 0,
      }
    }

    case 'journal-checkpoint': {
      const { item } = event
      const conversations: Record<string, ConversationSemilatticeState> = {}
      for (const entry of item.conversations) {
        const base = createBottomConversationState(
          entry.conversationId,
          entry.peer,
        )
        const hasSubject =
          entry.subject !== undefined && entry.subjectSetAt !== undefined
        const next: ConversationSemilatticeState = {
          ...base,
          clearedBefore: entry.clearedBefore ?? 0,
          readUpTo: entry.readUpTo ?? 0,
          subject: hasSubject ? normalizeSubject(entry.subject) : undefined,
          subjectSetAt: hasSubject ? entry.subjectSetAt! : 0,
          tombstones: entry.tombstones ? { ...entry.tombstones } : {},
        }
        const prev = conversations[entry.conversationId]
        conversations[entry.conversationId] = prev
          ? joinConversationState(prev, next)
          : next
      }
      return {
        conversations,
        lastReceived: 0,
        checkpointTimestamp: item.checkpointTimestamp,
      }
    }
  }
}

/**
 * Applies a single {@link JournalEvent} to `state` via semilattice join.
 */
export function applyJournalEvent(
  state: JournalSemilatticeState,
  event: JournalEvent,
): JournalSemilatticeState {
  return joinJournalState(state, eventToDeltaState(event))
}

/**
 * Folds a sequence of {@link JournalEvent}s into a {@link JournalSemilatticeState}.
 */
export function foldJournalEvents(
  events: Iterable<JournalEvent>,
  initial: JournalSemilatticeState = BOTTOM_JOURNAL_STATE,
): JournalSemilatticeState {
  let state = initial
  for (const event of events) {
    state = applyJournalEvent(state, event)
  }
  return state
}

/**
 * Deterministically projects all logical messages across an entire {@link JournalSemilatticeState}.
 *
 * When two messages from different conversations or different senders claim the same
 * `logicalMessageId`, the message with the earlier `(serverTime, payloadDigest)` under
 * {@link compareCanonicalOrder} wins the claimed ID and the later colliding message is filed under
 * {@link deriveCollidedLogicalId}, independent of arrival order.
 */
export function projectLogicalMessages(
  state: JournalSemilatticeState,
): Readonly<Record<string, SemilatticeLogicalMessageRecord>> {
  // Collect all visible messages across all conversations, ordered by compareCanonicalOrder
  const allVisible: SemilatticeMessageRecord[] = []
  const sortedConvIds = Object.keys(state.conversations).sort()
  for (const convId of sortedConvIds) {
    const view = projectConversationView(state.conversations[convId])
    allVisible.push(...view.visibleMessages)
  }
  allVisible.sort(compareCanonicalOrder)

  const owners = new Map<
    string,
    { conversationId: string; senderAddress: string }
  >()
  const records: Record<string, SemilatticeLogicalMessageRecord> = {}

  const isHeldByAnother = (
    id: string,
    conversationId: string,
    senderAddress: string,
  ): boolean => {
    const owner = owners.get(id)
    if (!owner) return false
    return (
      owner.conversationId !== conversationId ||
      owner.senderAddress.toLowerCase() !== senderAddress.toLowerCase()
    )
  }

  const resolveFreeId = (
    named: string,
    payloadDigest: string,
    conversationId: string,
    senderAddress: string,
  ): string => {
    let id = named
    for (
      let round = 0;
      round < 8 && isHeldByAnother(id, conversationId, senderAddress);
      round++
    ) {
      id = deriveCollidedLogicalId(id, payloadDigest)
    }
    if (!isHeldByAnother(id, conversationId, senderAddress)) return id
    for (let n = 0; ; n++) {
      const fallback = `collided:${payloadDigest}:${n}`
      if (!isHeldByAnother(fallback, conversationId, senderAddress)) {
        return fallback
      }
    }
  }

  for (const msg of allVisible) {
    const named = msg.logicalMessageId || msg.payloadDigest
    const logicalId = resolveFreeId(
      named,
      msg.payloadDigest,
      msg.conversationId,
      msg.senderAddress,
    )
    owners.set(logicalId, {
      conversationId: msg.conversationId,
      senderAddress: msg.senderAddress.toLowerCase(),
    })

    const revDigest = msg.revisionDigest || msg.payloadDigest
    const singleRecord: SemilatticeLogicalMessageRecord = {
      messageId: logicalId,
      conversationId: msg.conversationId,
      senderAddress: msg.senderAddress.toLowerCase(),
      createdAt: msg.serverTime,
      activeRevisionDigest: revDigest,
      revisions: [
        {
          revisionDigest: revDigest,
          timestamp: msg.serverTime,
          localTime: msg.localTime,
          items: msg.items,
          deliveries: [
            {
              deliveryDigest: msg.payloadDigest,
              recipientAddress: msg.destinationAddress.toLowerCase(),
              status: msg.status,
              timestamp: msg.serverTime,
              localTime: msg.localTime,
            },
          ],
        },
      ],
    }

    const existing = records[logicalId]
    records[logicalId] = existing
      ? joinLogicalMessageRecord(existing, singleRecord)
      : singleRecord
  }

  return records
}

/**
 * Summarizes the watermarks, LWW subject registers, and tombstones of `state` into a canonical
 * {@link JournalCheckpointItem} at `checkpointTimestamp`.
 *
 * Compaction Equivalence Property:
 * Joining the resulting `JournalCheckpointItem` with all message events not superseded by the
 * checkpoint's `clearedBefore` / `tombstones` produces the exact same projected conversation views
 * as folding the full uncompacted event history.
 */
export function createJournalCheckpoint(
  state: JournalSemilatticeState,
  checkpointTimestamp: number,
): JournalCheckpointItem {
  const effectiveTimestamp = Math.max(
    checkpointTimestamp,
    state.checkpointTimestamp,
    state.lastReceived,
  )
  const sortedConvIds = Object.keys(state.conversations).sort()
  const conversations: JournalCheckpointConversationEntry[] = []

  for (const convId of sortedConvIds) {
    const conv = state.conversations[convId]
    const hasSubject = conv.subjectSetAt > 0 || conv.subject !== undefined
    const tombstoneKeys = Object.keys(conv.tombstones).sort()
    const tombstones: Record<string, number> = {}
    for (const k of tombstoneKeys) {
      tombstones[k] = conv.tombstones[k]
    }

    const entry: JournalCheckpointConversationEntry = {
      conversationId: conv.conversationId,
      peer: conv.peer,
      ...(conv.clearedBefore > 0 ? { clearedBefore: conv.clearedBefore } : {}),
      ...(conv.readUpTo > 0 ? { readUpTo: conv.readUpTo } : {}),
      ...(hasSubject
        ? {
            subject: conv.subject ?? '',
            subjectSetAt: conv.subjectSetAt,
          }
        : {}),
      ...(tombstoneKeys.length > 0 ? { tombstones } : {}),
    }
    conversations.push(entry)
  }

  return {
    type: 'journal-checkpoint',
    checkpointTimestamp: effectiveTimestamp,
    conversations,
  }
}

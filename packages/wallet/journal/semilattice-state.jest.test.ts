import {
  applyJournalEvent,
  BOTTOM_JOURNAL_STATE,
  BOTTOM_SUBJECT_REGISTER,
  compareCanonicalOrder,
  createBottomConversationState,
  createJournalCheckpoint,
  foldJournalEvents,
  joinConversationState,
  joinDeliveryEntry,
  joinDeliveryStatus,
  joinJournalState,
  joinLogicalMessageRecord,
  joinMessageRecord,
  joinMessageTimestamp,
  joinRevisionEntry,
  joinSubjectRegister,
  projectConversationView,
  projectLogicalMessages,
  toDeliveryStatus,
  type ConversationSemilatticeState,
  type DeliveryStatus,
  type JournalEvent,
  type SemilatticeDeliveryEntry,
  type SemilatticeLogicalMessageRecord,
  type SemilatticeMessageRecord,
  type SemilatticeRevisionEntry,
  type SubjectRegister,
  type TimestampedAuthority,
} from './semilattice-state'
import {
  journalCheckpointCodec,
  messageTombstoneCodec,
  outboxMessageCodec,
} from './journal-codec'

const ME = '0x1111111111111111111111111111111111111111'
const PEER_A = '0x2222222222222222222222222222222222222222'
const PEER_B = '0x3333333333333333333333333333333333333333'
const CONV_A = '11111111-1111-4111-8111-111111111111'
const CONV_B = '22222222-2222-4222-8222-222222222222'
const DIGEST_1 = 'a1'.repeat(32)
const DIGEST_2 = 'b2'.repeat(32)
const DIGEST_3 = 'c3'.repeat(32)
const DIGEST_4 = 'd4'.repeat(32)

function allPermutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()]
  const result: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const head = items[i]!
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of allPermutations(rest)) {
      result.push([head, ...tail])
    }
  }
  return result
}

describe('Join-Semilattice Algebraic Laws', () => {
  describe('joinDeliveryStatus', () => {
    const statuses: DeliveryStatus[] = ['sending', 'error', 'confirmed']

    it('satisfies idempotence, commutativity, and associativity across all triples', () => {
      for (const a of statuses) {
        expect(joinDeliveryStatus(a, a)).toBe(a)
        for (const b of statuses) {
          expect(joinDeliveryStatus(a, b)).toBe(joinDeliveryStatus(b, a))
          for (const c of statuses) {
            expect(joinDeliveryStatus(joinDeliveryStatus(a, b), c)).toBe(
              joinDeliveryStatus(a, joinDeliveryStatus(b, c)),
            )
          }
        }
      }
    })

    it('orders confirmed > error > sending', () => {
      expect(joinDeliveryStatus('sending', 'error')).toBe('error')
      expect(joinDeliveryStatus('error', 'confirmed')).toBe('confirmed')
      expect(joinDeliveryStatus('sending', 'confirmed')).toBe('confirmed')
      expect(toDeliveryStatus('confirmed')).toBe('confirmed')
      expect(toDeliveryStatus('error')).toBe('error')
      expect(toDeliveryStatus('sending')).toBe('sending')
    })
  })

  describe('joinSubjectRegister (LWW with lexicographical tie-breaker)', () => {
    const samples: SubjectRegister[] = [
      BOTTOM_SUBJECT_REGISTER,
      { subject: 'Alpha', subjectSetAt: 100 },
      { subject: 'Beta', subjectSetAt: 100 },
      { subject: undefined, subjectSetAt: 100 },
      { subject: 'Gamma', subjectSetAt: 200 },
      { subject: undefined, subjectSetAt: 250 },
    ]

    it('satisfies idempotence, commutativity, and associativity across all triples', () => {
      for (const a of samples) {
        expect(joinSubjectRegister(a, a)).toEqual(a)
        for (const b of samples) {
          expect(joinSubjectRegister(a, b)).toEqual(joinSubjectRegister(b, a))
          for (const c of samples) {
            expect(
              joinSubjectRegister(joinSubjectRegister(a, b), c),
            ).toEqual(joinSubjectRegister(a, joinSubjectRegister(b, c)))
          }
        }
      }
    })

    it('breaks ties deterministically at identical timestamps', () => {
      expect(
        joinSubjectRegister(
          { subject: 'Alpha', subjectSetAt: 100 },
          { subject: 'Beta', subjectSetAt: 100 },
        ),
      ).toEqual({ subject: 'Beta', subjectSetAt: 100 })
      expect(
        joinSubjectRegister(
          { subject: 'Beta', subjectSetAt: 100 },
          { subject: 'Alpha', subjectSetAt: 100 },
        ),
      ).toEqual({ subject: 'Beta', subjectSetAt: 100 })
    })
  })

  describe('joinMessageTimestamp (authoritative relay time over local time)', () => {
    const samples: TimestampedAuthority[] = [
      { serverTime: 0, localTime: true },
      { serverTime: 1_700_000_000_500, localTime: true },
      {
        serverTime: 1_700_000_000_100,
        receivedTime: 1_700_000_000_100,
        localTime: false,
      },
      {
        serverTime: 1_700_000_000_050,
        receivedTime: 1_700_000_000_050,
        localTime: false,
      },
    ]

    it('satisfies idempotence, commutativity, and associativity across all triples', () => {
      for (const a of samples) {
        const aa = joinMessageTimestamp(a, a)
        expect(joinMessageTimestamp(aa, a)).toEqual(aa)
        for (const b of samples) {
          expect(joinMessageTimestamp(a, b)).toEqual(joinMessageTimestamp(b, a))
          for (const c of samples) {
            expect(
              joinMessageTimestamp(joinMessageTimestamp(a, b), c),
            ).toEqual(joinMessageTimestamp(a, joinMessageTimestamp(b, c)))
          }
        }
      }
    })

    it('prefers authoritative relay timestamp (localTime=false) even when smaller than local clock', () => {
      const localGuess: TimestampedAuthority = {
        serverTime: 9_999_999,
        localTime: true,
      }
      const relayTruth: TimestampedAuthority = {
        serverTime: 1_000_000,
        receivedTime: 1_000_000,
        localTime: false,
      }
      expect(joinMessageTimestamp(localGuess, relayTruth)).toEqual({
        serverTime: 1_000_000,
        receivedTime: 1_000_000,
        localTime: false,
      })
      expect(joinMessageTimestamp(relayTruth, localGuess)).toEqual({
        serverTime: 1_000_000,
        receivedTime: 1_000_000,
        localTime: false,
      })
    })
  })

  describe('joinMessageRecord & joinConversationState', () => {
    const recLocalSend: SemilatticeMessageRecord = {
      payloadDigest: DIGEST_1,
      conversationId: CONV_A,
      senderAddress: ME,
      destinationAddress: PEER_A,
      outbound: true,
      status: 'sending',
      serverTime: 5000,
      localTime: true,
      value: 100,
      items: [{ type: 'text', text: 'Hello' }],
      logicalMessageId: '33333333-3333-4333-8333-333333333333',
    }

    const recRelayConfirm: SemilatticeMessageRecord = {
      payloadDigest: DIGEST_1,
      conversationId: CONV_A,
      senderAddress: ME,
      destinationAddress: PEER_A,
      outbound: true,
      status: 'confirmed',
      serverTime: 4200,
      localTime: false,
      value: 100,
      items: [{ type: 'text', text: 'Hello' }],
      logicalMessageId: '33333333-3333-4333-8333-333333333333',
    }

    it('converges identically whether local send or relay confirmation arrives first', () => {
      const ab = joinMessageRecord(recLocalSend, recRelayConfirm)
      const ba = joinMessageRecord(recRelayConfirm, recLocalSend)
      expect(ab).toEqual(ba)
      expect(ab.status).toBe('confirmed')
      expect(ab.localTime).toBe(false)
      expect(ab.serverTime).toBe(4200)
    })

    it('satisfies idempotence, commutativity, and associativity on ConversationSemilatticeState', () => {
      const base = createBottomConversationState(CONV_A, PEER_A)
      const m1: ConversationSemilatticeState = {
        ...base,
        clearedBefore: 100,
        readUpTo: 200,
        subject: 'Topic 1',
        subjectSetAt: 150,
        messages: { [DIGEST_1]: recLocalSend },
      }
      const m2: ConversationSemilatticeState = {
        ...base,
        clearedBefore: 300,
        readUpTo: 150,
        subject: 'Topic 2',
        subjectSetAt: 250,
        lastReceived: 4200,
        messages: { [DIGEST_1]: recRelayConfirm },
      }
      const m3: ConversationSemilatticeState = {
        ...base,
        clearedBefore: 200,
        readUpTo: 400,
        subject: undefined,
        subjectSetAt: 300,
        tombstones: { [DIGEST_2]: 500 },
      }

      const states = [base, m1, m2, m3]
      for (const a of states) {
        expect(joinConversationState(a, a)).toEqual(a)
        for (const b of states) {
          expect(joinConversationState(a, b)).toEqual(
            joinConversationState(b, a),
          )
          for (const c of states) {
            expect(
              joinConversationState(joinConversationState(a, b), c),
            ).toEqual(joinConversationState(a, joinConversationState(b, c)))
          }
        }
      }
    })
  })

  describe('joinLogicalMessageRecord', () => {
    const logicalId = '44444444-4444-4444-8444-444444444444'
    const d1: SemilatticeDeliveryEntry = {
      deliveryDigest: DIGEST_1,
      recipientAddress: PEER_A,
      attemptDigest: 'e5'.repeat(32),
      timestamp: 1000,
      localTime: false,
      status: 'confirmed',
    }
    const d2: SemilatticeDeliveryEntry = {
      deliveryDigest: DIGEST_2,
      recipientAddress: PEER_A,
      attemptDigest: 'f6'.repeat(32),
      timestamp: 2000,
      localTime: true,
      status: 'sending',
    }
    const r1: SemilatticeRevisionEntry = {
      revisionDigest: DIGEST_1,
      timestamp: 1000,
      localTime: false,
      items: [{ type: 'text', text: 'v1' }],
      deliveries: [d1],
    }
    const r2: SemilatticeRevisionEntry = {
      revisionDigest: DIGEST_2,
      timestamp: 1500,
      localTime: false,
      items: [{ type: 'text', text: 'v2' }],
      deliveries: [d2],
    }

    it('merges logical message records commutatively and selects active revision deterministically', () => {
      expect(joinDeliveryEntry(d1, d1)).toEqual(d1)
      expect(joinRevisionEntry(r1, r1)).toEqual(r1)

      const recA: SemilatticeLogicalMessageRecord = {
        messageId: logicalId,
        conversationId: CONV_A,
        senderAddress: ME,
        createdAt: 1000,
        activeRevisionDigest: DIGEST_1,
        revisions: [r1],
      }
      const recB: SemilatticeLogicalMessageRecord = {
        messageId: logicalId,
        conversationId: CONV_A,
        senderAddress: ME,
        createdAt: 1500,
        activeRevisionDigest: DIGEST_2,
        revisions: [r2],
      }

      const ab = joinLogicalMessageRecord(recA, recB)
      const ba = joinLogicalMessageRecord(recB, recA)
      expect(ab).toEqual(ba)
      expect(ab.activeRevisionDigest).toBe(DIGEST_2)
      expect(ab.createdAt).toBe(1000)
      expect(ab.revisions).toHaveLength(2)
    })
  })
})

describe('Exhaustive Permutation Invariance (All n! Event Orderings)', () => {
  const events5: JournalEvent[] = [
    {
      kind: 'message',
      peer: PEER_A,
      record: {
        payloadDigest: DIGEST_1,
        conversationId: CONV_A,
        senderAddress: PEER_A,
        destinationAddress: ME,
        outbound: false,
        status: 'confirmed',
        serverTime: 1_000,
        localTime: false,
        value: 500,
        items: [{ type: 'text', text: 'Incoming 1' }],
      },
    },
    {
      kind: 'message',
      peer: PEER_A,
      record: {
        payloadDigest: DIGEST_2,
        conversationId: CONV_A,
        senderAddress: PEER_A,
        destinationAddress: ME,
        outbound: false,
        status: 'confirmed',
        serverTime: 2_000,
        localTime: false,
        value: 700,
        items: [{ type: 'text', text: 'Incoming 2' }],
      },
    },
    {
      kind: 'outbox-message',
      ownAddress: ME,
      defaultConversationId: CONV_A,
      value: 300,
      item: {
        type: 'outbox-message',
        payloadDigest: DIGEST_3,
        recipientAddress: PEER_A,
        sentAt: 2_500,
        conversationId: CONV_A,
        conversationName: 'Initial Subject',
        messageId: '55555555-5555-4555-8555-555555555555',
        stampValueWei: '300',
        text: 'Outbound reply from Device A',
      },
    },
    {
      kind: 'conversation-state',
      item: {
        type: 'conversation-state',
        conversationId: CONV_A,
        peer: PEER_A,
        clearedBefore: 1_500,
        readUpTo: 2_000,
        subject: 'Renamed Subject',
        subjectSetAt: 3_000,
      },
    },
    {
      kind: 'message-tombstone',
      item: {
        type: 'message-tombstone',
        conversationId: CONV_A,
        peer: PEER_A,
        payloadDigest: DIGEST_2,
        deletedAt: 3_500,
      },
    },
  ]

  it('converges to the exact same JournalSemilatticeState and ProjectedConversationView across all 5! = 120 permutations', () => {
    const perms = allPermutations(events5)
    expect(perms).toHaveLength(120)

    const referenceState = foldJournalEvents(perms[0]!)
    const referenceConv = referenceState.conversations[CONV_A]!
    const referenceProjected = projectConversationView(referenceConv, null)
    const referenceLogical = projectLogicalMessages(referenceState)

    for (const perm of perms) {
      const state = foldJournalEvents(perm)
      expect(state).toEqual(referenceState)
      expect(
        projectConversationView(state.conversations[CONV_A]!, null),
      ).toEqual(referenceProjected)
      expect(projectLogicalMessages(state)).toEqual(referenceLogical)
    }

    // Verify expected semantics on the converged projection:
    // DIGEST_1 (t=1000) was cleared by clearedBefore=1500
    // DIGEST_2 (t=2000) was tombstoned by message-tombstone
    // DIGEST_3 (t=2500) is the surviving outbound message from outbox-message
    expect(referenceProjected.subject).toBe('Renamed Subject')
    expect(referenceProjected.clearedBefore).toBe(1_500)
    expect(referenceProjected.readUpTo).toBe(2_000)
    expect(referenceProjected.visibleMessages.map(m => m.payloadDigest)).toEqual([
      DIGEST_3,
    ])
    expect(referenceProjected.totalUnreadMessages).toBe(0)
    expect(referenceProjected.totalUnreadValue).toBe(0)
    expect(referenceState.lastReceived).toBe(2_500)
  })

  it('converges when a local-send and an outbox-message / incoming-message race in any order (4! = 24 permutations)', () => {
    const raceEvents: JournalEvent[] = [
      {
        kind: 'message',
        peer: PEER_A,
        record: {
          payloadDigest: DIGEST_3,
          conversationId: CONV_A,
          senderAddress: ME,
          destinationAddress: PEER_A,
          outbound: true,
          status: 'sending',
          serverTime: 9_999,
          localTime: true,
          value: 300,
          items: [{ type: 'text', text: 'Outbound reply from Device A' }],
          logicalMessageId: '55555555-5555-4555-8555-555555555555',
        },
      },
      {
        kind: 'outbox-message',
        ownAddress: ME,
        defaultConversationId: CONV_A,
        value: 300,
        item: {
          type: 'outbox-message',
          payloadDigest: DIGEST_3,
          recipientAddress: PEER_A,
          sentAt: 2_500,
          conversationId: CONV_A,
          messageId: '55555555-5555-4555-8555-555555555555',
          stampValueWei: '300',
          text: 'Outbound reply from Device A',
        },
      },
      {
        kind: 'message',
        peer: PEER_A,
        record: {
          payloadDigest: DIGEST_4,
          conversationId: CONV_A,
          senderAddress: PEER_A,
          destinationAddress: ME,
          outbound: false,
          status: 'confirmed',
          serverTime: 2_600,
          localTime: false,
          value: 450,
          items: [{ type: 'text', text: 'Unread incoming after outbox' }],
        },
      },
      {
        kind: 'conversation-state',
        item: {
          type: 'conversation-state',
          conversationId: CONV_A,
          peer: PEER_A,
          readUpTo: 2_500,
        },
      },
    ]

    const perms = allPermutations(raceEvents)
    expect(perms).toHaveLength(24)

    const refState = foldJournalEvents(perms[0]!)
    const refProj = projectConversationView(refState.conversations[CONV_A]!, null)

    for (const perm of perms) {
      const st = foldJournalEvents(perm)
      expect(st).toEqual(refState)
      expect(projectConversationView(st.conversations[CONV_A]!, null)).toEqual(
        refProj,
      )
    }

    // DIGEST_3 resolved to authoritative relay time 2500 and confirmed
    expect(refProj.visibleMessages.map(m => m.payloadDigest)).toEqual([
      DIGEST_3,
      DIGEST_4,
    ])
    expect(refProj.visibleMessages[0]!.serverTime).toBe(2_500)
    expect(refProj.visibleMessages[0]!.localTime).toBe(false)
    expect(refProj.visibleMessages[0]!.status).toBe('confirmed')
    // DIGEST_4 (t=2600 > readUpTo=2500) is unread
    expect(refProj.totalUnreadMessages).toBe(1)
    expect(refProj.totalUnreadValue).toBe(450)
    expect(refProj.totalValue).toBe(450)
  })
})

describe('Checkpoint Compaction Join-Equivalence & CBOR Codecs', () => {
  it('compacts journal state into a JournalCheckpointItem that joins equivalently with remaining events', () => {
    const e1: JournalEvent = {
      kind: 'conversation-state',
      item: {
        type: 'conversation-state',
        conversationId: CONV_A,
        peer: PEER_A,
        clearedBefore: 1_000,
        readUpTo: 1_200,
        subject: 'Checkpoint Subject',
        subjectSetAt: 1_100,
      },
    }
    const e2: JournalEvent = {
      kind: 'message-tombstone',
      item: {
        type: 'message-tombstone',
        conversationId: CONV_A,
        peer: PEER_A,
        payloadDigest: DIGEST_1,
        deletedAt: 1_300,
      },
    }
    const e3: JournalEvent = {
      kind: 'conversation-state',
      item: {
        type: 'conversation-state',
        conversationId: CONV_B,
        peer: PEER_B,
        readUpTo: 900,
      },
    }
    const e4: JournalEvent = {
      kind: 'message',
      peer: PEER_A,
      record: {
        payloadDigest: DIGEST_2,
        conversationId: CONV_A,
        senderAddress: PEER_A,
        destinationAddress: ME,
        outbound: false,
        status: 'confirmed',
        serverTime: 2_000,
        localTime: false,
        value: 1000,
        items: [{ type: 'text', text: 'Post-checkpoint message' }],
      },
    }

    const prefixState = foldJournalEvents([e1, e2, e3])
    const checkpointItem = createJournalCheckpoint(prefixState, 1_500)

    // Encode and decode via CBOR codec
    const encoded = journalCheckpointCodec.encode(checkpointItem)
    const decoded = journalCheckpointCodec.decode(encoded)
    expect(decoded).toEqual(checkpointItem)

    // Apply checkpoint + e4 vs full log [e1, e2, e3, checkpoint, e4]
    const fromCheckpoint = foldJournalEvents([
      { kind: 'journal-checkpoint', item: decoded },
      e4,
    ])
    const fromFullHistory = foldJournalEvents([
      e1,
      e2,
      e3,
      { kind: 'journal-checkpoint', item: decoded },
      e4,
    ])

    expect(
      projectConversationView(fromCheckpoint.conversations[CONV_A]!, null),
    ).toEqual(
      projectConversationView(fromFullHistory.conversations[CONV_A]!, null),
    )
    expect(
      projectConversationView(fromCheckpoint.conversations[CONV_B]!, null),
    ).toEqual(
      projectConversationView(fromFullHistory.conversations[CONV_B]!, null),
    )
  })

  it('round-trips OutboxMessageItem and MessageTombstoneItem through canonical CBOR codecs', () => {
    const outbox = {
      type: 'outbox-message' as const,
      payloadDigest: DIGEST_3,
      recipientAddress: PEER_A,
      sentAt: 1_700_000_000_000,
      conversationId: CONV_A,
      conversationName: 'Project Launch',
      messageId: '55555555-5555-4555-8555-555555555555',
      stampValueWei: '2500000000000000',
      recipientPublicKey: `02${'11'.repeat(32)}`,
      itemFrames: ['a1006474657874'],
      text: 'Hello Bob',
    }
    const outboxBytes = outboxMessageCodec.encode(outbox)
    expect(outboxMessageCodec.decode(outboxBytes)).toEqual(outbox)

    const tombstone = {
      type: 'message-tombstone' as const,
      conversationId: CONV_A,
      peer: PEER_A,
      payloadDigest: DIGEST_2,
      deletedAt: 1_700_000_005_000,
    }
    const tombstoneBytes = messageTombstoneCodec.encode(tombstone)
    expect(messageTombstoneCodec.decode(tombstoneBytes)).toEqual(tombstone)
  })

  it('verify compareCanonicalOrder and joinJournalState laws', () => {
    expect(
      compareCanonicalOrder(
        { serverTime: 100, payloadDigest: DIGEST_1 },
        { serverTime: 200, payloadDigest: DIGEST_1 },
      ),
    ).toBeLessThan(0)
    expect(
      compareCanonicalOrder(
        { serverTime: 100, payloadDigest: DIGEST_1 },
        { serverTime: 100, payloadDigest: DIGEST_2 },
      ),
    ).toBeLessThan(0)

    const s1 = applyJournalEvent(BOTTOM_JOURNAL_STATE, {
      kind: 'message-tombstone',
      item: {
        type: 'message-tombstone',
        conversationId: CONV_A,
        peer: PEER_A,
        payloadDigest: DIGEST_1,
        deletedAt: 100,
      },
    })
    expect(joinJournalState(s1, BOTTOM_JOURNAL_STATE)).toEqual(s1)
    expect(joinJournalState(BOTTOM_JOURNAL_STATE, s1)).toEqual(s1)
    expect(joinJournalState(s1, s1)).toEqual(s1)
  })
})

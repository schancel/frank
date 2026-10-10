// Ticket #818: Conversation identifiers and names in encrypted message content
import {
  parseFrame,
  encodeFrame,
  defaultContext,
  FrankCodecError,
  messageContentDigest,
  toHex,
} from '../src'
import { encodeEncryptedMessageContent } from '../src/token-transfer'
import {
  type6Frame,
  rev8Frame,
  DEFAULT_CONVERSATION_ID,
  bytesOf,
  textItem,
} from '../fixtures/builders'

describe('ticket #818: conversation identifiers and names in encrypted message content', () => {
  it('parses conversation_id and optional conversation_name on type 6', () => {
    const convId = bytesOf(16, 42)
    const frame = type6Frame(
      rev8Frame([textItem('hello')]),
      convId,
      'Project Discussion',
    )
    const parsed = parseFrame(frame, defaultContext())
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(parsed.typed?.type).toBe(6)
    if (parsed.typed?.type !== 6) throw new Error('expected type 6')
    expect(parsed.typed.conversationId).toEqual(convId)
    expect(parsed.typed.conversationName).toBe('Project Discussion')
  })

  it('parses type 6 with conversation_id and omitted conversation_name', () => {
    const convId = bytesOf(16, 43)
    const frame = type6Frame(rev8Frame([textItem('hello')]), convId)
    const parsed = parseFrame(frame, defaultContext())
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    if (parsed.typed?.type !== 6) throw new Error('expected type 6')
    expect(parsed.typed.conversationId).toEqual(convId)
    expect(parsed.typed.conversationName).toBeUndefined()
  })

  it('parses type 6 without conversation_id (field 4), which a reader must accept', () => {
    const rawMap = new Map<number, unknown>([
      [0, 'frank'],
      [1, bytesOf(16, 1)],
      [2, rev8Frame([textItem('test')])],
      [3, messageContentDigest(rev8Frame([textItem('test')]))],
    ])
    const frame = encodeFrame(
      { typeId: 6, schemaVersion: 1, minReaderVersion: 1 },
      rawMap,
    )
    const parsed = parseFrame(frame, defaultContext())
    if (parsed.kind !== 'parsed' || parsed.typed?.type !== 6)
      throw new Error('expected parsed type 6')
    expect(parsed.typed.conversationId).toBeUndefined()

    // With the field, the same content parses with its ID: both shapes round-trip.
    const named = encodeEncryptedMessageContent({
      network: 'frank',
      messageId: bytesOf(16, 1),
      conversationId: bytesOf(16, 9),
      revisionFrame: rev8Frame([textItem('test')]),
    })
    const reopened = parseFrame(named, defaultContext())
    if (reopened.kind !== 'parsed' || reopened.typed?.type !== 6)
      throw new Error('expected parsed type 6')
    expect(reopened.typed.conversationId).toEqual(bytesOf(16, 9))
    // The two differ by exactly field 4.
    expect(toHex(named)).not.toBe(toHex(frame))
    expect(toHex(reopened.typed.messageId)).toBe(toHex(parsed.typed.messageId))
  })

  it('rejects conversation_id with wrong byte length', () => {
    for (const len of [15, 17, 0, 32]) {
      const rawMap = new Map<number, unknown>([
        [0, 'frank'],
        [1, bytesOf(16, 1)],
        [2, rev8Frame([textItem('test')])],
        [3, bytesOf(32, 2)],
        [4, bytesOf(len, 4)],
      ])
      const frame = encodeFrame(
        { typeId: 6, schemaVersion: 1, minReaderVersion: 1 },
        rawMap,
      )
      expect(() => parseFrame(frame, defaultContext())).toThrow(FrankCodecError)
      try {
        parseFrame(frame, defaultContext())
      } catch (e) {
        expect((e as FrankCodecError).category).toBe('schema')
        expect((e as FrankCodecError).stage).toBe('8.2')
      }
    }
  })

  it('rejects whitespace-only or control-character conversation_name', () => {
    for (const invalidName of [
      '   ',
      '\t\n',
      'Hello\x00World',
      'Test\x1FName',
      'Line\u2028Break',
    ]) {
      const frame = type6Frame(
        rev8Frame([textItem('test')]),
        DEFAULT_CONVERSATION_ID,
        invalidName,
      )
      expect(() => parseFrame(frame, defaultContext())).toThrow(FrankCodecError)
      try {
        parseFrame(frame, defaultContext())
      } catch (e) {
        expect((e as FrankCodecError).category).toBe('schema')
        expect((e as FrankCodecError).stage).toBe('8.2')
      }
    }
  })
})

describe('ticket #818: conversation scoping, renaming, and tombstone semantics', () => {
  interface MessageRecord {
    id: string
    conversationId: string
    sender: string
    recipient: string
    timestamp: number
    name?: string
    text: string
  }

  interface ConversationState {
    id: string
    participantsKey: string
    name?: string
    messages: MessageRecord[]
    deletedAt?: number
  }

  function makeParticipantsKey(peerA: string, peerB: string): string {
    return [peerA, peerB].sort().join(':')
  }

  function makeConversationKey(
    participantsKey: string,
    convId: string,
  ): string {
    return `${participantsKey}#${convId}`
  }

  class MockConversationStore {
    conversations = new Map<string, ConversationState>()
    tombstones = new Map<string, number>() // convKey -> deletedAt

    applyMessage(msg: MessageRecord): {
      status: 'accepted' | 'ignored-tombstone'
      convKey: string
    } {
      const participantsKey = makeParticipantsKey(msg.sender, msg.recipient)
      const convKey = makeConversationKey(participantsKey, msg.conversationId)

      const tombstone = this.tombstones.get(convKey)
      if (tombstone !== undefined && msg.timestamp <= tombstone) {
        return { status: 'ignored-tombstone', convKey }
      }

      // If newer than tombstone, clear tombstone and reopen
      if (tombstone !== undefined && msg.timestamp > tombstone) {
        this.tombstones.delete(convKey)
      }

      let conv = this.conversations.get(convKey)
      if (!conv) {
        conv = {
          id: msg.conversationId,
          participantsKey,
          name: msg.name,
          messages: [],
        }
        this.conversations.set(convKey, conv)
      } else if (msg.name !== undefined) {
        // Renames: update conversation name if a newer message provides one
        conv.name = msg.name
      }

      conv.messages.push(msg)
      conv.messages.sort((a, b) => a.timestamp - b.timestamp)
      return { status: 'accepted', convKey }
    }

    deleteConversation(
      peerA: string,
      peerB: string,
      convId: string,
      deletedAt: number,
    ): void {
      const participantsKey = makeParticipantsKey(peerA, peerB)
      const convKey = makeConversationKey(participantsKey, convId)
      this.conversations.delete(convKey)
      this.tombstones.set(convKey, deletedAt)
    }
  }

  it('keeps two conversations with one peer separate', () => {
    const store = new MockConversationStore()
    const peer = '0xBob'
    const me = '0xAlice'

    store.applyMessage({
      id: 'm1',
      conversationId: 'conv-alpha',
      sender: peer,
      recipient: me,
      timestamp: 100,
      name: 'Project Alpha',
      text: 'First message in Alpha',
    })

    store.applyMessage({
      id: 'm2',
      conversationId: 'conv-beta',
      sender: peer,
      recipient: me,
      timestamp: 110,
      name: 'Project Beta',
      text: 'First message in Beta',
    })

    store.applyMessage({
      id: 'm3',
      conversationId: 'conv-alpha',
      sender: me,
      recipient: peer,
      timestamp: 120,
      text: 'Second message in Alpha',
    })

    const alphaKey = makeConversationKey(
      makeParticipantsKey(me, peer),
      'conv-alpha',
    )
    const betaKey = makeConversationKey(
      makeParticipantsKey(me, peer),
      'conv-beta',
    )

    const alpha = store.conversations.get(alphaKey)
    const beta = store.conversations.get(betaKey)

    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expect(alpha?.name).toBe('Project Alpha')
    expect(beta?.name).toBe('Project Beta')
    expect(alpha?.messages.map(m => m.id)).toEqual(['m1', 'm3'])
    expect(beta?.messages.map(m => m.id)).toEqual(['m2'])
  })

  it('prevents a third party reusing a conversation identifier from injecting into an existing conversation', () => {
    const store = new MockConversationStore()
    const me = '0xAlice'
    const peer = '0xBob'
    const eve = '0xEve'

    // Alice and Bob have a conversation with id 'shared-conv-123'
    store.applyMessage({
      id: 'm1',
      conversationId: 'shared-conv-123',
      sender: peer,
      recipient: me,
      timestamp: 100,
      name: 'Confidential Thread',
      text: 'Secret talk between Alice and Bob',
    })

    // Eve sends a message reusing the exact same conversation id 'shared-conv-123' to Alice
    store.applyMessage({
      id: 'm-eve',
      conversationId: 'shared-conv-123',
      sender: eve,
      recipient: me,
      timestamp: 105,
      name: 'Eve Thread',
      text: 'Injection attempt',
    })

    const aliceBobKey = makeConversationKey(
      makeParticipantsKey(me, peer),
      'shared-conv-123',
    )
    const aliceEveKey = makeConversationKey(
      makeParticipantsKey(me, eve),
      'shared-conv-123',
    )

    expect(aliceBobKey).not.toBe(aliceEveKey)

    const aliceBobConv = store.conversations.get(aliceBobKey)
    const aliceEveConv = store.conversations.get(aliceEveKey)

    expect(aliceBobConv).toBeDefined()
    expect(aliceEveConv).toBeDefined()
    expect(aliceBobConv?.messages.map(m => m.id)).toEqual(['m1'])
    expect(aliceEveConv?.messages.map(m => m.id)).toEqual(['m-eve'])
  })

  it('updates conversation name when a newer message carries a new name (rename semantics)', () => {
    const store = new MockConversationStore()
    const me = '0xAlice'
    const peer = '0xBob'

    store.applyMessage({
      id: 'm1',
      conversationId: 'conv-rename',
      sender: peer,
      recipient: me,
      timestamp: 100,
      name: 'Initial Topic',
      text: 'Opening message',
    })

    const key = makeConversationKey(
      makeParticipantsKey(me, peer),
      'conv-rename',
    )
    expect(store.conversations.get(key)?.name).toBe('Initial Topic')

    // Message without name keeps existing name
    store.applyMessage({
      id: 'm2',
      conversationId: 'conv-rename',
      sender: me,
      recipient: peer,
      timestamp: 110,
      text: 'Follow up without subject change',
    })
    expect(store.conversations.get(key)?.name).toBe('Initial Topic')

    // Message with new name updates conversation name
    store.applyMessage({
      id: 'm3',
      conversationId: 'conv-rename',
      sender: peer,
      recipient: me,
      timestamp: 120,
      name: 'Renamed Topic',
      text: 'Renaming the thread',
    })
    expect(store.conversations.get(key)?.name).toBe('Renamed Topic')
  })

  it('ensures a deleted conversation is not resurrected by redelivered messages and is reopened by a newer one', () => {
    const store = new MockConversationStore()
    const me = '0xAlice'
    const peer = '0xBob'
    const convId = 'conv-delete-reopen'
    const key = makeConversationKey(makeParticipantsKey(me, peer), convId)

    // Initial messages
    store.applyMessage({
      id: 'm1',
      conversationId: convId,
      sender: peer,
      recipient: me,
      timestamp: 100,
      name: 'Old Thread',
      text: 'Old message 1',
    })
    store.applyMessage({
      id: 'm2',
      conversationId: convId,
      sender: me,
      recipient: peer,
      timestamp: 150,
      text: 'Old message 2',
    })

    expect(store.conversations.get(key)?.messages).toHaveLength(2)

    // User deletes conversation at timestamp 200
    store.deleteConversation(me, peer, convId, 200)
    expect(store.conversations.get(key)).toBeUndefined()

    // Redelivery / replayed message with timestamp <= 200
    const redelivery = store.applyMessage({
      id: 'm1-redelivery',
      conversationId: convId,
      sender: peer,
      recipient: me,
      timestamp: 100,
      text: 'Old message 1 redelivery',
    })
    expect(redelivery.status).toBe('ignored-tombstone')
    expect(store.conversations.get(key)).toBeUndefined() // Not resurrected!

    // Redelivery with timestamp exactly equal to deletion time
    const atTombstone = store.applyMessage({
      id: 'm2-replay',
      conversationId: convId,
      sender: peer,
      recipient: me,
      timestamp: 200,
      text: 'Boundary message',
    })
    expect(atTombstone.status).toBe('ignored-tombstone')
    expect(store.conversations.get(key)).toBeUndefined() // Still not resurrected!

    // Newer message after deletion timestamp reopens the conversation
    const newer = store.applyMessage({
      id: 'm3-fresh',
      conversationId: convId,
      sender: peer,
      recipient: me,
      timestamp: 250,
      name: 'Reopened Thread',
      text: 'A brand new message',
    })
    expect(newer.status).toBe('accepted')
    const reopened = store.conversations.get(key)
    expect(reopened).toBeDefined()
    expect(reopened?.messages).toHaveLength(1)
    expect(reopened?.messages[0].id).toBe('m3-fresh')
    expect(reopened?.name).toBe('Reopened Thread')
  })
})

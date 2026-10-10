import {
  allocateOpeningConversationId,
  conversationIdSalt,
  formatConversationId,
  uuidv5Bytes,
} from './conversation-id'

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const root = (fill: number) => new Uint8Array(32).fill(fill)
const ALICE = '0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c'
const BOB = '0x5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d'
const CAROL = '0x6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e'

describe('conversation identifiers', () => {
  it('uuidv5Bytes is a real UUIDv5 (RFC 4122 known answer)', () => {
    // `uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')`
    const dns = Uint8Array.from(
      Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'),
    )
    expect(formatConversationId(uuidv5Bytes(dns, 'python.org'))).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    )
  })

  it('derives the same private salt from the same root, and never the root itself', () => {
    const salt = conversationIdSalt(root(0x11))
    expect(salt).toHaveLength(16)
    expect(hex(conversationIdSalt(root(0x11)))).toBe(hex(salt))
    expect(hex(conversationIdSalt(root(0x12)))).not.toBe(hex(salt))
    expect(hex(root(0x11))).not.toContain(hex(salt))
    expect(() => conversationIdSalt(new Uint8Array(16))).toThrow(RangeError)
    // Pinned: every device of an account must derive these bytes across releases.
    expect(hex(salt)).toMatchInlineSnapshot(
      `"84196e2887f4202a33bd73c49f6c047c"`,
    )
  })

  it('one account opens the same ID for a peer every time, on every device', () => {
    // Two devices hold the same root and so the same salt.
    const deviceOne = conversationIdSalt(root(0x11))
    const deviceTwo = conversationIdSalt(root(0x11))
    const id = allocateOpeningConversationId(deviceOne, BOB)
    expect(id).toHaveLength(16)
    expect(id[6] >> 4).toBe(5)
    expect(hex(allocateOpeningConversationId(deviceTwo, BOB))).toBe(hex(id))
    expect(hex(id)).toBe(hex(uuidv5Bytes(deviceOne, BOB)))
  })

  it('two different senders opening a chat with the same recipient allocate different IDs', () => {
    const alice = conversationIdSalt(root(0x11))
    const carol = conversationIdSalt(root(0x33))
    expect(hex(allocateOpeningConversationId(alice, BOB))).not.toBe(
      hex(allocateOpeningConversationId(carol, BOB)),
    )
  })

  it('is per peer, and notes to self are not the ID anyone else gets for that address', () => {
    const alice = conversationIdSalt(root(0x11))
    const bob = conversationIdSalt(root(0x22))
    const ids = [
      allocateOpeningConversationId(alice, BOB),
      allocateOpeningConversationId(alice, CAROL),
      allocateOpeningConversationId(alice, ALICE), // Alice's notes to self
      allocateOpeningConversationId(bob, ALICE), // Bob opening a chat with Alice
    ].map(hex)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('refuses a malformed salt or a missing peer', () => {
    const salt = conversationIdSalt(root(0x11))
    expect(() =>
      allocateOpeningConversationId(new Uint8Array(8), BOB),
    ).toThrow()
    expect(() => allocateOpeningConversationId(salt, '')).toThrow()
  })
})

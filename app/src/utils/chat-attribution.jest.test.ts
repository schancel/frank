/** @jest-environment jsdom */
import { TextDecoder, TextEncoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

jest.mock('./own-address', () => ({
  sameCanonicalAddress: (first: string | null, second: string | null) =>
    Boolean(first && second && first.toLowerCase() === second.toLowerCase()),
}))

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  attributeMessages,
  contrastOnBubble,
  readableKeyColor,
  conversationSenders,
  isGroupConversation,
  otherParticipants,
  resolveSenders,
  senderOf,
} = require('./chat-attribution') as typeof import('./chat-attribution')
const { pubKeyToColor } =
  require('./formatting') as typeof import('./formatting')

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const ALICE = '0x2222222222222222222222222222222222222222'
const BOB = '0x3333333333333333333333333333333333333333'
const STRANGER = '0x5555555555555555555555555555555555555555'
const key = (fill: number) => new Uint8Array(33).fill(fill)

describe('who is in a conversation', () => {
  it('counts the people other than this user, whatever the spelling of the own address', () => {
    expect(otherParticipants([ME.toLowerCase(), ALICE], ME)).toEqual([ALICE])
    expect(isGroupConversation([ME, ALICE], ME)).toBe(false)
    expect(isGroupConversation([ALICE], ME)).toBe(false)
    expect(isGroupConversation([ME], ME)).toBe(false)
    expect(isGroupConversation([ME, ALICE, BOB], ME)).toBe(true)
  })

  it('is not a group while the own address is unknown, so a two-person chat never flashes as one', () => {
    expect(isGroupConversation([ME, ALICE], null)).toBe(false)
    expect(isGroupConversation([ME, ALICE, BOB], undefined)).toBe(false)
  })
})

describe('when a conversation with a peer needs senders shown', () => {
  it('not for the peer alone, but for anyone who is neither this user nor the peer', () => {
    expect(isGroupConversation([ME, ALICE], ME, ALICE)).toBe(false)
    expect(isGroupConversation([ALICE], ME, ALICE)).toBe(false)
    expect(isGroupConversation([ME, ALICE, STRANGER], ME, ALICE)).toBe(true)
    // The peer has not written yet, a stranger has.
    expect(isGroupConversation([ME, STRANGER], ME, ALICE)).toBe(true)
  })

  it("in this user's own notes, as soon as anyone else has posted", () => {
    expect(isGroupConversation([ME], ME, ME)).toBe(false)
    expect(isGroupConversation([ME, STRANGER], ME, ME.toLowerCase())).toBe(true)
  })

  it('a conversation with no single peer needs two other people', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(isGroupConversation([ME, ALICE], ME, id)).toBe(false)
    expect(isGroupConversation([ME, ALICE, BOB], ME, id)).toBe(true)
  })
})

describe('the key colour as name text', () => {
  const colours = [
    'hsl(0, 0%, 60%)', // the pale grey a key can hash to
    'hsl(60, 100%, 60%)',
    'hsl(120, 40%, 60%)',
    'hsl(200, 3.5%, 60%)',
    'hsl(255, 90%, 60%)',
  ]
  it.each([false, true])(
    'reaches 4.5:1 on the bubble with the hue and saturation unchanged (dark: %s)',
    onDark => {
      for (const colour of colours) {
        const readable = readableKeyColor(colour, onDark)
        expect(contrastOnBubble(readable, onDark)).toBeGreaterThanOrEqual(4.5)
        expect(readable.replace(/[\d.]+%\)$/, '')).toBe(
          colour.replace(/[\d.]+%\)$/, ''),
        )
      }
    },
  )

  it('shows the problem it fixes, and leaves a colour that already reads alone', () => {
    expect(contrastOnBubble('hsl(0, 0%, 60%)', false)).toBeLessThan(3)
    expect(readableKeyColor('hsl(240, 100%, 30%)', false)).toBe(
      'hsl(240, 100%, 30%)',
    )
    expect(readableKeyColor('rgb(1, 2, 3)', false)).toBe('rgb(1, 2, 3)')
  })
})

describe('naming a sender', () => {
  it('drops direction marks from a name so it cannot rearrange the address shown after it', () => {
    const senders = resolveSenders([
      { address: ALICE, inContacts: true, name: 'Bob\u202e' },
      { address: BOB, inContacts: true, name: '\u2066Bob' },
    ])
    expect(senderOf(senders, ALICE)?.label).toBe('Bob (0x2222...2222)')
    expect(senderOf(senders, BOB)?.label).toBe('Bob (0x3333...3333)')
  })

  it('uses the contact name, and the address for a blank or not yet loaded one', () => {
    const senders = resolveSenders([
      { address: ALICE, inContacts: true, name: 'Alice', avatar: 'a.png' },
      { address: BOB, inContacts: true, name: 'Loading...' },
      { address: STRANGER, inContacts: true, name: '​ ‮' },
    ])
    expect(senderOf(senders, ALICE.toUpperCase().replace('0X', '0x'))).toEqual({
      address: ALICE,
      label: 'Alice',
      avatar: 'a.png',
      color: undefined,
      inContacts: true,
    })
    expect(senderOf(senders, BOB)?.label).toBe('0x3333...3333')
    expect(senderOf(senders, STRANGER)?.label).toBe('0x5555...5555')
  })

  it('shows someone who is not a contact by address only, whatever name and picture they claim', () => {
    const sender = senderOf(
      resolveSenders([
        {
          address: STRANGER,
          inContacts: false,
          name: 'Alice',
          username: 'alice',
          avatar: 'alice.png',
          pubKey: key(5),
        },
      ]),
      STRANGER,
    )
    expect(sender).toEqual({
      address: STRANGER,
      label: '0x5555...5555',
      avatar: undefined,
      color: pubKeyToColor(key(5)),
      inContacts: false,
    })
  })

  it('gives each sender the colour the rest of the app derives from their key', () => {
    const senders = resolveSenders([
      { address: ALICE, inContacts: true, name: 'Alice', pubKey: key(1) },
      { address: BOB, inContacts: true, name: 'Bob', pubKey: key(2) },
    ])
    expect(senderOf(senders, ALICE)?.color).toBe(pubKeyToColor(key(1)))
    expect(senderOf(senders, BOB)?.color).toBe(pubKeyToColor(key(2)))
    expect(senderOf(senders, ALICE)?.color).not.toBe(
      senderOf(senders, BOB)?.color,
    )
  })

  it('tells equal display names apart: by username when the profile has one, else by address', () => {
    const senders = resolveSenders([
      { address: ALICE, inContacts: true, name: 'Qwen', username: 'qwen' },
      { address: BOB, inContacts: true, name: ' qwen ' },
      { address: STRANGER, inContacts: true, name: 'Carol' },
    ])
    expect(senderOf(senders, ALICE)?.label).toBe('Qwen (@qwen)')
    expect(senderOf(senders, BOB)?.label).toBe(' qwen  (0x3333...3333)')
    expect(senderOf(senders, STRANGER)?.label).toBe('Carol')
  })

  it('resolves the participants and any other sender of the shown messages through the contacts', () => {
    const profiles: Record<string, { name: string; pubKey?: unknown }> = {
      [ALICE]: { name: 'Alice', pubKey: { toBuffer: () => key(1) } },
    }
    const senders = conversationSenders(
      {
        participants: [ME, ALICE, STRANGER],
        members: {
          [STRANGER]: { address: STRANGER, pubKeyHex: '05'.repeat(33) },
        },
      },
      ME,
      {
        isContact: address => address in profiles,
        getContactProfile: address => profiles[address] as never,
      },
      [
        { outbound: true, senderAddress: ME },
        { outbound: false, senderAddress: BOB },
      ],
    )
    expect(Array.from(senders.values()).map(s => s.label)).toEqual([
      'Alice',
      '0x5555...5555',
      '0x3333...3333',
    ])
    expect(senderOf(senders, ALICE)?.color).toBe(pubKeyToColor(key(1)))
    // Not a contact: the key their first message here was checked against.
    expect(senderOf(senders, STRANGER)?.color).toBe(pubKeyToColor(key(5)))
    expect(senderOf(senders, STRANGER)?.inContacts).toBe(false)
    expect(senderOf(senders, BOB)?.color).toBeUndefined()
  })
})

describe('runs of messages', () => {
  const senders = resolveSenders([
    { address: ALICE, inContacts: true, name: 'Alice' },
    { address: BOB, inContacts: true, name: 'Bob' },
  ])
  const from = (address: string) => ({
    outbound: address === ME,
    senderAddress: address,
  })

  it('shows the name on the first message of a run and the avatar on the last', () => {
    const shown = attributeMessages(
      [ALICE, ALICE, ALICE, BOB, ME, BOB, BOB, ALICE].map(from),
      senders,
    ).map(a =>
      a ? `${a.sender.label}:${+a.showName}${+a.showAvatar}` : 'mine',
    )
    expect(shown).toEqual([
      'Alice:10',
      'Alice:00',
      'Alice:01',
      'Bob:11',
      'mine',
      // Our own message in between ends the run before it and starts a new one after.
      'Bob:10',
      'Bob:01',
      'Alice:11',
    ])
  })

  it('attributes nothing of ours and nothing without a known sender', () => {
    expect(attributeMessages([from(ME)], senders)).toEqual([undefined])
    expect(attributeMessages([from(STRANGER)], senders)).toEqual([undefined])
  })
})

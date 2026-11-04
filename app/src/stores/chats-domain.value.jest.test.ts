// What a conversation's unread received messages brought: relay-verified stamps plus what the
// wallets saw arrive on chain for the message, each chain valued in AVU at its own price.
// A payment a message only claims adds nothing (review finding A7 / MSG-1).
import {
  accountedMessageValue,
  amountsInAvu,
  receivedMessageAmounts,
  receivedValueAvu,
  recomputeChatAccounting,
  sortConversationsByReceivedValue,
  unreadValueAvu,
  type ChainAmount,
} from './chats-domain'
import type { ChatMessage, Conversation } from './chats'

jest.mock('./settings', () => ({ useSettingsStore: () => ({}) }))

const DIGEST = 'ab'.repeat(32)
const claimedStealth = {
  type: 'stealth' as const,
  networkTag: 'monad-testnet',
  ephemeralPubKey: '02' + '11'.repeat(32),
  transactions: ['cd'.repeat(32)],
  amount: 1e21,
  amountWei: '1000000000000000000000',
}

function received(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    outbound: false,
    status: 'confirmed',
    receivedTime: 100,
    serverTime: 100,
    items: [claimedStealth],
    outpoints: [],
    senderAddress: '0xPEER',
    destinationAddress: '0xME',
    payloadDigest: DIGEST,
    ...overrides,
  } as ChatMessage
}

const noReceipts = () => []
// Prices: 1 MON = 2 AVU, 1 SOL = 300 AVU; ETH has none.
const DECIMALS: Record<string, number> = {
  'monad-testnet': 18,
  'solana-devnet': 9,
  'ethereum-sepolia': 18,
}
const PRICE: Record<string, number | undefined> = {
  'monad-testnet': 2,
  'solana-devnet': 300,
}
const toAvu = (chain: string, units: bigint) => {
  const price = PRICE[chain]
  return price === undefined
    ? undefined
    : (Number(units) / 10 ** DECIMALS[chain]) * price
}
const chat = (messages: ChatMessage[]) => ({
  id: 'conv',
  lastRead: 0,
  messages,
})

describe('a claimed payment is never counted as received', () => {
  it('a claimed stealth item with no verified receipt adds 0', () => {
    const message = received({ stampValueWei: 0n })
    expect(accountedMessageValue(message)).toBe(0)
    expect(
      receivedMessageAmounts(message, 'monad-testnet', noReceipts),
    ).toEqual([])
    expect(
      unreadValueAvu(chat([message]), null, {
        stampChainIdentifier: 'monad-testnet',
        verifiedReceipts: noReceipts,
        toAvu,
      }),
    ).toBe(0)
  })

  it('the stored stamp total is the stamp alone, never the claim', () => {
    expect(accountedMessageValue(received({ stampValueWei: 5n }))).toBe(5)
  })

  it('counts what the wallet verified for the message, on the wallet’s chain', () => {
    const receipts = jest.fn((digest: string): ChainAmount[] =>
      digest === DIGEST
        ? [{ chainIdentifier: 'monad-testnet', baseUnits: 10n ** 18n }]
        : [],
    )
    expect(
      receivedMessageAmounts(
        received({ stampValueWei: 10n ** 17n }),
        'monad-testnet',
        receipts,
      ),
    ).toEqual([
      { chainIdentifier: 'monad-testnet', baseUnits: 10n ** 17n },
      { chainIdentifier: 'monad-testnet', baseUnits: 10n ** 18n },
    ])
    expect(receipts).toHaveBeenCalledWith(DIGEST)
  })

  it('counts nothing for our own messages or unconfirmed rows', () => {
    const receipts = () => [{ chainIdentifier: 'monad-testnet', baseUnits: 1n }]
    expect(
      receivedMessageAmounts(
        received({ outbound: true, stampValueWei: 5n }),
        'monad-testnet',
        receipts,
      ),
    ).toEqual([])
    expect(
      receivedMessageAmounts(
        received({ status: 'pending', stampValueWei: 5n }),
        'monad-testnet',
        receipts,
      ),
    ).toEqual([])
  })
})

describe('values on different chains are added in AVU', () => {
  it('converts each chain at its own price before summing', () => {
    // 0.5 MON stamp (1 AVU) + 0.01 SOL verified (3 AVU) = 4 AVU; raw units would be ~5e17.
    const message = received({ stampValueWei: 5n * 10n ** 17n })
    const receipts = () => [
      { chainIdentifier: 'solana-devnet', baseUnits: 10n ** 7n },
    ]
    expect(
      unreadValueAvu(chat([message]), null, {
        stampChainIdentifier: 'monad-testnet',
        verifiedReceipts: receipts,
        toAvu,
      }),
    ).toBeCloseTo(4)
  })

  it('counts only unread received messages', () => {
    const read = received({ serverTime: 50, stampValueWei: 10n ** 18n })
    const unread = received({ serverTime: 150, stampValueWei: 10n ** 18n })
    const value = {
      stampChainIdentifier: 'monad-testnet',
      verifiedReceipts: noReceipts,
      toAvu,
    }
    expect(
      unreadValueAvu({ ...chat([read, unread]), lastRead: 100 }, null, value),
    ).toBeCloseTo(2)
    expect(unreadValueAvu(chat([unread]), 'conv', value)).toBe(0)
  })

  it('shows no total when part of it has no price', () => {
    const amounts = [
      { chainIdentifier: 'monad-testnet', baseUnits: 10n ** 18n },
      { chainIdentifier: 'ethereum-sepolia', baseUnits: 10n ** 18n },
    ]
    expect(amountsInAvu(amounts, toAvu)).toBeUndefined()
    expect(amountsInAvu(amounts.slice(0, 1), toAvu)).toBeCloseTo(2)
    expect(amountsInAvu([], toAvu)).toBe(0)
  })
})

describe('inbox received-value ordering', () => {
  const value = {
    stampChainIdentifier: 'monad-testnet',
    verifiedReceipts: noReceipts,
    toAvu,
  }
  function conversation(
    id: string,
    amount: bigint,
    unread = false,
    time = 100,
  ): Conversation {
    return {
      id,
      address: id,
      kind: 'direct',
      participants: [],
      totalUnreadMessages: unread ? 1 : 0,
      lastRead: unread ? 0 : time,
      lastReceived: time,
      messages: [
        received({
          payloadDigest: id,
          serverTime: time,
          stampValueWei: amount,
        }),
      ],
    } as Conversation
  }
  const ids = (rows: Conversation[], context = value) =>
    sortConversationsByReceivedValue(rows, null, context).map(c => c.id)

  it('puts unread first and sorts both unread and read groups by descending AVU', () => {
    const rows = [
      conversation('read-rich', 100n * 10n ** 18n),
      conversation('unread-small', 1n, true),
      conversation('read-small', 1n),
      conversation('unread-rich', 10n ** 18n, true),
    ]
    expect(ids(rows)).toEqual([
      'unread-rich',
      'unread-small',
      'read-rich',
      'read-small',
    ])
    expect(rows.map(c => c.id)).toEqual([
      'read-rich',
      'unread-small',
      'read-small',
      'unread-rich',
    ])
    expect(receivedValueAvu(rows[0], value)).toBe(200)
  })

  it('uses unread amounts for unread rows and all received amounts after reading', () => {
    const a = conversation('a', 100n * 10n ** 18n, true, 50)
    a.lastRead = 100
    a.messages.push(
      received({ payloadDigest: 'new-a', serverTime: 150, stampValueWei: 1n }),
    )
    const b = conversation('b', 10n ** 18n, true, 150)
    expect(ids([a, b])).toEqual(['b', 'a'])
    a.totalUnreadMessages = 0
    a.lastRead = 200
    b.totalUnreadMessages = 0
    b.lastRead = 200
    expect(ids([a, b])).toEqual(['a', 'b'])
  })

  it('values verified cross-chain receipts before comparing and ignores claimed payments', () => {
    const a = conversation('native', 10n ** 18n)
    const b = conversation('sol', 0n)
    expect(ids([a, b])).toEqual(['native', 'sol'])
    const receipts = jest.fn((digest: string): ChainAmount[] =>
      digest === 'sol'
        ? [{ chainIdentifier: 'solana-devnet', baseUnits: 10n ** 7n }]
        : [],
    )
    expect(ids([a, b], { ...value, verifiedReceipts: receipts })).toEqual([
      'sol',
      'native',
    ])
    // Each message is valued once, not repeatedly by the sorting comparator.
    expect(receipts).toHaveBeenCalledTimes(2)
  })

  it('orders known zero ahead of unknown and makes equal/unknown ties independent of insertion', () => {
    const known = conversation('known-zero', 0n, true)
    const unknownA = conversation('unknown-a', 0n, true)
    const unknownB = conversation('unknown-b', 0n, true)
    const receipts = (digest: string): ChainAmount[] =>
      digest.startsWith('unknown')
        ? [{ chainIdentifier: 'ethereum-sepolia', baseUnits: 10n ** 18n }]
        : []
    const context = { ...value, verifiedReceipts: receipts }
    expect(ids([unknownB, known, unknownA], context)).toEqual([
      'known-zero',
      'unknown-a',
      'unknown-b',
    ])
    expect(ids([unknownA, unknownB, known], context)).toEqual([
      'known-zero',
      'unknown-a',
      'unknown-b',
    ])
    const older = conversation('older', 10n ** 18n, false, 50)
    const newer = conversation('newer', 10n ** 18n, false, 100)
    expect(ids([older, newer])).toEqual(['newer', 'older'])
    expect(ids([conversation('b', 1n), conversation('a', 1n)])).toEqual([
      'a',
      'b',
    ])
  })

  it('does not promote outgoing, unconfirmed, or partly unpriced claimed value', () => {
    const a = conversation('a', 0n)
    a.messages.push(
      received({ outbound: true, stampValueWei: 100n * 10n ** 18n }),
    )
    a.messages.push(
      received({ status: 'pending', stampValueWei: 100n * 10n ** 18n }),
    )
    expect(receivedValueAvu(a, value)).toBe(0)
    const b = conversation('b', 1n)
    expect(ids([a, b])).toEqual(['b', 'a'])
    expect(ids([b, a], { ...value, toAvu: () => Number.NaN })).toEqual([
      'a',
      'b',
    ])
  })
})

describe('stored chat accounting', () => {
  function conversation(messages: ChatMessage[]): Conversation {
    return {
      ...chat(messages),
      kind: 'direct',
      address: '0xPEER',
      participants: [],
      lastReceived: 200,
      lastRead: 100,
      totalValue: -1,
      totalUnreadMessages: -1,
      totalUnreadValue: -1,
    }
  }

  it('preserves stamp accounting and unread rules across reading and activation', () => {
    const row = conversation([
      received({ serverTime: 50, stampValueWei: 2n }),
      received({ serverTime: 100, stampValueWei: 3n }),
      received({ serverTime: 150, stampValueWei: 5n }),
      received({ serverTime: 160, outbound: true, stampValueWei: 7n }),
      received({
        serverTime: 170,
        senderAddress: '0x' + '11'.repeat(20),
        destinationAddress: '0x' + '11'.repeat(20),
        stampValueWei: 11n,
      }),
      received({ serverTime: 180, status: 'pending', stampValueWei: 1000n }),
      received({ serverTime: 190 }), // A claimed payment without a verified stamp.
    ])
    const messages = row.messages.slice()
    const totals = () => [
      row.totalValue,
      row.totalUnreadMessages,
      row.totalUnreadValue,
    ]

    recomputeChatAccounting(row, 'another-conversation')
    // Stored total includes confirmed outgoing/self stamps; unread excludes them.
    // Pending and unstamped incoming messages are unread, but add no value.
    expect(totals()).toEqual([28, 3, 5])
    recomputeChatAccounting(row, row.id)
    expect(totals()).toEqual([28, 0, 0])
    recomputeChatAccounting(row, null)
    expect(totals()).toEqual([28, 3, 5])
    row.lastRead = 200
    recomputeChatAccounting(row, null)
    expect(totals()).toEqual([28, 0, 0])
    expect(row.messages).toEqual(messages)
  })

  it.each([0, 1, 120])(
    'publishes each total once after scanning %i messages without reading prior totals',
    size => {
      const scanned = new Set<number>()
      const row = conversation(
        Array.from({ length: size }, (_, index) => {
          const message = received({ serverTime: 150, stampValueWei: 5n })
          Object.defineProperty(message, 'status', {
            get() {
              scanned.add(index)
              return 'confirmed'
            },
          })
          return message
        }),
      )
      const totalKeys = [
        'totalValue',
        'totalUnreadMessages',
        'totalUnreadValue',
      ]
      const reads = jest.fn()
      const writes = jest.fn()
      // Observe the exported function's property accesses, including redundant assignments
      // that a reactive observer might suppress when the value has not changed.
      const observed = new Proxy(row, {
        get(target, key, receiver) {
          if (totalKeys.includes(String(key))) reads(key)
          return Reflect.get(target, key, receiver)
        },
        set(target, key, value, receiver) {
          if (totalKeys.includes(String(key))) {
            writes(key, value)
            expect(scanned.size).toBe(size)
          }
          return Reflect.set(target, key, value, receiver)
        },
      })

      recomputeChatAccounting(observed, null)

      expect(reads).not.toHaveBeenCalled()
      expect(writes.mock.calls).toEqual([
        ['totalValue', size * 5],
        ['totalUnreadMessages', size],
        ['totalUnreadValue', size * 5],
      ])
      expect(row.totalValue).toBe(size * 5)
      expect(row.totalUnreadMessages).toBe(size)
      expect(row.totalUnreadValue).toBe(size * 5)
    },
  )
})

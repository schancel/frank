// What a conversation's unread received messages brought: relay-verified stamps plus what the
// wallets saw arrive on chain for the message, each chain valued in AVU at its own price.
// A payment a message only claims adds nothing (review finding A7 / MSG-1).
import {
  accountedMessageValue,
  amountsInAvu,
  receivedMessageAmounts,
  unreadValueAvu,
  type ChainAmount,
} from './chats-domain'
import type { ChatMessage } from './chats'

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

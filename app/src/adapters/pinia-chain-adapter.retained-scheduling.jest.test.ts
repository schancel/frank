import type { FinancialEnvelopeBinding } from '@frank/cashweb/relay/storage/storage'
import type { WalletHandle } from '@frank/wallet/chain'
import { activeChain } from '@frank/wallet/chain'
import { startOutgoingReconciliation } from './pinia-chain-adapter'

const mockWallet = { chainIdentifier: 'monad-testnet' } as WalletHandle
const mockAccount = { receipt: { context: { accountId: 'scheduler-account' } } }
const mockRows: FinancialEnvelopeBinding[] = Array.from(
  { length: 17 },
  (_, i) => ({
    version: 1,
    phase: 'bound',
    accountId: 'scheduler-account',
    messagingChainIdentifier: 'monad-testnet',
    messageId: `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`,
    payloadDigest: i.toString(16).padStart(64, '0'),
    financialOperations: [
      { chainIdentifier: 'solana-devnet', operationId: `original-${i}` },
    ],
  }),
)
const mockSubmitted: string[] = []
const mockReconcile = jest.fn()
const mockChats = {
  conversations: {} as Record<
    string,
    { messages: { outbound: boolean; status: string; payloadDigest: string }[] }
  >,
  reconcileOutgoing: mockReconcile,
  $onAction: jest.fn(
    (
      _callback: (action: {
        name: string
        after(callback: () => void): void
      }) => void,
    ) => jest.fn(),
  ),
}
jest.mock('../stores/chats', () => ({
  useChatStore: () => mockChats,
  walletOwnsMessage: () => true,
}))
jest.mock('../accounts/session', () => ({
  accountSession: {
    state: {
      status: 'ready',
      revision: 1,
      get account() {
        return mockAccount
      },
    },
    peekWallet: () => mockWallet,
  },
}))
jest.mock('./level-message-store', () => ({
  store: {
    then: (resolve: (store: unknown) => void) =>
      resolve({
        financialEnvelopeBindings: async () => mockRows,
        bindFinancialEnvelope: jest.fn(),
      }),
  },
}))
jest.mock('../stealth-payments/outgoing', () => ({
  captureOutgoingFinancialOperations: async (
    _wallet: unknown,
    refs: { operationId: string }[],
  ) => ({
    expose: jest.fn(),
    submit: async () => {
      mockSubmitted.push(refs[0].operationId)
    },
  }),
}))
jest.mock('../accounts/utxo-wallets', () => ({
  peekOpenedUtxoWallets: () => [],
}))
jest.mock('../accounts/evm-wallets', () => ({
  recoverSecondaryEvmWallets: async () => undefined,
}))
jest.mock('../utils/outgoing-payments', () => ({
  refreshOutgoingPaymentSummaries: () => 0,
}))

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
let release: () => void
let stop: (() => void) | undefined
let visibility: (() => void) | undefined
const originalDocument = global.document
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
  mockSubmitted.length = 0
  mockChats.conversations = {}
  mockChats.$onAction.mockClear()
  mockReconcile.mockReset().mockImplementation(
    () =>
      new Promise(resolve => {
        release = () => resolve({ pending: 1 })
      }),
  )
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: {
      hidden: false,
      addEventListener: (_name: string, callback: () => void) => {
        visibility = callback
      },
      removeEventListener: jest.fn(),
    },
  })
  jest
    .spyOn(activeChain.directMessages, 'deliveryOf')
    .mockResolvedValue('delivered')
  jest
    .spyOn(activeChain.directMessages, 'unattributedAttempts')
    .mockResolvedValue([])
})
afterEach(async () => {
  stop?.()
  release?.()
  await flush()
  jest.restoreAllMocks()
  jest.useRealTimers()
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: originalDocument,
  })
})

it('advances retained batches while chat reconciliation is blocked, with one timer and no second chat run', async () => {
  stop = startOutgoingReconciliation({
    wallet: mockWallet,
    intervalMs: 10,
    backgroundIntervalMs: 40,
  }).stop
  await flush()
  expect(mockSubmitted).toHaveLength(16)
  expect(mockReconcile).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(10)
  await flush()
  expect(mockSubmitted).toContain('original-16')
  expect(mockReconcile).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(1)
  stop()
  expect(jest.getTimerCount()).toBe(0)
  const before = mockSubmitted.length
  jest.advanceTimersByTime(100)
  await flush()
  expect(mockSubmitted).toHaveLength(before)
})

it('uses background cadence for the pulse and visibility wakeup preserves chat exclusion and one timer', async () => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  stop = startOutgoingReconciliation({
    wallet: mockWallet,
    intervalMs: 10,
    backgroundIntervalMs: 40,
  }).stop
  await flush()
  jest.advanceTimersByTime(39)
  await flush()
  expect(mockSubmitted).toHaveLength(16)
  jest.advanceTimersByTime(1)
  await flush()
  expect(mockSubmitted).toContain('original-16')
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  })
  visibility!()
  await flush()
  expect(mockReconcile).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(1)
  release()
  await flush()
  expect(jest.getTimerCount()).toBe(1)
  jest.advanceTimersByTime(19)
  await flush()
  expect(mockReconcile).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(1)
  await flush()
  expect(mockReconcile).toHaveBeenCalledTimes(2)
})

it('preserves a mid-chat pending-message reset across retained wake pulses', async () => {
  stop = startOutgoingReconciliation({
    wallet: mockWallet,
    intervalMs: 10,
  }).stop
  await flush()
  mockChats.conversations = {
    added: {
      messages: [
        {
          outbound: true,
          status: 'payment-pending',
          payloadDigest: 'new-message',
        },
      ],
    },
  }
  mockChats.$onAction.mock.calls[0][0]({
    name: 'setOutgoingStateExclusive',
    after: callback => callback(),
  })
  jest.advanceTimersByTime(10)
  await flush()
  expect(mockReconcile).toHaveBeenCalledTimes(1)
  release()
  await flush()
  expect(jest.getTimerCount()).toBe(1)
  jest.advanceTimersByTime(9)
  await flush()
  expect(mockReconcile).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(1)
  await flush()
  expect(mockReconcile).toHaveBeenCalledTimes(2)
})

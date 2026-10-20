/** @jest-environment jsdom */
// Wiring tests for Chat.vue's follow-up sends and its blackjack methods: the real component
// methods run against a minimal `this`.

let mockWallet = { id: 'wallet-a' }
const mockAccountState = { revision: 1, status: 'ready', account: {} }
const mockCaptureFinancialWallet = jest.fn()
const mockCreateFinancialContext = jest.fn(async (chainIdentifier: string) => ({
  chain: { chainIdentifier },
  captureWallet: mockCaptureFinancialWallet,
}))
let mockStoredRead: Promise<void> | undefined
let mockReadStarted: (() => void) | undefined
jest.mock('../accounts/session', () => ({
  accountStatus: mockAccountState,
  accountSession: {
    get state() {
      return mockAccountState
    },
    getWallet: async () => mockWallet,
  },
}))
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      mockReadStarted?.()
      await mockStoredRead
      yield* []
    },
  }),
}))
jest.mock('../accounts/native-transfer', () => ({
  createNativeTransferContext: (chainIdentifier: string) =>
    mockCreateFinancialContext(chainIdentifier),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => mockWallet }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    fromDisplayAmount: (s: string) => BigInt(Math.round(Number(s) * 1e18)),
    unit: 'MON',
    chainIdentifier: 'monad-testnet',
    parseAddress: (raw: string) => ({ raw }),
    fetchProfile: jest.fn(),
    directMessages: { quoteStamp: jest.fn() },

    nativeTransfers: { getBalance: jest.fn() },
    toDisplayAmount: (n: bigint) => n.toString(),
  },
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

jest.mock('../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => '0xMe',
  sameCanonicalAddress: (a: string, b: string) => a === b,
  useReactiveOwnCanonicalAddress: () => ({ value: '0xMe' }),
}))

import { randomUUID } from 'node:crypto'
import ChatPage from './Chat.vue'
import type {
  PreparedStealthPayment,
  StealthPaymentCapability,
  StealthPaymentIntent,
  StealthPaymentQuote,
} from '@frank/wallet/stealth-payment'
import type {
  ReviewedStealthDialogIntent,
  StealthDialogRequest,
} from '../stealth-payments/options'
import { errorNotify } from '../utils/notifications'
import { activeChain } from '@frank/wallet/chain'
import { accountStatus, accountSession } from '../accounts/session'
import { useActiveWallet } from '../composables/useActiveWallet'
import {
  commitmentOf,
  dealerStep,
  foldHand,
  playerStep,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import {
  HAND_FEE_RESERVE_WEI,
  loadSeed,
  saveSeed,
} from '../utils/blackjack-hand'

const methods = (ChatPage as unknown as { methods: Record<string, any> })
  .methods
const computed = (ChatPage as unknown as { computed: Record<string, any> })
  .computed
const items = [{ type: 'blackjack-hand', gameId: 'g', action: 'bet' }]

function fakeThis(over: Record<string, unknown> = {}) {
  const self: Record<string, any> = {
    address: '0xDealer',
    sendingMessage: false,
    bottom: true,
    stampAmount: '0.01',
    stampPreparationStatus: null,
    $t: (key: string) => key,
    showStampPreparation: (p: unknown) =>
      methods.showStampPreparation.call(self, p),
    sendDirectMessage: jest
      .fn()
      .mockResolvedValue({ state: 'sent', payloadDigest: 'd' }),
    $nextTick: jest.fn(),
    buttonScrollBottom: jest.fn(),
    ...over,
  }
  // The real computed: what this user and the chat's peer sent, and nobody else.
  Object.defineProperty(self, 'peerMessages', {
    get: () => computed.peerMessages.call(self),
  })
  self.sendFollowUpItemsUnsettled = (p: unknown) =>
    methods.sendFollowUpItemsUnsettled.call(self, p)
  self.sendFollowUpItems = (p: unknown) =>
    methods.sendFollowUpItems.call(self, p)
  return self
}

describe('Chat.vue sendFollowUpItems outcome (#310)', () => {
  beforeEach(() => jest.mocked(errorNotify).mockReset())

  it('reports true only when the message was actually sent', async () => {
    const self = fakeThis()
    await expect(methods.sendFollowUpItems.call(self, { items })).resolves.toBe(
      true,
    )
    expect(self.sendDirectMessage).toHaveBeenCalledTimes(1)
  })

  it('reports false when the send fails (error toast, not a silent success)', async () => {
    const self = fakeThis({
      sendDirectMessage: jest.fn().mockRejectedValue(new Error('relay down')),
    })
    await expect(methods.sendFollowUpItems.call(self, { items })).resolves.toBe(
      false,
    )
    expect(errorNotify).toHaveBeenCalled()
  })

  it('reports false when another send is in flight (the call is dropped)', async () => {
    const self = fakeThis({ sendingMessage: true })
    await expect(methods.sendFollowUpItems.call(self, { items })).resolves.toBe(
      false,
    )
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
  })

  it('reports a localized unavailable default before parsing or sending a card action', async () => {
    const self = fakeThis({
      stampAmount: '',
      stampUnavailable: 'localized missing rate',
    })
    const settled = jest.fn()
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [{ type: 'text', text: 'card action' }],
        settled,
      }),
    ).resolves.toBe(false)
    expect(errorNotify).toHaveBeenCalledWith(
      new Error('localized missing rate'),
    )
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledWith(false)
    expect(self.sendingMessage).toBe(false)
  })

  it('sends an explicit free card action while the default quote is unavailable', async () => {
    const self = fakeThis({
      stampAmount: '',
      stampUnavailable: 'localized missing rate',
    })
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [{ type: 'text', text: 'free card action' }],
        stampValueWei: 0n,
      }),
    ).resolves.toBe(true)
    expect(self.sendDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: mockWallet,
        stampValue: 0n,
      }),
    )
    expect(errorNotify).not.toHaveBeenCalled()
  })
})

describe('Chat.vue priced action availability and custody affinity', () => {
  beforeEach(() => {
    jest.mocked(errorNotify).mockReset()
    jest.mocked(useActiveWallet).mockReset()
  })

  it('handles an unavailable automatic default before email financial preparation', async () => {
    const conversation = { id: 'email-1', name: 'alice@example.com' }
    const self = fakeThis({
      stampAmount: '',
      stampUnavailable: 'localized missing rate',
      conversation,
      chatStore: { conversations: { 'email-1': conversation } },
      message: 'retained draft',
    })
    await methods.sendEmailReply.call(self, {
      conversationId: conversation.id,
      items: [],
    })
    expect(errorNotify).toHaveBeenCalledWith(
      new Error('localized missing rate'),
    )
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
    expect(useActiveWallet).not.toHaveBeenCalled()
    expect(self.message).toBe('retained draft')
    expect(self.sendingMessage).toBe(false)
  })

  it('keeps an explicit zero stamp available for email', async () => {
    const original = mockWallet
    mockWallet = { id: 'explicit-free' }
    jest
      .mocked(useActiveWallet)
      .mockImplementation(async () => mockWallet as never)
    const conversation = { id: 'email-1', name: 'alice@example.com' }
    const self = fakeThis({
      stampAmount: '0',
      stampUnavailable: '',
      conversation,
      chatStore: { conversations: { 'email-1': conversation } },
    })
    try {
      await methods.sendEmailReply.call(self, {
        conversationId: conversation.id,
        items: [],
      })
      expect(self.sendDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({ wallet: mockWallet, stampValue: 0n }),
      )
      expect(errorNotify).not.toHaveBeenCalled()
    } finally {
      mockWallet = original
    }
  })
})

// These exercise Chat + the real review/prepare-to-wire handoff. The financial capability
// below is an explicit boundary fixture, not evidence of SDK signing or owner composition.
describe('Chat.vue reviewed stealth financial handoff', () => {
  const uuidDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.crypto,
    'randomUUID',
  )
  beforeAll(() => {
    // jsdom lacks this standard browser API; use the real platform UUID implementation.
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: randomUUID,
    })
  })
  afterAll(() => {
    if (uuidDescriptor)
      Object.defineProperty(globalThis.crypto, 'randomUUID', uuidDescriptor)
    else Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
  })
  const publicKey = Uint8Array.from([2, ...Array<number>(32).fill(17)])
  const request: StealthDialogRequest = {
    address: '0xDealer',
    chainIdentifier: 'xec-testnet',
    assetKey: 'xec-testnet:native',
    asset: { kind: 'native' },
    amountAtomic: 100n,
    memo: 'lunch',
  }
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => {
      resolve = done
    })
    return { promise, resolve }
  }
  function fixture(over: Record<string, unknown> = {}) {
    const self = fakeThis({
      conversation: { id: 'conversation-a' },
      stampUnavailable: '',
      stealthDialog: true,
      stealthReviewSequence: 0,
      stealthReview: null,
      stealthReviewedRequest: null,
      stealthQuote: { status: 'idle' },
      ...over,
    })
    const prepared = (operationId: string): PreparedStealthPayment => ({
      operationId,
      chainIdentifier: request.chainIdentifier,
      asset: request.asset,
      amountAtomic: request.amountAtomic,
      recipientAddress: 'ectest:reviewed-destination',
      recipientDestination: Uint8Array.from(
        Buffer.from(`76a914${'12'.repeat(20)}88ac`, 'hex'),
      ),
      recipientSpendPublicKey: publicKey.slice(),
      ephemeralPublicKey: publicKey.slice(),
      members: [
        {
          rawTransaction: '010203',
          txHash: 'ab'.repeat(32),
          recipientAmountAtomic: 100n,
          vout: 2,
        },
      ],
    })
    const quote = jest.fn(
      async (
        intent: Omit<StealthPaymentIntent, 'maxNativeFeeAtomic'>,
      ): Promise<StealthPaymentQuote> => ({
        ...prepared(intent.operationId),
        nativeBalanceAtomic: 1000n,
        assetBalanceAtomic: 1000n,
        estimatedNativeFeeAtomic: 10n,
      }),
    )
    const prepare = jest.fn(async (intent: StealthPaymentIntent) =>
      prepared(intent.operationId),
    )
    const release = jest.fn(async () => true)
    const expose = jest.fn(async () => undefined),
      submit = jest.fn(async () => ({
        status: 'pending' as const,
        intendedAmountAtomic: request.amountAtomic,
      }))
    const payments: StealthPaymentCapability = {
      quote,
      prepare,
      release,
      expose,
      submit,
      reconcile: jest.fn(async () => ({
        status: 'pending',
        intendedAmountAtomic: request.amountAtomic,
      })),
      get: jest.fn(async () => undefined),
      list: jest.fn(async () => []),
    }
    const wallet = {
      chainIdentifier: request.chainIdentifier,
      stealthPayments: payments,
    }
    mockCaptureFinancialWallet.mockImplementation(async () => {
      const messagingWallet = mockWallet
      const revision = mockAccountState.revision
      return {
        wallet,
        assertCurrent: async () => {
          if (
            mockWallet !== messagingWallet ||
            mockAccountState.revision !== revision
          )
            throw new Error('Captured financial owner changed')
        },
      }
    })
    return {
      self,
      wallet,
      payments,
      quote,
      prepare,
      prepared,
      release,
      expose,
      submit,
    }
  }
  async function review(f: ReturnType<typeof fixture>) {
    await methods.reviewStealthPayment.call(f.self, request)
    expect(
      f.self.stealthQuote.status === 'error'
        ? f.self.stealthQuote.message
        : f.self.stealthQuote.status,
    ).toBe('ready')
    const state = f.self.stealthQuote
    const intent: ReviewedStealthDialogIntent = {
      ...request,
      quote: state.payment,
      maxNativeFeeAtomic: state.maxNativeFeeAtomic,
      stampValue: state.stampValueAtomic,
    }
    return intent
  }
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.mocked(errorNotify).mockReset()
    mockAccountState.status = 'ready'
    mockAccountState.revision = 1
    mockAccountState.account = {}
    mockWallet = { id: 'messaging-owner-a' }
    mockCaptureFinancialWallet.mockReset()
    mockCreateFinancialContext.mockClear()
    jest
      .mocked(activeChain.fetchProfile)
      .mockReset()
      .mockResolvedValue({ pubKey: publicKey } as never)
    jest
      .mocked(activeChain.directMessages.quoteStamp!)
      .mockReset()
      .mockImplementation(async params => ({
        status: 'available',
        chainIdentifier: 'monad-testnet',
        stampValueAtomic: params.stampValue,
        spendableCapacityAtomic: params.stampValue + 2n,
        maximumNativeFeeAtomic: params.stampValue === 0n ? 0n : 2n,
      }))
  })
  afterEach(() => {
    jest.restoreAllMocks()
    mockWallet = { id: 'wallet-a' }
    mockAccountState.status = 'ready'
    mockAccountState.revision = 1
  })

  it('reports an unavailable default during review before opening either financial or messaging custody', async () => {
    const f = fixture({
      stampAmount: '',
      stampUnavailable: 'localized missing rate',
    })
    const getWallet = jest.spyOn(accountSession, 'getWallet')
    await methods.reviewStealthPayment.call(f.self, request)
    expect(f.self.stealthQuote).toEqual({
      status: 'error',
      message: 'Error: localized missing rate',
    })
    expect(getWallet).not.toHaveBeenCalled()
    expect(mockCaptureFinancialWallet).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
  })

  it('reviews an explicit zero stamp without signing, then hands exact payment bytes and financial refs to the captured messaging wallet', async () => {
    const f = fixture({ stampAmount: '0' })
    const messagingWallet = mockWallet
    const intent = await review(f)
    expect(f.quote).toHaveBeenCalledWith(
      expect.objectContaining({
        chainIdentifier: request.chainIdentifier,
        amountAtomic: 100n,
        recipientSpendPublicKey: publicKey,
      }),
    )
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
    expect(mockCreateFinancialContext).toHaveBeenCalledWith('xec-testnet')
    expect(intent.stampValue).toBe(0n)
    expect(intent.maxNativeFeeAtomic).toBe(10n)
    await methods.sendStealthPayment.call(f.self, intent)
    expect(f.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: intent.quote.operationId,
        chainIdentifier: request.chainIdentifier,
        amountAtomic: 100n,
        maxNativeFeeAtomic: 10n,
        recipientSpendPublicKey: publicKey,
      }),
    )
    expect(f.self.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(f.self.sendDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: messagingWallet,
        address: request.address,
        conversationId: 'conversation-a',
        stampValue: 0n,
        financialOperations: [
          {
            chainIdentifier: 'xec-testnet',
            operationId: intent.quote.operationId,
          },
        ],
        items: [
          {
            type: 'stealth-asset',
            memo: 'lunch',
            transfers: [
              expect.objectContaining({
                chainIdentifier: 'xec-testnet',
                rawTx: '010203',
                txId: 'ab'.repeat(32),
                vout: 2,
                amountAtomic: '100',
                destination: `76a914${'12'.repeat(20)}88ac`,
              }),
            ],
          },
        ],
      }),
    )
    expect(f.release).not.toHaveBeenCalled()
    expect(f.expose).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.self.stealthDialog).toBe(false)
    expect(f.self.sendingMessage).toBe(false)
    expect(errorNotify).not.toHaveBeenCalled()
  })

  it('shows pending quote state across profile lookup and ignores a quote for a route that changed', async () => {
    const f = fixture()
    const profile = deferred<never>()
    const started = deferred<void>()
    jest.mocked(activeChain.fetchProfile).mockImplementationOnce(() => {
      started.resolve()
      return profile.promise
    })
    const pending = methods.reviewStealthPayment.call(f.self, request)
    await started.promise
    expect(f.self.stealthQuote.status).toBe('pending')
    expect(f.prepare).not.toHaveBeenCalled()
    f.self.address = '0xAnotherPeer'
    profile.resolve({ pubKey: publicKey } as never)
    await pending
    expect(f.self.stealthQuote.status).toBe('error')
    expect(f.self.stealthReview).toBeNull()
    expect(f.quote).not.toHaveBeenCalled()
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
  })

  it.each(['route', 'account'])(
    'invalidates an accepted review after %s changes before preparation',
    async change => {
      const f = fixture()
      const intent = await review(f)
      if (change === 'route') f.self.conversation = { id: 'conversation-b' }
      else {
        mockWallet = { id: 'messaging-owner-b' }
        mockAccountState.revision++
      }
      await methods.sendStealthPayment.call(f.self, intent)
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
      expect(f.self.stealthReview).toBeNull()
      expect(f.self.sendingMessage).toBe(false)
      expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
        fallbackKey: 'sendStealthDialog.messageEnded',
      })
    },
  )

  it('rejects a current wallet returned after account replacement during the custody await, before quoting or preparation', async () => {
    const f = fixture()
    const waiting = deferred<never>()
    const started = deferred<void>()
    jest.spyOn(accountSession, 'getWallet').mockImplementationOnce(() => {
      started.resolve()
      return waiting.promise
    })
    const reviewing = methods.reviewStealthPayment.call(f.self, request)
    await started.promise
    mockWallet = { id: 'messaging-owner-b' }
    mockAccountState.revision++
    waiting.resolve(mockWallet as never)
    await reviewing
    expect(f.self.stealthQuote.status).toBe('error')
    expect(f.self.stealthReview).toBeNull()
    expect(f.quote).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
  })

  it('clears busy state after preparation fails and requires a fresh review for a deliberate retry', async () => {
    const f = fixture()
    const intent = await review(f)
    f.prepare.mockRejectedValueOnce(new Error('construction unavailable'))
    await methods.sendStealthPayment.call(f.self, intent)
    expect(f.self.sendingMessage).toBe(false)
    expect(f.self.stealthDialog).toBe(true)
    expect(f.self.stealthReview).toBeNull()
    expect(f.release).toHaveBeenCalledWith(intent.quote.operationId)
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
    await methods.sendStealthPayment.call(f.self, intent)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    const retry = await review(f)
    expect(retry.quote.operationId).not.toBe(intent.quote.operationId)
    await methods.sendStealthPayment.call(f.self, retry)
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.self.sendDirectMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses changed amount or fee approval without preparing or discarding the accepted review', async () => {
    const f = fixture()
    const intent = await review(f)
    await methods.sendStealthPayment.call(f.self, {
      ...intent,
      amountAtomic: 101n,
    })
    await methods.sendStealthPayment.call(f.self, {
      ...intent,
      maxNativeFeeAtomic: 11n,
    })
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
    expect(f.self.stealthReview).not.toBeNull()
  })

  it('keeps the dialog busy during asynchronous preparation and drops a duplicate send', async () => {
    const f = fixture()
    const intent = await review(f)
    const signed = deferred<PreparedStealthPayment>()
    const started = deferred<void>()
    f.prepare.mockImplementationOnce(() => {
      started.resolve()
      return signed.promise
    })
    const sending = methods.sendStealthPayment.call(f.self, intent)
    await started.promise
    expect(f.self.sendingMessage).toBe(true)
    expect(f.self.stealthDialog).toBe(true)
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
    await methods.sendStealthPayment.call(f.self, intent)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    signed.resolve(f.prepared(intent.quote.operationId))
    await sending
    expect(f.self.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(f.self.sendingMessage).toBe(false)
  })

  it('never hands A prepared authorization to B after custody changes while preparation awaits', async () => {
    const f = fixture()
    const intent = await review(f)
    const signed = deferred<PreparedStealthPayment>()
    const started = deferred<void>()
    const original = f.prepared(intent.quote.operationId)
    f.prepare.mockImplementationOnce(() => {
      started.resolve()
      return signed.promise
    })
    const sending = methods.sendStealthPayment.call(f.self, intent)
    await started.promise
    mockWallet = { id: 'messaging-owner-b' }
    mockAccountState.revision++
    signed.resolve(original)
    await sending
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
    // Expired custody cannot prove safe release. The owner remains responsible for the operation.
    expect(f.release).not.toHaveBeenCalled()
    expect(f.expose).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendStealthDialog.messageEnded',
    })
  })

  it('leaves an adopted failed delivery for the outgoing owner and requires a new review rather than preparing again', async () => {
    const f = fixture()
    const intent = await review(f)
    f.self.sendDirectMessage.mockRejectedValueOnce(
      new Error('relay down after adoption'),
    )
    await methods.sendStealthPayment.call(f.self, intent)
    expect(f.self.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(f.release).not.toHaveBeenCalled()
    expect(f.self.stealthReview).toBeNull()
    await methods.sendStealthPayment.call(f.self, intent)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.self.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendStealthDialog.messageEnded',
    })
  })

  it('reports unsupported concrete owner capability instead of falling back to a legacy contact payment', async () => {
    const f = fixture()
    const legacy = jest.fn()
    mockCaptureFinancialWallet.mockResolvedValueOnce({
      wallet: { prepareContactPayment: legacy },
      assertCurrent: async () => undefined,
    })
    await methods.reviewStealthPayment.call(f.self, request)
    expect(f.self.stealthQuote.status).toBe('error')
    expect(f.self.stealthQuote.message).toContain('quoting is unavailable')
    expect(legacy).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.self.sendDirectMessage).not.toHaveBeenCalled()
  })
})

describe('Chat.vue sendFollowUpItems settled callback (#368)', () => {
  it.each([
    ['sent', {}, true],
    [
      'failed',
      { sendDirectMessage: jest.fn().mockRejectedValue(new Error('x')) },
      false,
    ],
    ['dropped (busy)', { sendingMessage: true }, false],
  ])('calls settled exactly once when %s', async (_n, over, expected) => {
    const self = fakeThis(over)
    const settled = jest.fn()
    await methods.sendFollowUpItems.call(self, { items, settled })
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(expected)
  })

  it('calls settled(false) exactly once, and still rejects, when the send itself throws', async () => {
    const boom = new Error('unexpected')
    const self = fakeThis()
    self.sendFollowUpItemsUnsettled = jest.fn().mockRejectedValue(boom)
    const settled = jest.fn()
    await expect(
      methods.sendFollowUpItems.call(self, { items, settled }),
    ).rejects.toBe(boom)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(false)
  })

  it('does not report a purchase as settled while its send is still in flight', async () => {
    let finish!: () => void
    const self = fakeThis({
      sendDirectMessage: jest.fn(
        () =>
          new Promise<unknown>(
            r => (finish = () => r({ state: 'sent', payloadDigest: 'd' })),
          ),
      ),
    })
    const settled = jest.fn()
    const pending = methods.sendFollowUpItems.call(self, { items, settled })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finish()
    await pending
    expect(settled).toHaveBeenCalledWith(true)
  })
})

describe('Chat.vue sendFollowUpItems vs the no-throw send outcome (#269/#270)', () => {
  beforeEach(() => jest.mocked(errorNotify).mockReset())

  it.each([
    [{ state: 'sent', payloadDigest: 'd' }, true],
    // Payment safely pending: the message is stored and delivers on its own.
    [{ state: 'payment-pending' }, true],
    // A failed send stays in the chat (Retry), but it was NOT sent: the bet keeps its unsent-wager
    // record and a purchase does not look settled.
    [{ state: 'failed', reason: 'unreachable' }, false],
    [{ state: 'needs-confirmation', reason: 'unverified' }, false],
    [{ state: 'busy' }, false],
  ] as const)('outcome %j reports %s', async (outcome, expected) => {
    const self = fakeThis({
      sendDirectMessage: jest.fn().mockResolvedValue(outcome),
    })
    const settled = jest.fn()
    await expect(
      methods.sendFollowUpItems.call(self, { items, settled }),
    ).resolves.toBe(expected)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(expected)
  })
})

describe('Chat.vue blackjack challenge', () => {
  const balance = jest.mocked(activeChain.nativeTransfers.getBalance)
  const challengeThis = (over: Record<string, unknown> = {}) => {
    // Challenge methods capture an incrementing preparation token, initialized by Chat.data.
    const self = fakeThis({
      blackjackDialog: true,
      blackjackPreparing: false,
      blackjackPreparationSequence: 0,
      ...over,
    })
    self.sendFollowUpItems = jest.fn().mockResolvedValue(true)
    return self
  }
  beforeEach(() => {
    jest.mocked(errorNotify).mockReset()
    balance.mockReset()
  })

  it('sends a dealer challenge with a commitment, keeps the seed, and pays only the ordinary stamp', async () => {
    balance.mockResolvedValue(HAND_FEE_RESERVE_WEI + 4_000n)
    const self = challengeThis()
    await methods.sendBlackjackChallenge.call(self, {
      role: 'dealer',
      maxBetWei: 1_000n,
    })
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
    const sent = self.sendFollowUpItems.mock.calls[0][0]
    // No stamp override: a challenge carries no money.
    expect(sent.stampValueWei).toBeUndefined()
    const [item] = sent.items
    expect(item).toMatchObject({
      type: 'blackjack-hand',
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '1000',
    })
    // The seed behind the commitment is on this device and never in the message.
    const seed = loadSeed('0xMe', '0xDealer', item.gameId)!
    expect(commitmentOf(seed)).toBe(item.commitment)
    expect(JSON.stringify(item)).not.toContain(seed)
    expect(self.blackjackDialog).toBe(false)
    expect(self.blackjackPreparationSequence).toBe(1)
    expect(self.blackjackPreparing).toBe(false)
  })

  it('sends a player challenge with no commitment and no seed', async () => {
    balance.mockResolvedValue(HAND_FEE_RESERVE_WEI + 1_000n)
    const self = challengeThis()
    await methods.sendBlackjackChallenge.call(self, {
      role: 'player',
      maxBetWei: 1_000n,
    })
    const [item] = self.sendFollowUpItems.mock.calls[0][0].items
    expect(item).toEqual({
      type: 'blackjack-hand',
      gameId: item.gameId,
      action: 'challenge',
      seq: 0,
      role: 'player',
      maxBetWei: '1000',
    })
    expect(loadSeed('0xMe', '0xDealer', item.gameId)).toBeUndefined()
  })

  it.each([
    ['dealer', 1_001n, HAND_FEE_RESERVE_WEI + 4_000n],
    ['player', 1_001n, HAND_FEE_RESERVE_WEI + 1_000n],
    ['dealer', 1n, HAND_FEE_RESERVE_WEI],
  ] as const)(
    'refuses a %s challenge of %s that the balance does not cover, and sends nothing',
    async (role, maxBetWei, spendable) => {
      balance.mockResolvedValue(spendable)
      const self = challengeThis()
      await methods.sendBlackjackChallenge.call(self, { role, maxBetWei })
      expect(self.sendFollowUpItems).not.toHaveBeenCalled()
      expect(errorNotify).toHaveBeenCalled()
    },
  )

  it('sends nothing when the balance cannot be read', async () => {
    balance.mockRejectedValue(new Error('rpc down'))
    const self = challengeThis()
    await methods.sendBlackjackChallenge.call(self, {
      role: 'player',
      maxBetWei: 1n,
    })
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
  })
})

describe('Chat.vue sends a hand message only while it is still the next one', () => {
  const GAME = 'feedfacefeedfacefeedfacefeedface'
  const challenge = {
    outbound: false,
    senderAddress: '0xPeer',
    items: [
      {
        type: 'blackjack-hand',
        gameId: GAME,
        action: 'challenge',
        seq: 0,
        role: 'dealer',
        maxBetWei: '500',
        commitment: 'c'.repeat(64),
      },
    ],
    stampValueWei: 1n,
    payloadDigest: 'challenge',
  }
  // The hand's second message: it names the challenge as the one before it.
  const bet = {
    type: 'blackjack-hand',
    gameId: GAME,
    action: 'bet',
    seq: 1,
    prev: 'challenge',
    commitment: 'b'.repeat(64),
  }
  beforeEach(() => jest.mocked(errorNotify).mockReset())

  it('refuses a deferred hand action after the wallet session changes, without sending from either wallet', async () => {
    let releaseRead!: () => void
    let readStarted!: () => void
    const started = new Promise<void>(resolve => {
      readStarted = resolve
    })
    mockStoredRead = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    mockReadStarted = readStarted
    const originalWallet = mockWallet
    const revision = accountStatus.revision
    const self = fakeThis({ address: '0xPeer', messages: [challenge] })
    const settled = jest.fn()
    try {
      const pending = methods.sendFollowUpItems.call(self, {
        items: [bet],
        stampValueWei: 300n,
        settled,
      })
      await started
      mockWallet = { id: 'wallet-b' }
      ;(accountStatus as { revision: number }).revision++
      releaseRead()
      await expect(pending).resolves.toBe(false)
      expect(self.sendDirectMessage).not.toHaveBeenCalled()
      expect(errorNotify).toHaveBeenCalledWith(
        new Error('chat.sendContextChanged'),
      )
      expect(settled).toHaveBeenCalledWith(false)
      expect(self.sendingMessage).toBe(false)
    } finally {
      releaseRead()
      mockStoredRead = undefined
      mockReadStarted = undefined
      mockWallet = originalWallet
      ;(accountStatus as { revision: number }).revision = revision
    }
  })

  it('sends a bet once: with the bet already in the chat a second click sends nothing', async () => {
    const self = fakeThis({ address: '0xPeer', messages: [challenge] })
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [bet],
        stampValueWei: 300n,
      }),
    ).resolves.toBe(true)
    expect(self.sendDirectMessage).toHaveBeenCalledTimes(1)

    const again = fakeThis({
      address: '0xPeer',
      messages: [
        challenge,
        {
          outbound: true,
          items: [bet],
          stampValueWei: 300n,
          payloadDigest: 'pending:1',
          status: 'error',
        },
      ],
    })
    const settled = jest.fn()
    await expect(
      methods.sendFollowUpItems.call(again, {
        items: [bet],
        stampValueWei: 300n,
        settled,
      }),
    ).resolves.toBe(false)
    expect(again.sendDirectMessage).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledWith(false)
    expect(errorNotify).toHaveBeenCalled()
  })

  it('sends nothing for a move that is not legal in the hand as saved', async () => {
    const self = fakeThis({ address: '0xPeer', messages: [challenge] })
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [
          {
            type: 'blackjack-hand',
            gameId: GAME,
            action: 'stand',
            seq: 1,
            prev: 'challenge',
            link: 'a'.repeat(64),
          },
        ],
      }),
    ).resolves.toBe(false)
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
    // Nor for a message that names another place in the hand than the next one: a second tab
    // that has not seen the latest message builds on a stale one.
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [{ ...bet, prev: 'something older' }],
        stampValueWei: 300n,
      }),
    ).resolves.toBe(false)
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
  })
})

describe('Chat.vue automatic dealer steps', () => {
  const SEED = 'cd'.repeat(32)
  const GAME = '0123456789abcdef0123456789abcdef'
  const PLAYER_SEED = 'ef'.repeat(32)
  const digestOf = (i: number) => `${i}`.padStart(64, 'a')
  const hand = (...fields: [boolean, Record<string, unknown>, bigint][]) =>
    fields.map(([outbound, item, stampValueWei], i) => ({
      outbound,
      senderAddress: outbound ? '0xMe' : '0xPeer',
      items: [{ type: 'blackjack-hand', gameId: GAME, ...item }],
      stampValueWei,
      payloadDigest: digestOf(i),
    }))
  /** The player's bet as the hand's second message. */
  const betItem = {
    action: 'bet',
    seq: 1,
    prev: digestOf(0),
    commitment: commitmentOf(PLAYER_SEED),
  }
  const challenge: [boolean, Record<string, unknown>, bigint] = [
    true,
    {
      action: 'challenge',
      seq: 0,
      role: 'dealer',
      maxBetWei: '500',
      commitment: commitmentOf(SEED),
    },
    1n,
  ]
  const dealerThis = (
    messages: unknown[],
    over: Record<string, unknown> = {},
  ) => {
    const self = fakeThis({
      address: '0xPeer',
      messages,
      blackjackAttempted: new Set<string>(),
      ...over,
    })
    self.sendFollowUpItems = jest.fn().mockResolvedValue(true)
    return self
  }
  beforeAll(() => saveSeed('0xMe', '0xPeer', GAME, SEED))

  it('deals as soon as the bet is in, once', async () => {
    const self = dealerThis(hand(challenge, [false, betItem, 300n]))
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
    const sent = self.sendFollowUpItems.mock.calls[0][0]
    expect(sent.items[0].action).toBe('deal')
    expect(sent.stampValueWei).toBeUndefined()
    // The same position is never attempted twice, even if the send left no message behind.
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
  })

  it("does not take a bet posted into the chat by someone else for the peer's move", async () => {
    const messages = hand(challenge, [false, betItem, 300n])
    messages[1].senderAddress = '0xSomeoneElse'
    const self = dealerThis(messages)
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
  })

  it('on opening the chat, sends a deal that was cut off again instead of leaving the hand stuck', async () => {
    const bet = hand(challenge, [false, betItem, 300n])
    const step = dealerStep(
      foldHand(
        bet.map(m => ({
          item: m.items[0] as never,
          from: m.outbound ? '0xMe' : '0xPeer',
          to: m.outbound ? '0xPeer' : '0xMe',
          stampWei: m.stampValueWei,
          digest: m.payloadDigest,
        })),
      ).state,
      SEED,
    )
    // What a reload leaves of a deal whose send the closing window cut off.
    const messages = [
      ...bet.map(m => ({ ...m, status: 'confirmed' })),
      {
        outbound: true,
        status: 'error',
        delivery: { failureReason: 'interrupted' },
        items: [step?.item],
        stampValueWei: 1n,
        payloadDigest: 'pending:1:1:',
      },
    ]
    const chatStore = {
      retryOutgoing: jest.fn().mockResolvedValue({ state: 'sent' }),
      resumeOutgoing: jest.fn(),
    }
    const self = dealerThis(messages, { chatStore })
    self.runBlackjackDealer = () => methods.runBlackjackDealer.call(self)
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    await methods.runBlackjackDealer.call(self)
    await new Promise(resolve => setTimeout(resolve, 0))
    info.mockRestore()
    expect(chatStore.retryOutgoing).toHaveBeenCalledTimes(1)
    expect(chatStore.retryOutgoing).toHaveBeenCalledWith({
      wallet: mockWallet,
      address: '0xPeer',
      payloadDigest: 'pending:1:1:',
      automatic: true,
    })
    // The cut-off deal is the hand's deal: no second one is built.
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    expect(chatStore.resumeOutgoing).not.toHaveBeenCalled()
  })

  it.each([0n, 1n])(
    'recovers an existing hand stamp %s while the default quote is unavailable',
    async stampValueWei => {
      const bet = hand(challenge, [false, betItem, 300n])
      const step = dealerStep(
        foldHand(
          bet.map(m => ({
            item: m.items[0] as never,
            from: m.outbound ? '0xMe' : '0xPeer',
            to: m.outbound ? '0xPeer' : '0xMe',
            stampWei: m.stampValueWei,
            digest: m.payloadDigest,
          })),
        ).state,
        SEED,
      )
      const messages = [
        ...bet.map(m => ({ ...m, status: 'confirmed' })),
        {
          outbound: true,
          status: 'error',
          delivery: {
            failureReason: 'interrupted',
            ...(stampValueWei > 0n
              ? { attemptDigest: 'original-attempt' }
              : {}),
          },
          items: [step?.item],
          stampValueWei,
          payloadDigest: 'pending:offline',
        },
      ]
      const chatStore = {
        retryOutgoing: jest.fn().mockResolvedValue({ state: 'sent' }),
        resumeOutgoing: jest.fn().mockResolvedValue({ state: 'sent' }),
      }
      const self = dealerThis(messages, {
        chatStore,
        stampAmount: '',
        stampUnavailable: 'localized missing rate',
      })
      self.runBlackjackDealer = () => methods.runBlackjackDealer.call(self)
      const info = jest
        .spyOn(console, 'info')
        .mockImplementation(() => undefined)
      try {
        await methods.runBlackjackDealer.call(self)
        await new Promise(resolve => setTimeout(resolve, 0))
        const selected =
          stampValueWei > 0n
            ? chatStore.resumeOutgoing
            : chatStore.retryOutgoing
        const other =
          stampValueWei > 0n
            ? chatStore.retryOutgoing
            : chatStore.resumeOutgoing
        expect(selected).toHaveBeenCalledWith({
          wallet: mockWallet,
          address: '0xPeer',
          payloadDigest: 'pending:offline',
          ...(stampValueWei === 0n ? { automatic: true } : {}),
        })
        expect(selected).toHaveBeenCalledTimes(1)
        expect(other).not.toHaveBeenCalled()
        expect(self.sendFollowUpItems).not.toHaveBeenCalled()
      } finally {
        info.mockRestore()
      }
    },
  )

  it('while a message is being resumed no other trigger sends a step, and the hand waits until it is delivered', async () => {
    // An own failed message of the hand that the fold does not advance on (a dealer cannot
    // stand): the deal is still the hand's next step, so only the resume guard and the
    // undelivered-message rule keep it from going out ahead of the resumed message.
    const messages = [
      ...hand(challenge, [false, betItem, 300n]).map(m => ({
        ...m,
        status: 'confirmed',
      })),
      {
        outbound: true,
        status: 'error',
        delivery: { failureReason: 'interrupted' },
        items: [{ type: 'blackjack-hand', gameId: GAME, action: 'stand' }],
        stampValueWei: 1n,
        payloadDigest: 'pending:2:1:',
      },
    ]
    let finish: (outcome: { state: string }) => void = () => undefined
    const chatStore = {
      retryOutgoing: jest.fn(
        () =>
          new Promise<{ state: string }>(resolve => {
            finish = resolve
          }),
      ),
      resumeOutgoing: jest.fn(),
    }
    const self = dealerThis(messages, { chatStore, resumingHand: false })
    self.runBlackjackDealer = () => methods.runBlackjackDealer.call(self)
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    const first = methods.runBlackjackDealer.call(self)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chatStore.retryOutgoing).toHaveBeenCalledTimes(1)
    expect(self.resumingHand).toBe(true)
    // A watcher fires meanwhile (a message arrived, a send finished).
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    // The resume ends with the message still not delivered (e.g. its payment is pending).
    finish({ state: 'payment-pending' })
    await first
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(self.resumingHand).toBe(false)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    // Once it is delivered the hand moves on.
    messages[messages.length - 1].status = 'confirmed'
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
    expect(self.sendFollowUpItems.mock.calls[0][0].items[0].action).toBe('deal')
    expect(chatStore.retryOutgoing).toHaveBeenCalledTimes(1)
    info.mockRestore()
  })

  it('does not send while another message is being sent', async () => {
    const self = dealerThis(hand(challenge, [false, betItem, 300n]), {
      sendingMessage: true,
    })
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
  })

  it('never pays without the dealer: a refund and a paying reveal wait for a button', async () => {
    // A bet above the max is owed back.
    const refundOwed = dealerThis(hand(challenge, [false, betItem, 501n]))
    await methods.runBlackjackDealer.call(refundOwed)
    expect(refundOwed.sendFollowUpItems).not.toHaveBeenCalled()

    // Play a hand to the reveal; if the player is owed anything the reveal is not automatic.
    const events = [
      {
        item: { type: 'blackjack-hand', gameId: GAME, ...challenge[1] },
        from: '0xMe',
        to: '0xPeer',
        stampWei: 1n,
        digest: digestOf(0),
      },
      {
        item: { type: 'blackjack-hand', gameId: GAME, ...betItem },
        from: '0xPeer',
        to: '0xMe',
        stampWei: 300n,
        digest: 'b',
      },
    ] as Parameters<typeof foldHand>[0]
    const rows: [boolean, Record<string, unknown>, bigint][] = [
      challenge,
      [false, betItem, 300n],
    ]
    for (;;) {
      const state = foldHand(events).state
      const step = dealerStep(state, SEED)
      if (!step && state?.phase === 'player_turn') {
        const stand = playerStep(state, 'stand', PLAYER_SEED)!
        events.push({
          item: stand,
          from: '0xPeer',
          to: '0xMe',
          stampWei: 1n,
          digest: 's',
        })
        rows.push([false, stand as unknown as Record<string, unknown>, 1n])
        continue
      }
      if (!step || step.item.action === 'reveal') break
      events.push({
        item: step.item,
        from: '0xMe',
        to: '0xPeer',
        stampWei: 1n,
        digest: `d${events.length}`,
      })
      rows.push([true, step.item as unknown as Record<string, unknown>, 1n])
    }
    // The digests must match those the events used.
    const messages = rows.map(([outbound, item, stampValueWei], i) => ({
      outbound,
      senderAddress: outbound ? '0xMe' : '0xPeer',
      items: [{ type: 'blackjack-hand', gameId: GAME, ...item }],
      stampValueWei,
      payloadDigest: events[i].digest,
    }))
    const reveal = dealerStep(foldHand(events).state, SEED)!
    expect(reveal.item.action).toBe('reveal')
    const self = dealerThis(messages)
    await methods.runBlackjackDealer.call(self)
    if (reveal.payWei === undefined) {
      expect(self.sendFollowUpItems.mock.calls[0][0].items[0].action).toBe(
        'reveal',
      )
    } else {
      expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    }
  })
})

describe("Chat.vue: the conversation's stamp is the user's own choice", () => {
  // The harness's chain: 1 display unit is 1e18 base units, the default stamp is 1 base unit.
  function stampThis(chosen?: bigint) {
    const chatStore = {
      getStampWei: jest.fn(() => chosen),
      setStampWei: jest.fn(),
    }
    return {
      defaultStampWei: 1n,
      conversation: { id: 'conv-1' },
      recipientAddress: '0xPeer',
      chatStore,
    }
  }

  it('accepts 0: the conversation sends free messages', () => {
    const self = stampThis()
    computed.stampAmount.set.call(self, '0')
    expect(self.chatStore.setStampWei).toHaveBeenCalledWith({
      address: 'conv-1',
      stampWei: 0n,
    })
  })

  it('keeps an amount below the default instead of raising it', () => {
    const self = stampThis()
    computed.stampAmount.set.call(self, '0.000000000000000000')
    expect(self.chatStore.setStampWei).toHaveBeenCalledWith({
      address: 'conv-1',
      stampWei: 0n,
    })
  })

  it('leaves the choice alone while the box holds no amount, and refuses a negative one', () => {
    const self = stampThis()
    computed.stampAmount.set.call(self, null)
    computed.stampAmount.set.call(self, 'abc')
    computed.stampAmount.set.call(self, '-1')
    expect(self.chatStore.setStampWei).not.toHaveBeenCalled()
  })

  it('shows the chosen amount, and a follow-up message with no price of its own carries it', async () => {
    const self = fakeThis()
    Object.assign(self, stampThis(0n))
    Object.defineProperty(self, 'stampAmount', {
      get: () => computed.stampAmount.get.call(self),
    })
    expect(self.stampAmount).toBe('0')
    await methods.sendFollowUpItems.call(self, {
      items: [{ type: 'text', text: 'hello' }],
    })
    expect(self.sendDirectMessage.mock.calls[0][0].stampValue).toBe(0n)
  })

  it('a free game move (a price of 0) carries no stamp whatever the chat is set to', async () => {
    const self = fakeThis({ stampAmount: '0.01' })
    await methods.sendFollowUpItems.call(self, {
      items: [{ type: 'rps', action: 'move' }],
      stampValueWei: 0n,
    })
    expect(self.sendDirectMessage.mock.calls[0][0].stampValue).toBe(0n)
  })

  it('pins chat scroll to bottom when visualViewport resizes while near bottom or focusing composer', () => {
    const pinScrollToBottom = jest.fn()
    const resizeHandler = jest.fn()
    const self = fakeThis({
      bottom: false,
      followBottom: false,
      hasComposeFocus: () => true,
      pinScrollToBottom,
      resizeHandler,
      $nextTick: (cb: () => void) => cb(),
    })
    methods.onVisualViewportResize.call(self)
    expect(resizeHandler).toHaveBeenCalledTimes(1)
    expect(pinScrollToBottom).toHaveBeenCalledTimes(2)
  })
})

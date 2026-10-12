/** @jest-environment jsdom */

import { shallowMount, flushPromises } from '@vue/test-utils'

import ChatMessage from './ChatMessage.vue'
import ChatMessageStealthAsset from './ChatMessageStealthAsset.vue'
import { accountSession } from '../../../accounts/session'
import enUS from '../../../i18n/en-us'
import { useActiveWallet } from '../../../composables/useActiveWallet'
import { useMonadWallet } from '../../../utils/clients'

const retryOutgoing = jest.fn()
const deleteMessage = jest.fn(async () => undefined)
jest.mock('../../../stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage,
    getStampAmount: () => 0,
    sendMessage: jest.fn(),
    retryOutgoing,
  }),
}))
// The real dialogs pull in modules that open on-disk Level stores at import time.
jest.mock('../../dialogs/DeleteMessageDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../../dialogs/TransactionDialog.vue', () => ({ template: '<i />' }))
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: jest.fn(() => {
    throw new Error('Forbidden messaging wallet activation')
  }),
}))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() => {
    throw new Error('Forbidden legacy wallet activation')
  }),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    chainIdentifier: 'monad-testnet',
    name: 'Monad',
    toDisplayAmount: () => '0',
    unit: 'MON',
    fromDisplayAmount: () => 10n ** 18n,
  },
}))
jest.mock('../../../utils/message-items', () => ({
  messageItems: { previewText: () => '' },
}))
jest.mock('../../../utils/message-item-renderers', () => ({
  getMessageItemRenderer: () => undefined,
}))

const t = (key: string, params: Record<string, unknown> = {}) => {
  const text = key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      enUS,
    ) as string
  return text?.replace(/\{([^}]+)\}/g, (_, key: string) =>
    String(params[key] ?? `{${key}}`),
  )
}

jest.mock('../../../accounts/session', () => ({
  accountStatus: { revision: 1 },
  accountSession: {
    state: {
      status: 'ready',
      revision: 1,
      account: { receipt: { context: { accountId: 'alice' } } },
    },
    peekWallet: jest.fn(),
    getCachedCurvePublicKey: jest.fn(),
    getWallet: jest.fn(() => {
      throw new Error('Forbidden wallet activation')
    }),
    getCurvePublicKey: jest.fn(() => {
      throw new Error('Forbidden key derivation')
    }),
  },
}))
jest.mock('../../../accounts/utxo-wallets', () => ({
  peekOpenedUtxoWallets: () => [],
  openUtxoWallet: jest.fn(() => {
    throw new Error('Forbidden secondary activation')
  }),
}))

const publicKey = `02${'11'.repeat(32)}`
const digest = 'cd'.repeat(32)
const payment = {
  type: 'stealth-asset',
  memo: 'Lunch',
  transfers: [
    {
      chainIdentifier: 'monad-testnet',
      amountAtomic: '1000000000000000000',
      txId: 'ab'.repeat(32),
      destination: '12'.repeat(20),
      asset: { kind: 'native' },
      stealthMetadata: { keyType: 1, ephemeralPubKey: publicKey },
      recipientSpendKey: { keyType: 1, publicKey },
      derivationScheme: 1,
      rawTx: '010203',
    },
  ],
}
const observe = jest.fn(async () => ({
  payloadDigest: digest,
  status: 'succeeded',
  intendedAmountAtomic: 10n ** 18n,
  verifiedReceivedAmountAtomic: 10n ** 18n,
  spendability: 'spendable',
}))
const record = jest.fn(),
  submit = jest.fn()
const owner = {
  chainIdentifier: 'monad-testnet',
  stealthReceipts: { observe, record, submit },
}
function render(outbound = false, status = 'confirmed') {
  return shallowMount(ChatMessage, {
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 500,
      payloadDigest: digest,
      message: {
        outbound,
        status,
        receivedTime: 1,
        serverTime: 1,
        items: [payment],
        outpoints: [],
        senderAddress: '0xME',
        stampValueWei: 0n,
      } as never,
    },
    global: {
      provide: { _q_: { dark: { isActive: false } } },
      stubs: {
        ChatMessageStealthAsset: false,
        QChatMessage: { template: '<div><slot /></div>' },
        QCard: { template: '<div><slot /></div>' },
        QBadge: { template: '<span><slot /></span>' },
      },
      mocks: { $t: t, $q: {} },
    },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  accountSession.state.revision = 1
  jest.mocked(accountSession.peekWallet).mockReturnValue(owner as never)
  jest
    .mocked(accountSession.getCachedCurvePublicKey)
    .mockReturnValue(Uint8Array.from(Buffer.from(publicKey, 'hex')))
})

test('actual ChatMessage registration observes incoming receipts through cache-only host composition', async () => {
  const wrapper = render()
  await flushPromises()
  expect(wrapper.findComponent(ChatMessageStealthAsset).exists()).toBe(true)
  expect(observe).toHaveBeenCalledTimes(1)
  expect(observe).toHaveBeenCalledWith(
    expect.objectContaining({
      payloadDigest: digest,
      amountAtomic: 10n ** 18n,
    }),
  )
  expect(wrapper.get('[data-testid="asset-verified"]').text()).toContain(
    '1 MON',
  )
  expect(record).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(useActiveWallet).not.toHaveBeenCalled()
  expect(useMonadWallet).not.toHaveBeenCalled()
  expect(accountSession.getWallet).not.toHaveBeenCalled()
  expect(accountSession.getCurvePublicKey).not.toHaveBeenCalled()
  wrapper.unmount()
})

test('incoming messages without cached custody identity stay unavailable without opening it', async () => {
  jest.mocked(accountSession.getCachedCurvePublicKey).mockReturnValue(undefined)
  const wrapper = render()
  await flushPromises()
  expect(observe).not.toHaveBeenCalled()
  expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="asset-status"]').text()).toBe(
    t('chatMessageStealthAsset.unavailable'),
  )
  expect(useActiveWallet).not.toHaveBeenCalled()
  expect(useMonadWallet).not.toHaveBeenCalled()
  expect(accountSession.getWallet).not.toHaveBeenCalled()
  expect(accountSession.getCurvePublicKey).not.toHaveBeenCalled()
  wrapper.unmount()
})

test.each([
  ['confirmed', 'delivered'],
  ['error', 'failed'],
  ['pending', 'pending'],
  ['payment-pending', 'unknown'],
])(
  'outgoing %s uses delivery label %s and never observes or claims settlement',
  async (status, expected) => {
    const wrapper = render(true, status)
    await flushPromises()
    const asset = wrapper.findComponent(ChatMessageStealthAsset)
    expect(asset.props('outboundState')).toBe(expected)
    expect(asset.props('observationContext')).toBeUndefined()
    expect(observe).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
    expect(useActiveWallet).not.toHaveBeenCalled()
    expect(useMonadWallet).not.toHaveBeenCalled()
    expect(accountSession.getWallet).not.toHaveBeenCalled()
    wrapper.unmount()
  },
)

test('an incoming observation completing after account revision changes cannot display old financial evidence', async () => {
  let complete!: (value: Awaited<ReturnType<typeof observe>>) => void
  observe.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve
      }),
  )
  const wrapper = render()
  await flushPromises()
  accountSession.state.revision++
  complete({
    payloadDigest: digest,
    status: 'succeeded',
    intendedAmountAtomic: 10n ** 18n,
    verifiedReceivedAmountAtomic: 10n ** 18n,
    spendability: 'spendable',
  })
  await flushPromises()
  expect(wrapper.find('[data-testid="asset-verified"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="asset-status"]').text()).toBe(
    t('chatMessageStealthAsset.unavailable'),
  )
  expect(useActiveWallet).not.toHaveBeenCalled()
  expect(useMonadWallet).not.toHaveBeenCalled()
  wrapper.unmount()
})

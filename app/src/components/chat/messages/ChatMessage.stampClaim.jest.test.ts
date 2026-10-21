/** @jest-environment jsdom */

/**
 * A received stamp is the payer's signed transfer. The bubble labels its amount as claimed until
 * the messaging wallet saw it arrive on chain (review finding A7).
 */
import { shallowMount } from '@vue/test-utils'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'
import { RECEIVED_PAYMENT_RECHECK_MS } from '../../../composables/useReceivedPayment'

jest.mock('../../../stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage: jest.fn(async () => undefined),
    getStampAmount: () => 0,
    sendMessage: jest.fn(),
    retryOutgoing: jest.fn(),
  }),
}))
jest.mock('../../dialogs/DeleteMessageDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../../dialogs/TransactionDialog.vue', () => ({ template: '<i />' }))
let mockStampStatus = 'pending'
const mockRead = jest.fn((_digest: string) => ({
  stampStatus: mockStampStatus,
}))
const mockRefresh = jest.fn(async () => [])
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({
    getMessagePayment: mockRead,
    refreshReceivedPayments: mockRefresh,
  }),
}))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { toDisplayAmount: () => '0.01', unit: 'MON' },
}))
jest.mock('../../../utils/message-items', () => ({
  messageItems: { previewText: () => '' },
}))
jest.mock('../../../utils/message-item-renderers', () => ({
  getMessageItemRenderer: () => undefined,
}))

const t = (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      enUS,
    ) as string

function mountStamp(outbound: boolean, digest = 'ab'.repeat(32)) {
  return shallowMount(ChatMessage, {
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 500,
      payloadDigest: digest,
      message: {
        outbound,
        status: 'confirmed',
        receivedTime: 1,
        serverTime: 1,
        items: [{ type: 'text', text: 'hi' }],
        outpoints: [],
        senderAddress: outbound ? '0xME' : '0xPEER',
        stampValueWei: 10n ** 16n,
      },
    },
    global: { mocks: { $t: t } },
  })
}
const shown = (wrapper: ReturnType<typeof mountStamp>) =>
  (wrapper.vm as unknown as { stampAmount: string }).stampAmount

/** One shared tick: the wallet's own read, then every waiting bubble reads from memory. */
async function tick() {
  jest.advanceTimersByTime(RECEIVED_PAYMENT_RECHECK_MS)
  // The wallet's read resolves, then the bubbles read again: let that run out.
  for (let i = 0; i < 5; i += 1)
    await new Promise(resolve => process.nextTick(resolve))
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] })
  mockRead.mockClear()
  mockRefresh.mockClear()
})
afterEach(async () => {
  // Let any tick still scheduled run with nobody waiting, so tests stay independent.
  await tick()
  jest.useRealTimers()
})

it('labels a received stamp as claimed until the chain shows it', async () => {
  mockStampStatus = 'pending'
  const wrapper = mountStamp(false)
  expect(shown(wrapper)).toBe('0.01 MON (claimed)')
  expect(mockRead).toHaveBeenCalledWith('ab'.repeat(32))
  expect(mockRefresh).not.toHaveBeenCalled()
  mockStampStatus = 'received'
  await tick()
  expect(mockRefresh).toHaveBeenCalledTimes(1)
  expect(shown(wrapper)).toBe('0.01 MON')
  // Settled: nothing more is read.
  await tick()
  expect(mockRefresh).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('shows a settled stamp without the label from the first render, from memory', () => {
  mockStampStatus = 'received'
  const wrapper = mountStamp(false)
  expect(shown(wrapper)).toBe('0.01 MON')
  wrapper.unmount()
})

it('stops reading when the wallet holds no coin for the stamp', async () => {
  mockStampStatus = 'none'
  const wrapper = mountStamp(false)
  expect(shown(wrapper)).toBe('0.01 MON (claimed)')
  await tick()
  await tick()
  expect(mockRefresh).not.toHaveBeenCalled()
  expect(mockRead).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('serves every waiting bubble with one wallet read per tick', async () => {
  mockStampStatus = 'pending'
  const bubbles = ['01', '02', '03', '04', '05'].map(d =>
    mountStamp(false, d.repeat(32)),
  )
  await tick()
  await tick()
  expect(mockRefresh).toHaveBeenCalledTimes(2)
  bubbles.forEach(b => b.unmount())
  await tick()
  expect(mockRefresh).toHaveBeenCalledTimes(2)
})

it('never labels or reads a stamp we paid', () => {
  mockStampStatus = 'pending'
  const wrapper = mountStamp(true)
  expect(shown(wrapper)).toBe('0.01 MON')
  expect(mockRead).not.toHaveBeenCalled()
  wrapper.unmount()
})

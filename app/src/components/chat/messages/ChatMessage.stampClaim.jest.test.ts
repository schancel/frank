/** @jest-environment jsdom */

/**
 * A received stamp is the payer's signed transfer. The bubble labels its amount as claimed until
 * the messaging wallet saw it arrive on chain (review finding A7).
 */
import { flushPromises, shallowMount } from '@vue/test-utils'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'

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
const mockCheck = jest.fn(async (_digest: string) => ({
  stampStatus: mockStampStatus,
}))
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({ checkMessagePayment: mockCheck }),
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

async function stampShown(outbound: boolean): Promise<string> {
  const wrapper = shallowMount(ChatMessage, {
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 500,
      payloadDigest: 'ab'.repeat(32),
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
  await flushPromises()
  const shown = (wrapper.vm as unknown as { stampAmount: string }).stampAmount
  wrapper.unmount()
  return shown
}

beforeEach(() => mockCheck.mockClear())

it('labels a received stamp as claimed until the chain shows it', async () => {
  mockStampStatus = 'pending'
  expect(await stampShown(false)).toBe('0.01 MON (claimed)')
  expect(mockCheck).toHaveBeenCalledWith('ab'.repeat(32))
})

it('shows a settled received stamp without the label', async () => {
  mockStampStatus = 'received'
  expect(await stampShown(false)).toBe('0.01 MON')
})

it('never labels a stamp we paid', async () => {
  mockStampStatus = 'pending'
  expect(await stampShown(true)).toBe('0.01 MON')
  expect(mockCheck).not.toHaveBeenCalled()
})

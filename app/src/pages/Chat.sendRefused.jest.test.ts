/** @jest-environment jsdom */
// A send refused before anything is created must leave the typed text in the composer and tell
// the user the real reason, not the generic "something went wrong".

const mockUseMonadWallet = jest.fn()
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))
jest.mock('../utils/clients', () => ({
  useMonadWallet: () => mockUseMonadWallet(),
}))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    fromDisplayAmount: (s: string) => BigInt(Math.round(Number(s) * 1e18)),
    unit: 'MON',
    defaultStampValue: 1n,
    toDisplayAmount: (n: bigint) => n.toString(),
  },
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

import ChatPage from './Chat.vue'
import { errorNotify } from '../utils/notifications'
import { SendRefusedError } from '../utils/send-refusal'
import enUS from '../i18n/en-us'
import frFR from '../i18n/fr-fr'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const methods = (ChatPage as unknown as { methods: Record<string, any> })
  .methods

function fakeThis(over: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const self: Record<string, any> = {
    address: '0xPeer',
    sendingMessage: false,
    bottom: true,
    message: 'my typed text',
    replyDigest: 'reply-1',
    stampAmount: '0.01',
    stampPreparationStatus: null,
    $t: (key: string) => key,
    getAcceptancePrice: () => 0,
    showStampPreparation: jest.fn(),
    sendDirectMessage: jest
      .fn()
      .mockResolvedValue({ state: 'sent', payloadDigest: 'd' }),
    $nextTick: jest.fn(),
    buttonScrollBottom: jest.fn(),
    ...over,
  }
  return self
}

describe('Chat.vue keeps the text and gives the reason when a send is refused', () => {
  beforeEach(() => {
    jest.mocked(errorNotify).mockReset()
    mockUseMonadWallet.mockReset().mockReturnValue({})
  })

  it('messaging pending: nothing is sent, the text stays, the real reason is shown', async () => {
    mockUseMonadWallet.mockImplementation(() => {
      throw new SendRefusedError('messaging-pending', 'pending')
    })
    const self = fakeThis()
    await methods.sendMessage.call(self, 'my typed text')
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
    expect(self.message).toBe('my typed text')
    expect(self.replyDigest).toBe('reply-1')
    expect(self.sendingMessage).toBe(false)
    expect(errorNotify).toHaveBeenCalledTimes(1)
    expect(errorNotify).toHaveBeenCalledWith(expect.any(SendRefusedError), {
      fallbackKey: 'chat.sendRefusedMessagingPending',
    })
  })

  it('refused by the store before a message exists (too long): the text is given back', async () => {
    const self = fakeThis({
      sendDirectMessage: jest
        .fn()
        .mockRejectedValue(new SendRefusedError('too-large', 'too long')),
    })
    await methods.sendMessage.call(self, 'my typed text')
    expect(self.message).toBe('my typed text')
    expect(self.replyDigest).toBe('reply-1')
    expect(self.sendingMessage).toBe(false)
    expect(errorNotify).toHaveBeenCalledWith(expect.any(SendRefusedError), {
      fallbackKey: 'chat.sendRefusedTooLarge',
    })
  })

  it('a send that created a message still clears the composer', async () => {
    const self = fakeThis()
    await methods.sendMessage.call(self, 'my typed text')
    expect(self.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(self.message).toBe('')
    expect(self.replyDigest).toBeNull()
    expect(errorNotify).not.toHaveBeenCalled()
  })

  it('an unclassified error keeps the generic message and does not restore the text', async () => {
    const self = fakeThis({
      sendDirectMessage: jest.fn().mockRejectedValue(new Error('relay dump')),
    })
    await methods.sendMessage.call(self, 'my typed text')
    expect(self.message).toBe('')
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {})
  })

  it('a follow-up (button) send refused for pending messaging shows the reason', async () => {
    mockUseMonadWallet.mockImplementation(() => {
      throw new SendRefusedError('messaging-pending', 'pending')
    })
    const self = fakeThis()
    await expect(
      methods.sendFollowUpItemsUnsettled.call(self, {
        items: [{ type: 'text', text: 'x' }],
      }),
    ).resolves.toBe(false)
    expect(errorNotify).toHaveBeenCalledWith(expect.any(SendRefusedError), {
      fallbackKey: 'chat.sendRefusedMessagingPending',
    })
  })

  it('has the refusal reasons in English and French', () => {
    expect(enUS.chat.sendRefusedMessagingPending).toContain(
      'Settings > Networking',
    )
    expect(frFR.chat.sendRefusedMessagingPending).toContain(
      'Paramètres > Réseau',
    )
    expect(enUS.chat.sendRefusedTooLarge).toBeTruthy()
    expect(frFR.chat.sendRefusedTooLarge).toBeTruthy()
  })
})

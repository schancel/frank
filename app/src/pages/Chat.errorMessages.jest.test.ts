/** @jest-environment jsdom */
// errorNotify shows app-authored text only through `safeMessage`: a send refused for an
// insufficient balance names the shortfall, a provider failure stays the generic message.

const createNotification = jest.fn()
jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  Notify: { create: createNotification },
  openURL: jest.fn(),
}))
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('../utils/messaging-state', () => ({
  messagingState: { status: 'ready' },
}))
jest.mock('../accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('@frank/wallet/chain', () => {
  const { formatEther, parseEther } = jest.requireActual('ethers')
  const chain = {
    activeChain: {
      fromDisplayAmount: (s: string) => parseEther(s),
      toDisplayAmount: (n: bigint) => formatEther(n),
      unit: 'MONT',
    },
  }
  return { ...chain, getActiveChain: () => chain.activeChain }
})
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => '0xMe',
  sameCanonicalAddress: (a: string, b: string) => a === b,
  useReactiveOwnCanonicalAddress: () => ({ value: '0xMe' }),
}))

import ChatPage from './Chat.vue'
import RpsChallengeForm from '../components/chat/RpsChallengeForm.vue'
import { errorNotify } from '../utils/notifications'
import enUS from '../i18n/en-us'

const GENERIC = 'Something went wrong. Please try again.'
const page = ChatPage as unknown as { methods: Record<string, any> }
const rpsForm = RpsChallengeForm as unknown as { methods: Record<string, any> }

const $t = (key: string, params: Record<string, unknown> = {}) => {
  const text = key
    .split('.')
    .reduce<any>((node, part) => node?.[part], enUS) as string
  return text.replace(/\{(\w+)\}/g, (_m, name) => String(params[name]))
}

describe('error notifications show app-authored messages', () => {
  beforeEach(() => {
    createNotification.mockReset()
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it('Chat send names the shortfall when the stamp exceeds the balance', async () => {
    const self = {
      $t,
      stampUnavailable: '',
      conversation: undefined,
      recipientAddress: '0xPeer',
      address: '0xPeer',
      stampAmount: '500',
      isDefaultStampMode: true,
      availableBalanceWei: 197_000_000_000_000_000_000n,
    }
    await page.methods.sendMessage.call(self, 'hello')
    expect(createNotification).toHaveBeenCalledTimes(1)
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Not enough MONT: need 500 MONT, have 197 MONT',
      }),
    )
  })

  it('reads the shortfall rounded so it never understates it: need up, have down', async () => {
    const self = {
      $t,
      stampUnavailable: '',
      conversation: undefined,
      recipientAddress: '0xPeer',
      address: '0xPeer',
      stampAmount: '0.501499526965636987',
      isDefaultStampMode: true,
      availableBalanceWei: 139_404_169_000_000_000n,
    }
    await page.methods.sendMessage.call(self, 'hello')
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Not enough MONT: need 0.5015 MONT, have 0.1394 MONT',
      }),
    )
  })

  it('a game card shows its stake error', () => {
    rpsForm.methods.submit.call({
      busy: false,
      wagerWei: undefined,
      stakeError: 'Stake is below the minimum',
    })
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Stake is below the minimum' }),
    )
  })

  it('a provider error stays the generic message', () => {
    errorNotify(new Error('execution reverted: 0xdeadbeef provider dump'))
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: GENERIC }),
    )
  })
})

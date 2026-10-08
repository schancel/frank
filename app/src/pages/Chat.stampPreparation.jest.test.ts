/** @jest-environment jsdom */
// The stamp-account preparation status line of a send (ticket #274): its three stages come from
// the locale files, in both locales, and are shared by every way a send can prepare accounts.

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => `${n} wei`,
  },
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

import { messages } from 'src/i18n'
import ChatPage from './Chat.vue'

const methods = (ChatPage as unknown as { methods: Record<string, any> })
  .methods

function statusFor(locale: 'en-us' | 'fr-fr', progress: unknown): string {
  const table = messages[locale]
  const self: Record<string, any> = {
    stampPreparationStatus: null,
    $t: (key: string, params: Record<string, unknown> = {}) =>
      String(
        key.split('.').reduce<any>((node, part) => node?.[part], table),
      ).replace(/\{(\w+)\}/g, (_m, name) => String(params[name])),
  }
  methods.showStampPreparation.call(self, progress)
  return self.stampPreparationStatus
}

describe('Chat.vue stamp preparation status', () => {
  const stages = [
    { stage: 'checking' },
    {
      stage: 'funding',
      completed: 1,
      total: 2,
      feeReserveWei: 7n,
    },
    { stage: 'ready', fundingTxHashes: [] },
  ]

  it('only displays banner when funding stage is in-flight in en-us', () => {
    expect(stages.map(p => statusFor('en-us', p))).toEqual([
      null,
      'Preparing private stamp accounts (1/2 on-chain transactions; up to 7 wei MON fee reserve each)…',
      null,
    ])
  })

  it('is French in fr-fr for funding stage, with every placeholder filled, and null otherwise', () => {
    const texts = stages.map(p => statusFor('fr-fr', p))
    expect(texts[0]).toBeNull()
    expect(texts[1]).toContain('1/2')
    expect(texts[1]).toContain('7 wei MON')
    expect(texts[1]).not.toMatch(/[{}]|undefined/)
    expect(texts[1]).not.toMatch(/private|stamp|sending|Checking|Preparing/)
    expect(texts[2]).toBeNull()
  })
})

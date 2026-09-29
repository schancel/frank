/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'

import Receive from './Receive.vue'

const mockGetBalance = jest.fn()

jest.mock('vue-router', () => ({
  useRouter: () => ({ go: jest.fn(), push: jest.fn() }),
}))
jest.mock('qrcode.vue', () => ({ template: '<div />' }))
jest.mock('quasar', () => ({ copyToClipboard: jest.fn() }))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (amount: bigint) => amount.toString(),
    nativeTransfers: {
      getBalance: (...args: unknown[]) => mockGetBalance(...args),
    },
  },
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({
    identity: { displayAddress: '0xabc' },
  })),
}))

async function advance(ms: number) {
  jest.advanceTimersByTime(ms)
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('Receive balance', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    mockGetBalance.mockReset()
  })
  afterEach(() => jest.useRealTimers())

  it('shows an updated balance without a reload', async () => {
    mockGetBalance.mockResolvedValueOnce(1n).mockResolvedValue(4n)
    const wrapper = shallowMount(Receive, {
      global: {
        mocks: { $t: (key: string) => key },
        stubs: Object.fromEntries(
          ['q-page-container', 'q-page', 'q-card', 'q-card-section'].map(n => [
            n,
            { template: '<div><slot /></div>' },
          ]),
        ),
      },
    })
    await advance(0)
    expect(wrapper.text()).toContain('1 MON')
    await advance(15000)
    expect(wrapper.text()).toContain('4 MON')
    wrapper.unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})

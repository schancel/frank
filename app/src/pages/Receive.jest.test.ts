/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'

import Receive from './Receive.vue'
import enUS from 'src/i18n/en-us'

const mockGetBalance = jest.fn()

// Resolve real en-us strings (dotted keys), like the app does.
function t(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS)
  return typeof value === 'string' ? value : key
}

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
const mockWallet = Promise.resolve({ identity: { displayAddress: '0xabc' } })
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() => mockWallet),
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

  function mountReceive() {
    return shallowMount(Receive, {
      global: {
        mocks: { $t: t },
        stubs: Object.fromEntries(
          ['q-page-container', 'q-page', 'q-card', 'q-card-section'].map(n => [
            n,
            { template: '<div><slot /></div>' },
          ]),
        ),
      },
    })
  }

  it('shows a dash, not 0, until loaded, and an inline error on failure', async () => {
    mockGetBalance.mockRejectedValueOnce(new Error('rpc down'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const wrapper = mountReceive()
    const region = wrapper.get('[data-testid="receive-balance"]')
    expect(region.text()).toBe('\u2014')
    await advance(0)
    expect(region.text()).toBe('\u2014')
    expect(wrapper.get('[data-testid="receive-balance-error"]').text()).toBe(
      'Balance unavailable. Retrying.',
    )
    mockGetBalance.mockResolvedValue(0n)
    await advance(30000)
    expect(region.text()).toBe('0 MON') // a real zero is shown as such
    expect(wrapper.find('[data-testid="receive-balance-error"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
    spy.mockRestore()
  })

  it('exposes the balance as a labelled polite live region that does not re-announce', async () => {
    mockGetBalance.mockResolvedValue(3n)
    const wrapper = mountReceive()
    await advance(0)
    const region = wrapper.get('[data-testid="receive-balance"]')
    expect(region.attributes('role')).toBe('status')
    expect(region.attributes('aria-live')).toBe('polite')
    const labelId = region.attributes('aria-labelledby')
    expect(wrapper.get(`#${labelId}`).text()).toBe('Wallet Status')
    const node = region.element.firstChild
    await advance(15000)
    expect(region.element.firstChild).toBe(node)
    wrapper.unmount()
  })

  it('shows an updated balance without a reload', async () => {
    mockGetBalance.mockResolvedValueOnce(1n).mockResolvedValue(4n)
    const wrapper = mountReceive()
    await advance(0)
    expect(wrapper.text()).toContain('1 MON')
    await advance(15000)
    expect(wrapper.text()).toContain('4 MON')
    wrapper.unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})

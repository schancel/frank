/** @jest-environment jsdom */

import { enableAutoUnmount, shallowMount } from '@vue/test-utils'
enableAutoUnmount(afterEach)

import Receive from './Receive.vue'
import enUS from 'src/i18n/en-us'
import { errorNotify } from 'src/utils/notifications'
import { accountStatus } from '../accounts/session'
import { copyToClipboard } from 'quasar'

const mockGetBalance = jest.fn()
jest.mock('../accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ status: 'ready', revision: 1 }),
}))
const session = accountStatus as { status: string; revision: number }

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
    addressToString: ({ raw }: { raw: string }) => raw,
    nativeTransfers: {
      getBalance: (...args: unknown[]) => mockGetBalance(...args),
    },
  },
}))
const mockGetReceiveAddress = jest.fn(async () => ({ raw: '0xabc' }))
const mockWallet = Promise.resolve({
  identity: { displayAddress: 'legacy-display-address' },
  getReceiveAddress: mockGetReceiveAddress,
})
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
    mockGetReceiveAddress.mockReset().mockResolvedValue({ raw: '0xabc' })
    session.status = 'ready'
    session.revision = 1
    jest.mocked(copyToClipboard).mockClear()
    jest.mocked(errorNotify).mockClear()
  })
  afterEach(() => jest.useRealTimers())

  function mountReceive() {
    return shallowMount(Receive, {
      global: {
        mocks: { $t: t },
        stubs: {
          ...Object.fromEntries(
            ['q-page-container', 'q-page', 'q-card', 'q-card-section'].map(
              n => [n, { template: '<div><slot /></div>' }],
            ),
          ),
          QInput: { template: '<div><slot name="after" /></div>' },
          QBtn: {
            props: ['disable'],
            template: '<button :disabled="disable"><slot /></button>',
          },
          QrcodeVue: {
            props: ['value'],
            template: '<div data-testid="receive-qr" :data-value="value" />',
          },
        },
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

  it('explains where testnet funds come from only for a real zero balance (#316)', async () => {
    mockGetBalance.mockRejectedValueOnce(new Error('rpc down'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const wrapper = mountReceive()
    const hint = '[data-testid="receive-no-funds-hint"]'
    expect(wrapper.find(hint).exists()).toBe(false) // not loaded yet
    await advance(0)
    expect(wrapper.find(hint).exists()).toBe(false) // failed fetch is not a zero
    mockGetBalance.mockResolvedValueOnce(0n)
    await advance(30000)
    expect(wrapper.get(hint).text()).toContain('testnet MON')
    mockGetBalance.mockResolvedValue(5n)
    await advance(30000)
    expect(wrapper.find(hint).exists()).toBe(false) // funded
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

  it('renders the address supplied by the chain-neutral receive API', async () => {
    mockGetBalance.mockResolvedValue(1n)
    const wrapper = mountReceive()
    await advance(0)

    expect(mockGetReceiveAddress).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.displayAddress).toBe('0xabc')
    wrapper.unmount()
  })

  it('clears and replaces the mounted receive QR and copy destination with the active EVM role', async () => {
    mockGetBalance.mockResolvedValue(1n)
    const wrapper = mountReceive()
    await advance(0)
    expect(
      wrapper.get('[data-testid="receive-qr"]').attributes('data-value'),
    ).toBe('0xabc')
    session.status = 'loading'
    expect(wrapper.vm.displayAddress).toBe('')
    await advance(0)
    expect(wrapper.find('[data-testid="receive-qr"]').exists()).toBe(false)
    expect(
      wrapper
        .get('[data-testid="receive-copy-address"]')
        .attributes('disabled'),
    ).toBeDefined()
    await wrapper.get('[data-testid="receive-copy-address"]').trigger('click')
    expect(copyToClipboard).not.toHaveBeenCalled()
    mockGetReceiveAddress.mockResolvedValue({ raw: '0xreceiveB' })
    session.revision++
    session.status = 'ready'
    await advance(0)
    expect(wrapper.vm.displayAddress).toBe('0xreceiveB')
    expect(
      wrapper.get('[data-testid="receive-qr"]').attributes('data-value'),
    ).toBe('0xreceiveB')
    await wrapper.get('[data-testid="receive-copy-address"]').trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith('0xreceiveB')
    expect(copyToClipboard).not.toHaveBeenCalledWith('legacy-display-address')
    wrapper.unmount()
  })

  it('ignores a delayed retired receive-address result after the next account is displayed', async () => {
    let finish!: (address: { raw: string }) => void
    mockGetReceiveAddress.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    mockGetBalance.mockResolvedValue(1n)
    const wrapper = mountReceive()
    await advance(0)
    mockGetReceiveAddress.mockResolvedValue({ raw: '0xreceiveB' })
    session.revision++
    await advance(0)
    expect(wrapper.vm.displayAddress).toBe('0xreceiveB')
    finish({ raw: '0xretiredA' })
    await advance(0)
    expect(wrapper.vm.displayAddress).toBe('0xreceiveB')
    expect(
      wrapper.get('[data-testid="receive-qr"]').attributes('data-value'),
    ).toBe('0xreceiveB')
    wrapper.unmount()
  })

  it('clears a previously displayed receive destination on unavailability and on fresh acquisition failure', async () => {
    mockGetBalance.mockResolvedValue(1n)
    const wrapper = mountReceive()
    await advance(0)
    session.status = 'unavailable'
    expect(wrapper.vm.displayAddress).toBe('')
    await advance(0)
    expect(wrapper.find('[data-testid="receive-qr"]').exists()).toBe(false)
    mockGetReceiveAddress.mockRejectedValueOnce(new Error('unavailable'))
    session.status = 'ready'
    await advance(0)
    expect(wrapper.vm.displayAddress).toBe('')
    expect(
      wrapper
        .get('[data-testid="receive-copy-address"]')
        .attributes('disabled'),
    ).toBeDefined()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'receiveBitcoinDialog.failedLoadBalance',
    })
    wrapper.unmount()
  })

  it('uses the localized address-load fallback instead of provider text', async () => {
    const failure = new Error('raw provider failure')
    mockGetBalance.mockResolvedValue(1n)
    mockGetReceiveAddress.mockRejectedValueOnce(failure)
    const wrapper = mountReceive()
    await advance(0)

    expect(errorNotify).toHaveBeenCalledWith(failure, {
      fallbackKey: 'receiveBitcoinDialog.failedLoadBalance',
    })
    wrapper.unmount()
  })
})

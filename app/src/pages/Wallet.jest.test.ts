/** @jest-environment jsdom */

import { includedNativeTransfer } from '../../test/jest/utils/native-operation'
import { enableAutoUnmount, shallowMount } from '@vue/test-utils'
enableAutoUnmount(afterEach)
afterEach(() => {
  mockChainBalance.formattedBalance.value = ''
  mockChainBalance.loaded.value = false
  mockChainBalance.hasError.value = false
})
import { nextTick, ref } from 'vue'
import en from '../i18n/en-us'
import fr from '../i18n/fr-fr'
const mockGetChainAddress = jest.fn(async (chain: string) => {
  if (chain === 'ecash')
    return 'ecash:qz3fjd36tzd3qr6p7cqjytx4ftl9f4mghqdsk9xhj9'
  if (chain === 'solana') return 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'
  return '0xabc'
})

const mockGetCachedChainAddress = jest.fn(() => undefined)

jest.mock('../accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ status: 'ready', revision: 1 }),
  accountSession: {
    getChainAddress: (chain: string) => mockGetChainAddress(chain),
    getCachedChainAddress: (chain: string) => mockGetCachedChainAddress(chain),
  },
}))
import { accountStatus } from '../accounts/session'
import {
  activeChain,
  getActiveChain,
  setActiveChain,
} from '@frank/wallet/chain'
const session = accountStatus as { status: string; revision: number }

const balance = {
  formattedBalance: ref('1 MON'),
  balance: ref(1_000_000_000_000_000_000n),
  loaded: ref(true),
  hasError: ref(false),
  cordoned: ref<
    { formattedAmount: string; formattedTotal: string } | undefined
  >(undefined),
}
const openPage = jest.fn()
const mockCopyToClipboard = jest.fn()
const mockUseActiveWallet = jest.fn()
const mockRoute = ref<{ query: Record<string, string>; path: string }>({
  query: { chain: 'monad' },
  path: '/wallet',
})

const mockChainBalance = {
  formattedBalance: ref(''),
  balance: ref(0n),
  loaded: ref(false),
  hasError: ref(false),
  refresh: jest.fn(),
}

jest.mock('src/composables/useBalance', () => ({
  useBalance: () => balance,
}))

jest.mock('src/composables/useChainBalance', () => ({
  useChainBalance: (chain: any) => ({
    tokens: ref([]),
    tokenObservation: ref(undefined),
    presentation: jest.requireActual('vue').computed(() => {
      const val = typeof chain === 'string' ? chain : chain.value
      if (!['monad', 'ecash', 'solana'].includes(val)) {
        return { status: 'unavailable', reason: 'unsupported' }
      }
      const state = val === 'monad' ? balance : mockChainBalance
      const observation = state.loaded.value
        ? {
            balance: state.balance.value,
            formattedBalance: state.formattedBalance.value,
            ...(val === 'monad' && balance.cordoned.value
              ? { cordoned: balance.cordoned.value }
              : {}),
          }
        : undefined
      if (state.hasError.value) {
        return {
          status: 'unavailable',
          reason: 'fetch-error',
          lastKnown: observation,
        }
      }
      return observation
        ? { status: 'available', observation }
        : { status: 'loading' }
    }),
  }),
}))
jest.mock('src/stores/oracle', () => ({
  useSafeOracleStore: () => ({
    getAvu: () => 0,
    formatAvuAmount: (_asset: string) => '≈ 100.00 AVU',
    formatUnitRate: (asset: string) => {
      if (asset === 'monad') return '1 MON ≈ 41.67 AVU'
      if (asset === 'solana') return '1 SOL ≈ 1,785.71 AVU'
      return `1 ${asset.toUpperCase()} ≈ 100.00 AVU`
    },
    snapshot: { totalConstituents: 0, constituents: [] },
    startBackgroundWorker: jest.fn(),
  }),
}))
// The real vue-router CJS entry pulls in the ESM-only `nostics` package, which Jest's CommonJS
// setup cannot parse (see router/index.jest.test.ts's own boundary comment); Wallet.vue only
// needs the composable to exist.
jest.mock('vue-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useRoute: () => mockRoute.value,
}))
jest.mock('src/utils/routes', () => ({
  openPage: (...args: unknown[]) => openPage(...args),
}))
jest.mock('quasar', () => ({ copyToClipboard: mockCopyToClipboard }))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: (...args: unknown[]) => mockUseActiveWallet(...args),
}))

import Wallet from './Wallet.vue'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'

const mockWallet = { identity: { displayAddress: '0xabc' } }

async function flush() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
  }
  await nextTick()
}

function mountWallet(
  translate?: (
    key: string,
    params?: { balance?: string; unit?: string },
  ) => string,
) {
  return shallowMount(Wallet, {
    global: {
      mocks: {
        $t:
          translate ??
          ((key: string, params?: { balance?: string; unit?: string }) =>
            params?.balance
              ? `${key}:${params.balance}`
              : params?.unit
              ? `${key}:${params.unit}`
              : key),
      },
      stubs: {
        // The copy button lives in q-input's named #append slot; a generic stub drops it.
        QInput: {
          template:
            '<div><slot /><slot name="append" /><slot name="after" /></div>',
        },
        QBtn: {
          props: ['disable', 'label'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        ...Object.fromEntries(
          [
            'q-header',
            'q-toolbar',
            'q-toolbar-title',
            'q-page-container',
            'q-page',
            'q-scroll-area',
            'q-card',
            'q-card-section',
            'q-card-actions',
            'q-separator',
            'q-badge',
            'q-skeleton',
            'q-tabs',
            'q-tab',
            'q-tab-panels',
            'q-tab-panel',
            'q-tooltip',
            'q-icon',
          ].map(n => [n, { template: '<div><slot /></div>' }]),
        ),
      },
    },
  })
}

describe('Wallet detail page (#570)', () => {
  beforeEach(() => {
    mockRoute.value = { query: { chain: 'monad' }, path: '/wallet' }
    session.status = 'ready'
    session.revision = 1
    balance.formattedBalance.value = '1 MON'
    balance.loaded.value = true
    balance.hasError.value = false
    openPage.mockReset()
    mockCopyToClipboard.mockReset()
    mockCopyToClipboard.mockResolvedValue(undefined)
    mockUseActiveWallet.mockReset()
    mockUseActiveWallet.mockResolvedValue(mockWallet)
    mockGetCachedChainAddress.mockReset()
    mockGetCachedChainAddress.mockReturnValue(undefined)
    jest.mocked(addressCopiedNotify).mockClear()
    jest.mocked(errorNotify).mockClear()
  })

  it('shows the wallet, its chain, balance and address', async () => {
    const wrapper = mountWallet()
    await flush()
    expect(wrapper.get('[data-testid="wallet-name"]').text()).toContain(
      'walletPanel.mainWallet',
    )
    expect(wrapper.find('[data-testid="wallet-testnet-badge"]').exists()).toBe(
      true,
    )
    expect(wrapper.get('[data-testid="wallet-chain"]').text()).toBe(
      'walletPanel.monadTestnet',
    )
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      '0xabc',
    )
    expect(wrapper.get('[data-testid="wallet-send-action"]').text()).toBe(
      'walletPanel.sendMont',
    )
    const region = wrapper.get('[data-testid="wallet-balance"]')
    expect(region.text()).toBe('1 MON')
    expect(region.attributes()).toMatchObject({
      'role': 'status',
      'aria-live': 'polite',
    })
    expect(
      (wrapper.vm as unknown as { displayAddress: string }).displayAddress,
    ).toBe('0xabc')
    wrapper.unmount()
  })

  it('shows the total with the cordoned amount beside it only while funds sit at the profile address', async () => {
    const wrapper = mountWallet()
    await nextTick()
    const region = wrapper.get('[data-testid="wallet-balance"]')
    expect(region.text()).toBe('1 MON')
    expect(
      wrapper.find('[data-testid="wallet-balance-cordoned"]').exists(),
    ).toBe(false)
    balance.cordoned.value = {
      formattedAmount: '0.25 MON',
      formattedTotal: '1.25 MON',
    }
    await nextTick()
    expect(region.text().startsWith('1.25 MON')).toBe(true)
    expect(
      wrapper.get('[data-testid="wallet-balance-cordoned"]').text(),
    ).toContain('(walletPanel.cordoned)')
    balance.cordoned.value = undefined
    await nextTick()
    expect(region.text()).toBe('1 MON')
    wrapper.unmount()
  })

  it('shows loading until the balance loads, and an inline error on failure', async () => {
    balance.loaded.value = false
    balance.hasError.value = false
    const wrapper = mountWallet()
    await nextTick()
    const region = wrapper.get('[data-testid="wallet-balance"]')
    expect(region.text()).toBe('walletPanel.balanceLoading')
    balance.loaded.value = true
    await nextTick()
    expect(region.text()).toBe('1 MON') // a real zero or value is shown as such
    balance.hasError.value = true
    await nextTick()
    expect(region.text()).toBe('1 MON') // the last known value stays visible
    expect(wrapper.get('[data-testid="wallet-balance-error"]').text()).toBe(
      'walletPanel.balanceUnavailable',
    )
    wrapper.unmount()
  })

  it('copies the address and keeps Send reachable', async () => {
    const wrapper = mountWallet()
    await flush()

    const copyButton = wrapper.get('[data-testid="wallet-copy-address"]')
    expect(copyButton.attributes('aria-label')).toBe('a11y.copyAddress')
    await copyButton.trigger('click')
    await flush()
    expect(mockCopyToClipboard).toHaveBeenCalledWith('0xabc')
    expect(addressCopiedNotify).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="wallet-send-action"]').trigger('click')
    expect(openPage).toHaveBeenCalledWith(
      expect.anything(),
      '/send?chainIdentifier=monad-testnet',
    )

    await wrapper
      .get('[data-testid="wallet-contact-send-action"]')
      .trigger('click')
    expect(openPage).toHaveBeenCalledWith(expect.anything(), '/send-contact')
    wrapper.unmount()
  })

  it('reports a clipboard failure instead of claiming success', async () => {
    mockCopyToClipboard.mockRejectedValueOnce(new Error('denied'))
    const wrapper = mountWallet()
    await flush()

    await wrapper.get('[data-testid="wallet-copy-address"]').trigger('click')
    await flush()
    expect(mockCopyToClipboard).toHaveBeenCalledWith('0xabc')
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'walletPanel.unableCopyAddress',
    })
    expect(addressCopiedNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('clears and replaces the mounted identity address on session replacement', async () => {
    const wrapper = mountWallet()
    await flush()
    session.status = 'loading'
    expect(wrapper.vm.displayAddress).toBe('')
    await flush()
    const copy = wrapper.get('[data-testid="wallet-copy-address"]')
    expect(copy.attributes('disabled')).toBeDefined()
    await copy.trigger('click')
    expect(mockCopyToClipboard).not.toHaveBeenCalled()
    mockUseActiveWallet.mockResolvedValue({
      identity: { displayAddress: '0xauthB' },
      getReceiveAddress: async () => ({ raw: '0xreceiveB' }),
    })
    session.revision++
    session.status = 'ready'
    await flush()
    expect(wrapper.vm.displayAddress).toBe('0xreceiveB')
    await copy.trigger('click')
    expect(mockCopyToClipboard).toHaveBeenCalledWith('0xreceiveB')
    wrapper.unmount()
  })

  it('ignores delayed acquisition of account A after account B is displayed', async () => {
    let finish!: (wallet: typeof mockWallet) => void
    mockUseActiveWallet.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const wrapper = mountWallet()
    mockUseActiveWallet.mockResolvedValue({
      identity: { displayAddress: '0xauthB' },
    })
    session.revision++
    await flush()
    expect(wrapper.vm.displayAddress).toBe('0xauthB')
    finish(mockWallet)
    await flush()
    expect(wrapper.vm.displayAddress).toBe('0xauthB')
    wrapper.unmount()
  })

  it('clears the old identity through unavailable and failed replacement acquisition', async () => {
    const wrapper = mountWallet()
    await flush()
    session.status = 'unavailable'
    expect(wrapper.vm.displayAddress).toBe('')
    mockUseActiveWallet.mockRejectedValueOnce(new Error('locked'))
    session.status = 'ready'
    await flush()
    expect(wrapper.vm.displayAddress).toBe('')
    expect(
      wrapper.get('[data-testid="wallet-copy-address"]').attributes('disabled'),
    ).toBeDefined()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'walletPanel.failedLoadAddress',
    })
    wrapper.unmount()
  })

  it('does not copy an address that never loaded', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockUseActiveWallet.mockRejectedValueOnce(new Error('no wallet'))
    const wrapper = mountWallet()
    await flush()

    await wrapper.get('[data-testid="wallet-copy-address"]').trigger('click')
    await flush()
    expect(mockCopyToClipboard).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'walletPanel.failedLoadAddress',
    })
    wrapper.unmount()
    spy.mockRestore()
  })

  it('renders eCash wallet details and address when selected', async () => {
    mockRoute.value = { query: { chain: 'ecash' }, path: '/wallet' }
    const wrapper = mountWallet()
    await flush()

    expect(wrapper.get('[data-testid="wallet-name"]').text()).toContain(
      'walletPanel.ecash',
    )
    expect(wrapper.find('[data-testid="wallet-testnet-badge"]').exists()).toBe(
      true,
    )
    expect(wrapper.get('[data-testid="wallet-chain"]').text()).toBe(
      'walletPanel.ecashTestnet',
    )
    expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe(
      'walletPanel.balanceLoading',
    )
    expect(
      (wrapper.vm as unknown as { displayAddress: string }).displayAddress,
    ).toBe('ecash:qz3fjd36tzd3qr6p7cqjytx4ftl9f4mghqdsk9xhj9')
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      'ecash:qz3fjd36tzd3qr6p7cqjytx4ftl9f4mghqdsk9xhj9',
    )

    const sendBtn = wrapper.get('[data-testid="wallet-send-action"]')
    expect(sendBtn.text()).toBe('walletPanel.sendTxec')
    expect(sendBtn.attributes('disabled')).toBeDefined()

    wrapper.unmount()
  })

  it.each(['bitcoin', 'bitcoincash', 'dogecoin'])(
    'keeps unsupported %s details isolated from a funded Monad wallet',
    async chain => {
      mockRoute.value = { query: {}, path: `/wallet/${chain}` }
      const wrapper = mountWallet()
      await flush()
      // Not the wording of a failed fetch, and no second error line under it.
      expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe(
        'walletPanel.balanceUnsupported',
      )
      expect(
        wrapper.find('[data-testid="wallet-balance-error"]').exists(),
      ).toBe(false)
      expect(wrapper.text()).not.toContain('1 MON')
    },
  )

  it.each(['ecash', 'solana'])(
    'distinguishes %s loading, initial failure, real zero and stale observations',
    async chain => {
      mockRoute.value = { query: {}, path: `/wallet/${chain}` }
      const wrapper = mountWallet()
      const region = wrapper.get('[data-testid="wallet-balance"]')
      expect(region.text()).toBe('walletPanel.balanceLoading')
      mockChainBalance.hasError.value = true
      await nextTick()
      expect(region.text()).toBe('walletPanel.balanceUnavailable')
      mockChainBalance.hasError.value = false
      mockChainBalance.loaded.value = true
      mockChainBalance.formattedBalance.value =
        chain === 'ecash' ? '0 tXEC' : '0 dSOL'
      await nextTick()
      expect(region.text()).toBe(mockChainBalance.formattedBalance.value)
      expect(
        wrapper.find('[data-testid="wallet-balance-error"]').exists(),
      ).toBe(false)
      mockChainBalance.formattedBalance.value =
        chain === 'ecash' ? '25 tXEC' : '2 dSOL'
      mockChainBalance.hasError.value = true
      await nextTick()
      expect(region.text()).toBe(mockChainBalance.formattedBalance.value)
      expect(wrapper.get('[data-testid="wallet-balance-error"]').text()).toBe(
        'walletPanel.balanceUnavailable',
      )
    },
  )

  it('renders fetched non-zero eCash balance when loaded', async () => {
    mockChainBalance.loaded.value = true
    mockChainBalance.formattedBalance.value = '10000 tXEC'
    mockRoute.value = { query: { chain: 'ecash' }, path: '/wallet' }
    const wrapper = mountWallet()
    await flush()

    expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe(
      '10000 tXEC',
    )
    wrapper.unmount()
  })

  it.each([
    [en, 'Send dSOL'],
    [fr, 'Envoyer des dSOL'],
  ] as const)(
    'localizes the configured Solana send unit (%#)',
    async (messages, expected) => {
      mockChainBalance.loaded.value = true
      mockChainBalance.formattedBalance.value = '15 dSOL'
      mockRoute.value = { query: { chain: 'solana' }, path: '/wallet' }
      const wrapper = mountWallet((key, params) =>
        key === 'walletPanel.sendAsset'
          ? messages.walletPanel.sendAsset.replace('{unit}', params?.unit ?? '')
          : key,
      )
      await flush()
      expect(wrapper.get('[data-testid="wallet-send-action"]').text()).toBe(
        expected,
      )
      expect(
        wrapper
          .get('[data-testid="wallet-send-action"]')
          .attributes('disabled'),
      ).toBeUndefined()
    },
  )

  it('enables native Send for the funded Solana wallet and routes its canonical network', async () => {
    mockChainBalance.loaded.value = true
    mockChainBalance.formattedBalance.value = '15 dSOL'
    mockRoute.value = { query: { chain: 'solana' }, path: '/wallet' }
    const wrapper = mountWallet()
    await flush()

    expect(wrapper.get('[data-testid="wallet-name"]').text()).toContain(
      'walletPanel.solana',
    )
    expect(wrapper.find('[data-testid="wallet-testnet-badge"]').exists()).toBe(
      true,
    )
    expect(wrapper.get('[data-testid="wallet-chain"]').text()).toBe(
      'Solana Devnet',
    )
    expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe('15 dSOL')
    expect(
      (wrapper.vm as unknown as { displayAddress: string }).displayAddress,
    ).toBe('AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9')
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
    )

    const sendBtn = wrapper.get('[data-testid="wallet-send-action"]')
    expect(sendBtn.text()).toBe('walletPanel.sendAsset:dSOL')
    expect(sendBtn.attributes('disabled')).toBeUndefined()
    await sendBtn.trigger('click')
    expect(openPage).toHaveBeenCalledWith(
      expect.anything(),
      '/send?chainIdentifier=solana-devnet',
    )

    wrapper.unmount()
  })

  it('supports path-based routing via route.params.wallet', async () => {
    mockRoute.value = {
      query: {},
      path: '/wallet/solana',
      // @ts-expect-error mock params
      params: { wallet: 'solana' },
    }
    const wrapper = mountWallet()
    await flush()

    expect(wrapper.get('[data-testid="wallet-name"]').text()).toContain(
      'walletPanel.solana',
    )
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
    )
    wrapper.unmount()
  })

  it('renders skeleton placeholder and does not render QR code while address is loading', async () => {
    let resolveAddress: (addr: string) => void = () => undefined
    const pendingAddress = new Promise<string>(resolve => {
      resolveAddress = resolve
    })
    mockGetChainAddress.mockImplementation(async (chain: string) => {
      if (chain === 'ecash') return pendingAddress
      return '0xabc'
    })

    mockRoute.value = {
      query: {},
      path: '/wallet/ecash',
      // @ts-expect-error mock params
      params: { wallet: 'ecash' },
    }
    const wrapper = mountWallet()
    await nextTick()

    expect(wrapper.find('[data-testid="wallet-qr-skeleton"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="wallet-qr"]').exists()).toBe(false)

    resolveAddress('ecash:loadedAddress')
    await flush()

    expect(wrapper.find('[data-testid="wallet-qr-skeleton"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="wallet-qr"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      'ecash:loadedAddress',
    )
    wrapper.unmount()
  })

  it('renders QR code synchronously when address is cached', () => {
    mockGetCachedChainAddress.mockReturnValue(
      'ecash:cached_immediate_address_123',
    )
    mockRoute.value = {
      query: {},
      path: '/wallet/ecash',
      // @ts-expect-error mock params
      params: { wallet: 'ecash' },
    }
    const wrapper = mountWallet()

    // Immediately rendered without waiting for async flush
    expect(wrapper.find('[data-testid="wallet-qr-skeleton"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="wallet-qr"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      'ecash:cached_immediate_address_123',
    )
    wrapper.unmount()
  })

  it('always displays the 1-unit physical compute AVU rate badge and keeps it clickable', async () => {
    mockRoute.value = {
      query: { chain: 'monad' },
      path: '/wallet',
    }
    balance.loaded.value = false
    const wrapper = mountWallet()

    // Unit rate badge is visible even when balance is not loaded
    const unitRateBadge = wrapper.find('[data-testid="wallet-unit-rate-avu"]')
    expect(unitRateBadge.exists()).toBe(true)
    expect(unitRateBadge.text()).toContain('1 MON ≈ 41.67 AVU')

    // Click opens AvuExplainerDialog
    await unitRateBadge.trigger('click')
    expect(wrapper.vm.showAvuDialog).toBe(true)

    // AVU balance line becomes visible when balance is loaded
    balance.loaded.value = true
    await nextTick()
    expect(wrapper.find('[data-testid="wallet-balance-avu"]').exists()).toBe(
      true,
    )
    wrapper.unmount()
  })

  it('renders tabbed wallet view with balance and parity tabs and embeds AvuParityChart', async () => {
    mockRoute.value = {
      query: { chain: 'monad' },
      path: '/wallet',
    }
    const wrapper = mountWallet()

    // Tabs container exists
    const tabs = wrapper.find('[data-testid="wallet-tabs"]')
    expect(tabs.exists()).toBe(true)

    // Tab buttons exist
    const balanceTab = wrapper.find('[data-testid="wallet-tab-balance"]')
    expect(balanceTab.exists()).toBe(true)
    const swapTab = wrapper.find('[data-testid="wallet-tab-swap"]')
    expect(swapTab.exists()).toBe(true)
    const parityTab = wrapper.find('[data-testid="wallet-tab-parity"]')
    expect(parityTab.exists()).toBe(true)

    // activeTab defaults to balance
    expect(wrapper.vm.activeTab).toBe('balance')

    // Tab panels container exists
    const panels = wrapper.find('[data-testid="wallet-tab-panels"]')
    expect(panels.exists()).toBe(true)

    // Components are registered and embedded
    expect(wrapper.findComponent({ name: 'AvuParityChart' }).exists()).toBe(
      true,
    )
    expect(wrapper.findComponent({ name: 'DAppSwapView' }).exists()).toBe(true)

    // Switching activeTab
    wrapper.vm.activeTab = 'swap'
    await nextTick()
    expect(wrapper.vm.activeTab).toBe('swap')

    wrapper.vm.activeTab = 'parity'
    await nextTick()
    expect(wrapper.vm.activeTab).toBe('parity')

    wrapper.unmount()
  })

  test('renders top header with title and emits toggleMyDrawerOpen on menu click', async () => {
    const wrapper = mountWallet()
    await flush()

    const menuBtn = wrapper.find('[data-test="wallet-menu-btn"]')
    expect(menuBtn.exists()).toBe(true)

    await menuBtn.trigger('click')
    expect(wrapper.emitted('toggleMyDrawerOpen')).toBeTruthy()
    expect(wrapper.emitted('toggleMyDrawerOpen')?.length).toBe(1)

    wrapper.unmount()
  })
  it.each([en, fr])(
    'lists paid but unsynced native history from the reopened owner without financial effects',
    async messages => {
      const fixture = await includedNativeTransfer()
      await fixture.reopen()
      const getNativeOperations = jest.fn(() => fixture.journal.list())
      const forbidden = jest.fn(() => {
        throw new Error('financial effect from history')
      })
      mockUseActiveWallet.mockResolvedValue({
        family: 'evm',
        chainIdentifier: 'monad-testnet',
        identity: { displayAddress: '0xabc' },
        getNativeOperations,
        getUnresolvedLegacySend: forbidden,
        resumeNativeOperation: forbidden,
        sendLegacy: forbidden,
        sendNative: forbidden,
        getBalance: forbidden,
      })
      const translate = (key: string, params: Record<string, unknown> = {}) => {
        const value = key
          .split('.')
          .reduce<unknown>(
            (row, part) => (row as Record<string, unknown>)?.[part],
            messages,
          )
        return typeof value === 'string'
          ? Object.entries(params).reduce(
              (text, [name, replacement]) =>
                text.replaceAll(`{${name}}`, String(replacement)),
              value,
            )
          : key
      }
      const wrapper = mountWallet(translate)
      try {
        await flush()
        const history = wrapper.get('[data-testid="wallet-native-operations"]')
        expect(history.text()).toContain(
          translate('nativeOperation.included', { network: 'monad-testnet' }),
        )
        expect(history.text()).toContain(fixture.hash)
        expect(history.text()).toContain(fixture.operationId)
        expect(history.text()).toContain(
          messages.nativeOperation.syncUnrecorded,
        )
        expect(history.text()).toContain('0.01 MON')
        expect(history.text()).toContain('0.002142 MON')
        expect(history.text()).not.toContain(
          fixture.journal.list()[0]!.members[0]!.signed!.rawTransaction,
        )
        expect(getNativeOperations).toHaveBeenCalledTimes(1)
        expect(forbidden).not.toHaveBeenCalled()
        mockUseActiveWallet.mockResolvedValue({
          family: 'evm',
          chainIdentifier: 'monad-testnet',
          identity: { displayAddress: 'replacement' },
          getNativeOperations: () => [],
        })
        session.revision++
        await flush()
        expect(history.text()).not.toContain(fixture.hash)
        expect(forbidden).not.toHaveBeenCalled()
      } finally {
        wrapper.unmount()
        await fixture.close()
      }
    },
  )

  it('reports capability absence for Solana without asking an EVM owner for history', async () => {
    mockRoute.value.query = { chain: 'solana' }
    const wrapper = mountWallet()
    await flush()
    expect(
      wrapper.get('[data-testid="wallet-native-operations"]').text(),
    ).toContain('nativeOperation.unsupported')
    expect(mockUseActiveWallet).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('clears native evidence when the selected network changes during owner acquisition', async () => {
    const fixture = await includedNativeTransfer()
    let finish!: (wallet: unknown) => void
    mockUseActiveWallet.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const wrapper = mountWallet()
    try {
      mockRoute.value.query = { chain: 'solana' }
      await flush()
      finish({
        family: 'evm',
        chainIdentifier: 'monad-testnet',
        identity: { displayAddress: 'old' },
        getNativeOperations: () => fixture.journal.list(),
      })
      await flush()
      expect(
        wrapper.get('[data-testid="wallet-native-operations"]').text(),
      ).not.toContain(fixture.hash)
    } finally {
      wrapper.unmount()
      await fixture.close()
    }
  })
  it.each(['visible', 'acquiring'] as const)(
    'clears %s history on the real active-chain setter with the same account and route',
    async phase => {
      const fixture = await includedNativeTransfer()
      const original = getActiveChain()
      const previousRevision = session.revision
      const previousRoute = mockRoute.value
      const oldOwner = {
        family: 'evm',
        chainIdentifier: 'monad-testnet',
        identity: { displayAddress: 'old-address' },
        getNativeOperations: jest.fn(() => fixture.journal.list()),
      }
      let releaseOld!: (wallet: unknown) => void
      if (phase === 'acquiring') {
        mockUseActiveWallet.mockImplementationOnce(
          () =>
            new Promise(resolve => {
              releaseOld = resolve
            }),
        )
      } else mockUseActiveWallet.mockResolvedValueOnce(oldOwner)
      const wrapper = mountWallet()
      try {
        await flush()
        if (phase === 'visible')
          expect(
            wrapper.get('[data-testid="wallet-native-operations"]').text(),
          ).toContain(fixture.hash)
        // A pending replacement prevents a new row from disguising a stale old row.
        let releaseNew!: (wallet: unknown) => void
        mockUseActiveWallet.mockImplementationOnce(
          () =>
            new Promise(resolve => {
              releaseNew = resolve
            }),
        )
        setActiveChain({
          ...activeChain,
          chainIdentifier: 'monad-mainnet',
          isTestnet: false,
          unit: 'MON',
        })
        expect(session.revision).toBe(previousRevision)
        expect(mockRoute.value).toBe(previousRoute)
        await flush()
        expect(
          wrapper.get('[data-testid="wallet-native-operations"]').text(),
        ).not.toContain(fixture.hash)
        if (phase === 'acquiring') releaseOld(oldOwner)
        await flush()
        expect(
          wrapper.get('[data-testid="wallet-native-operations"]').text(),
        ).not.toContain(fixture.hash)
        if (phase === 'acquiring')
          expect(oldOwner.getNativeOperations).not.toHaveBeenCalled()
        expect(mockUseActiveWallet).toHaveBeenCalledTimes(2)
        releaseNew({
          family: 'evm',
          chainIdentifier: 'monad-mainnet',
          identity: { displayAddress: 'new-address' },
          getNativeOperations: () => [],
        })
        await flush()
        expect(
          wrapper.get('[data-testid="wallet-native-operations"]').text(),
        ).not.toContain(fixture.hash)
        expect(
          wrapper.find('[data-testid="wallet-testnet-badge"]').exists(),
        ).toBe(false)
      } finally {
        wrapper.unmount()
        const calls = mockUseActiveWallet.mock.calls.length
        setActiveChain(original)
        await flush()
        expect(mockUseActiveWallet).toHaveBeenCalledTimes(calls)
        await fixture.close()
      }
    },
  )
})

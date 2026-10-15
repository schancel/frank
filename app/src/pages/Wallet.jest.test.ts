/** @jest-environment jsdom */

import { includedNativeTransfer } from '../../test/jest/utils/native-operation'
import { enableAutoUnmount, shallowMount } from '@vue/test-utils'
enableAutoUnmount(afterEach)
afterEach(() => {
  mockChainBalance.formattedBalance.value = ''
  mockChainBalance.loaded.value = false
  mockChainBalance.hasError.value = false
  mockChainBalance.indexerPending.value = false
})
import { nextTick, ref } from 'vue'
import RenameWalletDialog from '../components/wallet/RenameWalletDialog.vue'
import { useWalletNames } from '../composables/useWalletNames'
import * as nativeTransfer from '../accounts/native-transfer'
import type { EvmNativeOperationStatus } from '@frank/wallet/chain'
import type { TokenItem } from '../composables/useChainBalance'
import type { EvmTokenRow } from '../composables/useEvmTokenBalances'
import type { SwapActivityRow } from '../swap/useSwapActivity'
import en from '../i18n/en-us'
import fr from '../i18n/fr-fr'
const mockGetChainAddress = jest.fn(async (chain: string) => {
  if (chain.startsWith('monad-')) {
    const wallet = await mockUseActiveWallet()
    return wallet.getReceiveAddress
      ? (await wallet.getReceiveAddress()).raw
      : wallet.identity.displayAddress
  }
  if (chain === 'ecash')
    return 'ecash:qz3fjd36tzd3qr6p7cqjytx4ftl9f4mghqdsk9xhj9'
  if (chain === 'solana') return 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'
  return '0xabc'
})

const mockGetCachedChainAddress = jest.fn(() => undefined)

// The session's Bitcoin-family wallets hand out their own next unused receive address.
const UTXO_ADDRESSES: Record<string, string> = {
  'xec-testnet': 'ectest:qz3fjd36tzd3qr6p7cqjytx4ftl9f4mghqdsk9xhj9',
  'btc-testnet': 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl',
}
const mockUtxoReceiveAddress = jest.fn(
  async (chainIdentifier: string) => UTXO_ADDRESSES[chainIdentifier],
)
const mockOpenUtxoWallet = jest.fn(async (chainIdentifier: string) => ({
  chain: { chainIdentifier },
  wallet: {
    localReceiveAddress: () => ({
      raw: UTXO_ADDRESSES[chainIdentifier],
    }),
    getReceiveAddress: async () => ({
      raw: await mockUtxoReceiveAddress(chainIdentifier),
    }),
  },
}))
jest.mock('src/accounts/utxo-wallets', () => ({
  openUtxoWallet: (chainIdentifier: string) =>
    mockOpenUtxoWallet(chainIdentifier),
}))

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
  getChainRegistryEntry,
  setActiveChain,
} from '@frank/wallet/chain'
const session = accountStatus as { status: string; revision: number }

const balance = {
  formattedBalance: ref('1 MON'),
  balance: ref(1_000_000_000_000_000_000n),
  loaded: ref(true),
  hasError: ref(false),
}
const openPage = jest.fn()
const mockCopyToClipboard = jest.fn()
const mockSwapRows = ref<SwapActivityRow[]>([])
jest.mock('src/swap/useSwapActivity', () => ({
  useSwapActivity: () => ({ rows: mockSwapRows }),
}))
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
  indexerPending: ref(false),
  refresh: jest.fn(),
}

jest.mock('src/composables/useBalance', () => ({
  useBalance: () => balance,
}))

let mockAdditionalBalanceRows = false
const mockTokens = ref<TokenItem[]>([])
const mockEvmTokens = ref<EvmTokenRow[]>([])
jest.mock('src/composables/useEvmTokenBalances', () => ({
  useEvmTokenBalances: () => ({
    rows: mockEvmTokens,
    status: ref('available'),
    refresh: jest.fn(),
  }),
}))
const mockRefreshCordoned = jest.fn()
jest.mock('src/composables/useChainBalance', () => ({
  useChainBalance: (chain: any) => ({
    refreshCordoned: () => mockRefreshCordoned(),
    tokens: mockTokens,
    tokenObservation: ref(undefined),
    presentation: jest.requireActual('vue').computed(() => {
      const val = typeof chain === 'string' ? chain : chain.value
      if (
        !['monad', 'ecash', 'solana'].includes(val) &&
        !(mockAdditionalBalanceRows && ['bitcoin', 'bitcoincash'].includes(val))
      ) {
        return { status: 'unavailable', reason: 'unsupported' }
      }
      const state = val === 'monad' ? balance : mockChainBalance
      const observation = state.loaded.value
        ? {
            balance: state.balance.value,
            formattedBalance: state.formattedBalance.value,
          }
        : undefined
      if (state.indexerPending?.value && !observation) {
        return { status: 'pending' }
      }
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
  realAssetRows = false,
) {
  const assetComponents = [
    'QList',
    'QItem',
    'QItemSection',
    'QItemLabel',
    'QAvatar',
    'QBadge',
  ]
  const quasar = realAssetRows ? jest.requireActual('quasar') : {}
  return shallowMount(Wallet, {
    global: {
      provide: {
        _q_: {
          dark: { isActive: false },
          lang: { rtl: false },
          platform: { is: {} },
        },
      },
      components: realAssetRows
        ? Object.fromEntries(assetComponents.map(name => [name, quasar[name]]))
        : {},
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
        WalletHistory: false,
        AddressText: {
          props: ['address'],
          template: '<span>{{ address }}</span>',
        },
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
            'q-list',
            'q-item',
            'q-item-section',
            'q-item-label',
          ].map(n => [
            n,
            realAssetRows &&
            [
              'q-list',
              'q-item',
              'q-item-section',
              'q-item-label',
              'q-avatar',
              'q-badge',
            ].includes(n)
              ? false
              : { template: '<div><slot /></div>' },
          ]),
        ),
        ...(realAssetRows ? { QAvatar: false } : {}),
      },
    },
  })
}

describe('Wallet detail page (#570)', () => {
  beforeEach(() => {
    mockSwapRows.value = []
    mockAdditionalBalanceRows = false
    mockTokens.value = []
    mockEvmTokens.value = []
    useWalletNames().clearAllCustomNames()
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
    mockOpenUtxoWallet.mockClear()
    mockGetChainAddress.mockClear()
    jest.mocked(addressCopiedNotify).mockClear()
    jest.mocked(errorNotify).mockClear()
  })

  it.each([
    ['monad-regtest', 'MONR'],
    ['monad-testnet', 'MONT'],
    ['monad-mainnet', 'MON'],
  ])(
    'uses configured %s metadata for header, balance and native Send',
    async (chainIdentifier, unit) => {
      const original = getActiveChain()
      const metadata = getChainRegistryEntry(chainIdentifier)!
      try {
        setActiveChain({
          ...original,
          chainIdentifier,
          unit,
          isTestnet: metadata.isTestnet,
        })
        balance.formattedBalance.value = `0 ${unit}`
        const wrapper = mountWallet()
        await flush()
        expect(wrapper.get('[data-testid="wallet-unit"]').text()).toBe(
          `(${unit})`,
        )
        expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe(
          `0 ${unit}`,
        )
        const send = wrapper.get('[data-testid="wallet-send-action"]')
        expect(send.text()).toBe(`walletPanel.sendAsset:${unit}`)
        expect(send.attributes('disabled')).toBeUndefined()
        await send.trigger('click')
        expect(openPage).toHaveBeenCalledWith(
          expect.anything(),
          `/send?chainIdentifier=${chainIdentifier}`,
        )
        wrapper.unmount()
      } finally {
        setActiveChain(original)
      }
    },
  )

  it.each([
    ['monad', 'monad-testnet', 'MONT'],
    ['monad', 'monad-regtest', 'MONR'],
    ['solana', 'monad-testnet', 'dSOL'],
    ['ecash', 'monad-testnet', 'tXEC'],
    ['bitcoin', 'monad-testnet', 'tBTC'],
    ['bitcoincash', 'monad-testnet', 'tBCH'],
  ])(
    'shows one native asset for %s on runtime %s',
    async (wallet, runtime, unit) => {
      const original = getActiveChain()
      try {
        setActiveChain({
          ...original,
          chainIdentifier: runtime,
          isTestnet: true,
        })
        mockAdditionalBalanceRows = true
        mockRoute.value = { path: '/wallet', query: { chain: wallet } }
        const state = wallet === 'monad' ? balance : mockChainBalance
        state.loaded.value = true
        state.formattedBalance.value = `2 ${unit}`
        const wrapper = mountWallet(undefined, true)
        await flush()
        const row = wrapper.get(
          `[data-testid="wallet-token-item-${unit.toLowerCase()}"]`,
        )
        expect(row.classes()).toContain('q-item')
        expect(row.text()).toContain(`2 ${unit}`)
        expect(row.text()).toContain('walletPanel.nativeCoin')
        expect(wrapper.findAll('[data-native-asset]')).toHaveLength(1)
        expect(wrapper.get('[data-testid="wallet-asset-count"]').text()).toBe(
          '1 Asset',
        )
      } finally {
        setActiveChain(original)
      }
    },
  )

  it.each(['solana', 'monad'])(
    'counts %s native and tokens once without summing balances',
    async wallet => {
      mockRoute.value = { path: '/wallet', query: { chain: wallet } }
      mockChainBalance.loaded.value = true
      mockChainBalance.formattedBalance.value = '2 dSOL'
      if (wallet === 'solana') {
        mockTokens.value = [
          {
            id: 'native',
            symbol: 'dSOL',
            name: 'Solana',
            isNative: true,
            balanceFormatted: '999 dSOL',
            numericBalance: 999,
            avuFormatted: '',
            mintOrAddress: '',
          },
          {
            id: 'spl',
            symbol: 'SPL',
            name: 'Token',
            balanceFormatted: '3 SPL',
            numericBalance: 3,
            avuFormatted: '',
            mintOrAddress: 'mint',
          },
        ]
      } else {
        mockEvmTokens.value = [
          {
            address: '0xtoken',
            symbol: 'ERC',
            name: 'ERC token',
            balance: '4',
            exact: '4',
          },
        ]
      }
      const wrapper = mountWallet(undefined, true)
      await flush()
      expect(wrapper.findAll('[data-native-asset]')).toHaveLength(1)
      expect(wrapper.get('[data-testid="wallet-asset-count"]').text()).toBe(
        '2 Assets',
      )
      expect(wrapper.get('[data-native-asset]').text()).toContain(
        wallet === 'solana' ? '2 dSOL' : '1 MON',
      )
      expect(wrapper.get('[data-native-asset]').text()).not.toContain('999')
      expect(
        wrapper
          .find(
            `[data-testid="wallet-token-item-${
              wallet === 'solana' ? 'spl' : 'erc'
            }"]`,
          )
          .exists(),
      ).toBe(true)
    },
  )

  it('keeps native loading, unavailable and last-known states explicit', async () => {
    balance.loaded.value = false
    const wrapper = mountWallet()
    await flush()
    expect(wrapper.get('[data-native-asset]').text()).toContain(
      'walletPanel.balanceLoading',
    )
    balance.hasError.value = true
    await nextTick()
    expect(wrapper.get('[data-native-asset]').text()).toContain(
      'walletPanel.balanceUnavailable',
    )
    balance.loaded.value = true
    await nextTick()
    expect(wrapper.get('[data-native-asset]').text()).toContain(
      'walletPanel.balanceStale:1 MON',
    )
    expect(wrapper.get('[data-native-asset]').text()).not.toContain('AVU')
  })

  it('updates canonical metadata when regtest changes to testnet without changing the testnet flag', async () => {
    const original = getActiveChain()
    try {
      setActiveChain({
        ...original,
        chainIdentifier: 'monad-regtest',
        unit: 'MONR',
        isTestnet: true,
      })
      const wrapper = mountWallet()
      await flush()
      expect(wrapper.get('[data-testid="wallet-unit"]').text()).toBe('(MONR)')
      setActiveChain({
        ...original,
        chainIdentifier: 'monad-testnet',
        unit: 'MONT',
        isTestnet: true,
      })
      await flush()
      expect(wrapper.get('[data-testid="wallet-unit"]').text()).toBe('(MONT)')
      await wrapper.get('[data-testid="wallet-send-action"]').trigger('click')
      expect(openPage).toHaveBeenCalledWith(
        expect.anything(),
        '/send?chainIdentifier=monad-testnet',
      )
      wrapper.unmount()
    } finally {
      setActiveChain(original)
    }
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
    expect(wrapper.find('[data-testid="wallet-chain"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      '0xabc',
    )
    expect(wrapper.get('[data-testid="wallet-send-action"]').text()).toBe(
      'walletPanel.sendAsset:MONT',
    )
    expect(wrapper.get('[data-testid="wallet-unit"]').text()).toBe('(MONT)')
    await wrapper.get('[data-testid="wallet-about-avu"]').trigger('click')
    expect(openPage).toHaveBeenCalledWith(expect.anything(), '/avu')
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

  it('shows the one balance figure, with no second line about the profile address', async () => {
    const wrapper = mountWallet()
    await nextTick()
    // The figure already includes the profile address (`useBalance().total`): the page adds
    // nothing to it and says nothing beside it.
    expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe('1 MON')
    expect(
      wrapper.find('[data-testid="wallet-balance-cordoned"]').exists(),
    ).toBe(false)
    wrapper.unmount()
  })

  it('opens the breakdown of the balance from the balance, and closes it again', async () => {
    const wrapper = mountWallet()
    await nextTick()
    const shown = () =>
      wrapper.findComponent({ name: 'BalanceBreakdown' }).exists()
    expect(shown()).toBe(false)
    const toggle = wrapper.get(
      '[data-testid="wallet-balance-breakdown-toggle"]',
    )
    expect(toggle.text()).toBe('balanceBreakdown.open')
    await toggle.trigger('click')
    expect(shown()).toBe(true)
    await toggle.trigger('click')
    expect(shown()).toBe(false)
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

  it('asks for a fresh cordoned amount once when the page opens', async () => {
    mockRefreshCordoned.mockClear()
    const wrapper = mountWallet()
    await flush()
    expect(mockRefreshCordoned).toHaveBeenCalledTimes(1)
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
    expect(
      wrapper.get('[data-testid="wallet-address-unavailable"]').exists(),
    ).toBe(true)
    expect(errorNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows the local lead address when the unused-address check cannot reach the indexer', async () => {
    mockRoute.value = { path: '/wallet/ecash', query: {} }
    mockUtxoReceiveAddress.mockRejectedValueOnce(new Error('no electrum'))
    const wrapper = mountWallet()
    await flush()
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      UTXO_ADDRESSES['xec-testnet'],
    )
    expect(
      wrapper.get('[data-testid="wallet-address-unavailable"]').text(),
    ).toContain('walletPanel.receiveDiscoveryUnavailable')
    expect(
      wrapper.get('[data-testid="wallet-copy-address"]').attributes('disabled'),
    ).toBeUndefined()
    expect(errorNotify).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows a pending balance while the indexer has not answered', async () => {
    mockRoute.value = { query: {}, path: '/wallet/ecash' }
    mockChainBalance.indexerPending.value = true
    const wrapper = mountWallet()
    await flush()
    expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe(
      'walletPanel.balancePending',
    )
    expect(wrapper.find('[data-testid="wallet-balance-error"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })

  it('shows discovery availability without repeated derivation toasts, then retries the next unused address', async () => {
    mockRoute.value = { path: '/wallet/ecash', query: {} }
    mockOpenUtxoWallet.mockRejectedValueOnce(new Error('relay unavailable'))
    const wrapper = mountWallet()
    await flush()
    expect(
      wrapper.get('[data-testid="wallet-address-unavailable"]').text(),
    ).toContain('walletPanel.receiveDiscoveryUnavailable')
    expect(wrapper.find('[data-testid="wallet-qr"]').exists()).toBe(false)
    expect(
      wrapper.get('[data-testid="wallet-copy-address"]').attributes('disabled'),
    ).toBeDefined()
    expect(errorNotify).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="wallet-retry-address"]').trigger('click')
    await flush()
    expect(
      wrapper.find('[data-testid="wallet-address-unavailable"]').exists(),
    ).toBe(false)
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      UTXO_ADDRESSES['xec-testnet'],
    )
    expect(errorNotify).not.toHaveBeenCalled()
  })

  it('does not copy an address that never loaded', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockUseActiveWallet.mockRejectedValueOnce(new Error('no wallet'))
    const wrapper = mountWallet()
    await flush()

    await wrapper.get('[data-testid="wallet-copy-address"]').trigger('click')
    await flush()
    expect(mockCopyToClipboard).not.toHaveBeenCalled()
    expect(
      wrapper.get('[data-testid="wallet-address-unavailable"]').exists(),
    ).toBe(true)
    expect(errorNotify).not.toHaveBeenCalled()
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
    expect(wrapper.find('[data-testid="wallet-chain"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe(
      'walletPanel.balanceLoading',
    )
    // The address is the wallet's own next unused one, not a fixed derived address.
    expect(mockOpenUtxoWallet).toHaveBeenCalledWith('xec-testnet')
    expect(mockGetChainAddress).not.toHaveBeenCalledWith('ecash')
    expect(
      (wrapper.vm as unknown as { displayAddress: string }).displayAddress,
    ).toBe('ectest:qz3fjd36tzd3qr6p7cqjytx4ftl9f4mghqdsk9xhj9')
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      'ectest:qz3fjd36tzd3qr6p7cqjytx4ftl9f4mghqdsk9xhj9',
    )

    const sendBtn = wrapper.get('[data-testid="wallet-send-action"]')
    expect(sendBtn.text()).toBe('walletPanel.sendAsset:tXEC')
    expect(sendBtn.attributes('disabled')).toBeUndefined()

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
    expect(wrapper.find('[data-testid="wallet-chain"]').exists()).toBe(false)
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

  it('shows the local lead address while the unused-address check is still loading', async () => {
    let resolveAddress: (addr: string) => void = () => undefined
    const pendingAddress = new Promise<string>(resolve => {
      resolveAddress = resolve
    })
    mockUtxoReceiveAddress.mockImplementationOnce(() => pendingAddress)

    mockRoute.value = {
      query: {},
      path: '/wallet/ecash',
      // @ts-expect-error mock params
      params: { wallet: 'ecash' },
    }
    const wrapper = mountWallet()
    await flush()

    expect(wrapper.find('[data-testid="wallet-qr-skeleton"]').exists()).toBe(
      false,
    )
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      UTXO_ADDRESSES['xec-testnet'],
    )

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

  it.each(['lotus', 'unconfigured-chain'])(
    'shows no address for %s, which the app cannot read, and says it is unsupported',
    async chain => {
      mockRoute.value = { query: { chain }, path: '/wallet' }
      const wrapper = mountWallet()
      await flush()

      expect(wrapper.find('[data-testid="wallet-unsupported"]').exists()).toBe(
        true,
      )
      expect(wrapper.find('[data-testid="wallet-qr"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="wallet-qr-container"]').exists()).toBe(
        false,
      )
      expect(
        (wrapper.vm as unknown as { displayAddress: string }).displayAddress,
      ).toBe('')
      // Nothing is derived for it either.
      expect(mockGetChainAddress).not.toHaveBeenCalledWith(chain)
      expect(mockOpenUtxoWallet).not.toHaveBeenCalled()
      wrapper.unmount()
    },
  )

  it('shows the Hyperliquid wallet address and offers Send when supported', async () => {
    mockRoute.value = { query: { chain: 'hyperliquid' }, path: '/wallet' }
    const wrapper = mountWallet()
    await flush()

    expect(wrapper.find('[data-testid="wallet-unsupported"]').exists()).toBe(
      false,
    )
    expect(mockGetChainAddress).toHaveBeenCalledWith('hyperliquid')
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      '0xabc',
    )
    expect(wrapper.find('[data-testid="wallet-send-action"]').exists()).toBe(
      true,
    )
    wrapper.unmount()
  })

  it('renders Tempo PathUSD panel when Tempo wallet is selected', async () => {
    mockRoute.value = { query: { chain: 'tempo' }, path: '/wallet' }
    const wrapper = mountWallet()
    await flush()

    expect(wrapper.find('[data-testid="wallet-unsupported"]').exists()).toBe(
      false,
    )
    expect(wrapper.findComponent({ name: 'TempoPathUsdPanel' }).exists()).toBe(
      true,
    )
    wrapper.unmount()
  })

  it('shows the Bitcoin testnet wallet address and offers Send', async () => {
    mockRoute.value = { query: { chain: 'bitcoin' }, path: '/wallet' }
    const wrapper = mountWallet()
    await flush()

    expect(mockOpenUtxoWallet).toHaveBeenCalledWith('btc-testnet')
    expect(wrapper.get('[data-testid="wallet-qr"]').attributes('value')).toBe(
      'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl',
    )
    expect(wrapper.find('[data-testid="wallet-send-action"]').exists()).toBe(
      true,
    )
    wrapper.unmount()
  })

  it('renders QR code synchronously when address is cached', () => {
    // Solana has one fixed address; Bitcoin-family addresses rotate and are never cached.
    mockGetCachedChainAddress.mockReturnValue(
      'ecash:cached_immediate_address_123',
    )
    mockRoute.value = {
      query: {},
      path: '/wallet/solana',
      // @ts-expect-error mock params
      params: { wallet: 'solana' },
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

    // Click navigates to the full AVU details page
    await unitRateBadge.trigger('click')
    expect(openPage).toHaveBeenCalledWith(expect.anything(), '/avu')

    // AVU balance line becomes visible when balance is loaded
    balance.loaded.value = true
    await nextTick()
    const balanceBadge = wrapper.get('[data-testid="wallet-balance-avu"]')
    expect(balanceBadge.attributes('role')).toBe('button')
    expect(balanceBadge.attributes('tabindex')).toBe('0')
    jest.mocked(openPage).mockClear()
    await balanceBadge.trigger('keydown', { key: 'Enter' })
    expect(openPage).toHaveBeenCalledWith(expect.anything(), '/avu')
    jest.mocked(openPage).mockClear()
    await unitRateBadge.trigger('keydown', { key: ' ' })
    expect(openPage).toHaveBeenCalledWith(expect.anything(), '/avu')
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
    expect(wrapper.find('[data-testid="wallet-tab-history"]').exists()).toBe(
      true,
    )
    expect(
      wrapper
        .get('[data-testid="wallet-history-panel"]')
        .find('[data-testid="wallet-tokens-card"]')
        .exists(),
    ).toBe(false)
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

    // Renaming lives in the main view and remains bound to the wallet opened in the dialog.
    await wrapper.get('[data-testid="wallet-rename-action"]').trigger('click')
    const rename = wrapper.getComponent(RenameWalletDialog)
    expect(rename.props('modelValue')).toBe(true)
    expect(rename.props('chain')).toBe('monad')
    expect(rename.props('defaultName')).toBe('walletPanel.mainWallet')
    mockRoute.value.path = '/wallet/ecash'
    mockRoute.value.query = {}
    await nextTick()
    rename.vm.$emit('save', 'Primary wallet')
    await flush()
    expect(useWalletNames().getCustomName('monad')).toBe('Primary wallet')
    expect(useWalletNames().getCustomName('ecash')).toBe('')
    await wrapper.get('[data-testid="wallet-rename-action"]').trigger('click')
    expect(rename.props('chain')).toBe('ecash')
    rename.vm.$emit('save', 'Coffee wallet')
    await flush()
    expect(wrapper.get('[data-testid="wallet-name-text"]').text()).toBe(
      'Coffee wallet',
    )
    rename.vm.$emit('reset')
    await flush()
    expect(wrapper.get('[data-testid="wallet-name-text"]').text()).toBe(
      'walletPanel.ecash',
    )

    wrapper.unmount()
  })
  it.each(
    [en, fr].flatMap(messages =>
      (['not-shared', 'failed', 'shared'] as const).map(
        sharing => [messages, sharing] as const,
      ),
    ),
  )(
    'lists paid native history from the reopened owner without financial effects, with its sharing state (%#)',
    async (messages, sharing) => {
      const fixture = await includedNativeTransfer()
      if (sharing === 'shared')
        for (const [index] of fixture.journal.list()[0]!.members.entries())
          await fixture.journal.markSyncApplied(fixture.operationId, index)
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
        nativeOperationSyncFailed: () => sharing === 'failed',
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
          translate('nativeOperation.included', { network: 'Monad Testnet' }),
        )
        expect(history.text()).toContain(fixture.hash)
        expect(history.text()).not.toContain(fixture.operationId)
        // Included reads as sent; the sharing state is a muted note in every case, and recovery
        // is not mentioned for a transfer that needs none.
        expect(translate('nativeOperation.included', { network: 'n' })).toMatch(
          /^(Sent on|Envoyé sur) n\.$/,
        )
        const sync = wrapper.get('[data-testid="wallet-native-operation-sync"]')
        expect(sync.text()).toBe(
          {
            'not-shared': messages.nativeOperation.syncNotShared,
            'failed': messages.nativeOperation.syncFailed,
            'shared': messages.nativeOperation.syncShared,
          }[sharing],
        )
        expect(sync.classes()).toEqual(
          expect.arrayContaining(['text-caption', 'text-grey-7']),
        )
        expect(history.text()).not.toContain(
          messages.nativeOperation.recoveryUnavailable,
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

  it('lists dated swaps in order, pins pending activity, keeps undated transfers explicit and combines shared transactions', async () => {
    const sharedHash = '0x' + '34'.repeat(32)
    const native: EvmNativeOperationStatus = {
      operationId: 'transfer',
      chainIdentifier: 'monad-testnet',
      kind: 'legacy',
      recipient: '0x' + '56'.repeat(20),
      intendedValueWei: '10000000000000000',
      payment: 'included',
      members: [],
      observedFeeWei: '0',
      feeCoverage: 'unknown',
      sharing: 'not-shared',
    }
    const contract: EvmNativeOperationStatus = {
      ...native,
      operationId: 'contract',
      kind: 'contract',
      intendedValueWei: '0',
      finalTransactionHash: sharedHash,
      members: [{ transactionHash: sharedHash, state: 'included-success' }],
    }
    const inspect = jest
      .spyOn(nativeTransfer, 'inspectNativeTransferOperations')
      .mockReturnValue({ status: 'available', operations: [native, contract] })
    const swap = (
      id: string,
      timestamp: number,
      status: SwapActivityRow['status'] = 'confirmed',
    ): SwapActivityRow => ({
      id,
      timestamp,
      status,
      chainIdentifier: 'monad-testnet',
      txHash: '0x' + '78'.repeat(32),
      fromAmount: '1',
      fromAsset: 'MON',
      toAmount: '2',
      toAsset: 'TOKEN',
      route: 'Exchange',
    })
    mockSwapRows.value = [
      swap('old', 100),
      { ...swap('shared', 300), txHash: sharedHash },
      swap('pending', 200, 'pending'),
      { ...swap('other-chain', 500), chainIdentifier: 'solana-devnet' },
    ]
    const wrapper = mountWallet()
    try {
      await flush()
      wrapper.vm.activeTab = 'history'
      await nextTick()
      const history = wrapper.get('[data-testid="wallet-history-panel"]')
      expect(
        history
          .findAll('[data-testid="wallet-activity-item"]')
          .map(row => row.attributes('data-activity-id')),
      ).toEqual(['swap:pending', 'swap:shared', 'swap:old', 'native:transfer'])
      expect(history.text()).toContain('walletPanel.historyPending')
      expect(history.text()).toContain('walletHistory.transfers')
      expect(
        history.findAll('[data-testid="wallet-native-operation"]'),
      ).toHaveLength(2)
      expect(
        history.find('[data-activity-id="native:contract"]').exists(),
      ).toBe(false)
      const summary = history.get(
        '[data-activity-id="native:transfer"] summary',
      )
      expect(summary.text()).toBe('walletHistory.details')
      expect(summary.classes()).toContain('wallet-history-action')
      expect(
        history.get('[data-activity-id="native:transfer"]').text(),
      ).toContain('0.01 MON')
      expect(
        history.get('[data-activity-id="swap:shared"] a').attributes('href'),
      ).toContain(sharedHash)
      expect(history.find('[data-testid="wallet-tokens-card"]').exists()).toBe(
        false,
      )
    } finally {
      inspect.mockRestore()
      wrapper.unmount()
    }
  })

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
      } else mockUseActiveWallet.mockResolvedValue(oldOwner)
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
        expect(mockUseActiveWallet).toHaveBeenCalledTimes(
          phase === 'visible' ? 3 : 2,
        )
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

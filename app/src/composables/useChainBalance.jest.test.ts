/** @jest-environment jsdom */
import { nextTick, reactive, ref } from 'vue'
import { shallowMount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useOracleStore } from '../stores/oracle'

const mockMonadBalance = {
  balance: ref<bigint | null>(1000n),
  formattedBalance: ref('10 MON'),
  loaded: ref(true),
  hasError: ref(false),
  refresh: jest.fn(),
}

jest.mock('./useBalance', () => ({
  useBalance: () => mockMonadBalance,
  APP_STATE_EVENT: 'frank:app-state',
  BALANCE_POLL_MS: 15000,
}))

const mockAccountStatus = reactive({
  status: 'ready',
  revision: 1,
})

const mockGetCachedChainAddress = jest.fn(
  (chain: string): string | undefined => {
    if (chain === 'solana')
      return '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
    return 'ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7'
  },
)
const mockGetChainAddress = jest.fn(async (chain: string) => {
  if (chain === 'solana') return '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  return 'ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7'
})

jest.mock('../accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: {
    getCachedChainAddress: (chain: string) => mockGetCachedChainAddress(chain),
    getChainAddress: (chain: string) => mockGetChainAddress(chain),
  },
}))

// The session's Bitcoin-family wallets: each reports the sum over all of its addresses.
const mockUtxoBalances: Record<string, jest.Mock> = {
  'xec-testnet': jest.fn().mockResolvedValue(1_000_000n),
  'btc-testnet': jest.fn().mockResolvedValue(150_000n),
  'bch-testnet': jest.fn().mockResolvedValue(0n),
}
const mockOpenUtxoWallet = jest.fn(async (chainIdentifier: string) => {
  const getBalance = mockUtxoBalances[chainIdentifier]
  if (!getBalance)
    throw new Error(`No wallet is available for ${chainIdentifier}`)
  const decimals = chainIdentifier === 'xec-testnet' ? 2 : 8
  return {
    chain: {
      unit:
        { 'xec-testnet': 'tXEC', 'btc-testnet': 'tBTC' }[chainIdentifier] ??
        'tBCH',
      toDisplayAmount: (value: bigint) =>
        (Number(value) / 10 ** decimals).toString(),
    },
    wallet: { getBalance },
  }
})
jest.mock('../accounts/utxo-wallets', () => ({
  openUtxoWallet: (chainIdentifier: string) =>
    mockOpenUtxoWallet(chainIdentifier),
}))

const mockFetchSolanaBalance = jest.fn().mockResolvedValue({
  lamports: 2_500_000_000n,
  formatted: '2.5 dSOL',
  unit: 'dSOL',
  networkId: 'solana-devnet',
})

const mockFetchSolanaTokenAccounts = jest.fn().mockResolvedValue([
  {
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'tUSDC',
    name: 'USD Coin (Devnet)',
    balanceRaw: 100000000n,
    decimals: 6,
    uiAmount: 100.0,
    formatted: '100.00 tUSDC',
    avuFormatted: '≈ 1,190.5 AVU',
  },
])

jest.mock('@frank/wallet/chain', () => ({
  // Preserve the real adapter and its change subscription; mock only this test's I/O.
  ...jest.requireActual('@frank/wallet/chain'),
  fetchSolanaBalance: (...args: unknown[]) => mockFetchSolanaBalance(...args),
  fetchSolanaTokenAccounts: (...args: unknown[]) =>
    mockFetchSolanaTokenAccounts(...args),
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: 'http://127.0.0.1:8098',
  }),
}))

// Keep this integration fixture on the display boundary; no custody, transport or price polling.
jest.mock('vue-router', () => ({
  useRoute: () => ({ path: '/wallet/solana', query: {} }),
  useRouter: () => ({ push: jest.fn() }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('src/composables/useSwapHistory', () => ({
  useSwapHistory: () => ({ getSwapsForChain: () => ref([]) }),
}))
jest.mock('src/utils/routes', () => ({ openPage: jest.fn() }))
jest.mock('src/utils/native-transfer', () => ({
  nativeSendChainIdentifier: () => 'solana-devnet',
}))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('quasar', () => ({ copyToClipboard: jest.fn() }))
jest.mock('src/components/wallet/AvuExplainerDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/wallet/AvuParityChart.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/wallet/DAppSwapView.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/wallet/RenameWalletDialog.vue', () => ({
  template: '<div />',
}))

import {
  useChainBalance,
  useMultichainBalance,
  fetchChainBalance,
  getChainTokens,
} from './useChainBalance'
import Wallet from '../pages/Wallet.vue'
import WalletPanel from '../components/panels/WalletPanel.vue'

describe('useChainBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccountStatus.status = 'ready'
  })

  it('does not invent a native Solana row before a successful observation', async () => {
    mockAccountStatus.status = 'loading'
    await fetchChainBalance('solana', true)
    expect(getChainTokens('solana')).toEqual([])
    mockAccountStatus.status = 'ready'
    mockFetchSolanaBalance.mockRejectedValueOnce(new Error('offline'))
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    await fetchChainBalance('solana', true)
    expect(getChainTokens('solana').filter(token => token.isNative)).toEqual([])
    expect(
      getChainTokens('solana').filter(token => !token.isNative),
    ).toHaveLength(1)
    error.mockRestore()
  })

  it.each(['ecash', 'solana'])(
    'shares truthful %s presentation through loading, errors, zero and nonzero',
    async chain => {
      mockAccountStatus.status = 'loading'
      await fetchChainBalance(chain, true)
      const detail = useChainBalance(chain)
      const drawer = useMultichainBalance()
      const expectPresentation = (expected: unknown) => {
        expect(detail.presentation.value).toEqual(expected)
        expect(drawer.getPresentation(chain)).toEqual(expected)
      }
      expectPresentation({ status: 'loading' })
      mockAccountStatus.status = 'ready'
      const fetchBalance =
        chain === 'ecash'
          ? mockUtxoBalances['xec-testnet']
          : mockFetchSolanaBalance
      const error = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      try {
        fetchBalance.mockRejectedValueOnce(new Error('offline'))
        await fetchChainBalance(chain, true)
        expectPresentation({
          status: 'unavailable',
          reason: 'fetch-error',
          lastKnown: undefined,
        })
        if (chain === 'solana')
          expect(detail.tokens.value.filter(token => token.isNative)).toEqual(
            [],
          )
        for (const amount of [0n, 25n]) {
          const formattedBalance =
            chain === 'ecash'
              ? `${Number(amount) / 100} tXEC`
              : `${amount} dSOL`
          fetchBalance.mockResolvedValueOnce(
            chain === 'ecash'
              ? amount
              : { lamports: amount, formatted: formattedBalance },
          )
          await fetchChainBalance(chain, true)
          const observation = { balance: amount, formattedBalance }
          expectPresentation({ status: 'available', observation })
          if (chain === 'solana')
            expect(detail.tokens.value[0].balanceFormatted).toBe(
              formattedBalance,
            )
          fetchBalance.mockRejectedValueOnce(new Error('offline'))
          await fetchChainBalance(chain, true)
          expectPresentation({
            status: 'unavailable',
            reason: 'fetch-error',
            lastKnown: observation,
          })
        }
      } finally {
        error.mockRestore()
      }
    },
  )

  // Bitcoin and Bitcoin Cash now have wallets (tested below); these rows still have none.
  it.each(['dogecoin', 'ethereum', 'unknown'])(
    'reports unsupported %s without Monad funds in either view',
    chain => {
      const expected = { status: 'unavailable', reason: 'unsupported' }
      expect(useChainBalance(chain).presentation.value).toEqual(expected)
      expect(useMultichainBalance().getPresentation(chain)).toEqual(expected)
    },
  )

  it('delegates to useBalance for monad', () => {
    const { formattedBalance, loaded } = useChainBalance('monad')
    expect(formattedBalance.value).toBe('10 MON')
    expect(loaded.value).toBe(true)
  })

  it('reads a Bitcoin-family balance from the session wallet for that chain', async () => {
    await fetchChainBalance('ecash', true)
    expect(mockOpenUtxoWallet).toHaveBeenCalledWith('xec-testnet')

    const { formattedBalance, loaded, balance, presentation } =
      useChainBalance('ecash')
    expect(loaded.value).toBe(true)
    expect(balance.value).toBe(1_000_000n)
    expect(formattedBalance.value).toBe('10000 tXEC')
    expect(presentation.value.status).toBe('available')
  })

  it('routes Bitcoin and Bitcoin Cash by the registry, with no list of names', async () => {
    await fetchChainBalance('bitcoin', true)
    await fetchChainBalance('bitcoincash', true)
    expect(mockOpenUtxoWallet).toHaveBeenCalledWith('btc-testnet')
    expect(mockOpenUtxoWallet).toHaveBeenCalledWith('bch-testnet')
    expect(useChainBalance('bitcoin').formattedBalance.value).toBe(
      '0.0015 tBTC',
    )
    const cash = useChainBalance('bitcoincash')
    expect(cash.balance.value).toBe(0n)
    expect(cash.presentation.value).toMatchObject({ status: 'available' })
  })

  it.each(['dogecoin', 'ethereum', 'tempo', 'hyperliquid', 'nonsense'])(
    'says %s is unsupported and opens no wallet for it',
    async chain => {
      mockOpenUtxoWallet.mockClear()
      await fetchChainBalance(chain, true)
      expect(mockOpenUtxoWallet).not.toHaveBeenCalled()
      expect(useChainBalance(chain).presentation.value).toEqual({
        status: 'unavailable',
        reason: 'unsupported',
      })
    },
  )

  it('fetches solana balance and makes it reactive', async () => {
    await fetchChainBalance('solana', true)
    expect(mockFetchSolanaBalance).toHaveBeenCalledWith({
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      networkId: 'solana-devnet',
      relayBaseUrl: 'http://127.0.0.1:8098',
    })

    const { formattedBalance, loaded, balance, tokens } =
      useChainBalance('solana')
    expect(loaded.value).toBe(true)
    expect(balance.value).toBe(2_500_000_000n)
    expect(formattedBalance.value).toBe('2.5 dSOL')
    expect(tokens.value).toHaveLength(2)
    expect(tokens.value[0].symbol).toBe('dSOL')
    expect(tokens.value[1].symbol).toBe('tUSDC')
    expect(tokens.value[1].balanceFormatted).toBe('100.00 tUSDC')
  })

  it('provides multichain helper methods', async () => {
    await fetchChainBalance('ecash', true)
    await fetchChainBalance('solana', true)
    const { getFormattedBalance, isChainLoaded, getTokens } =
      useMultichainBalance()
    expect(getFormattedBalance('monad')).toBe('10 MON')
    expect(getFormattedBalance('ecash')).toBe('10000 tXEC')
    expect(getFormattedBalance('solana')).toBe('2.5 dSOL')
    expect(isChainLoaded('ecash')).toBe(true)
    expect(isChainLoaded('solana')).toBe(true)
    expect(getTokens('solana')).toHaveLength(2)
  })

  it('handles fetch error gracefully', async () => {
    mockUtxoBalances['xec-testnet'].mockRejectedValueOnce(
      new Error('Network error'),
    )
    await fetchChainBalance('ecash', true)

    const { hasError } = useChainBalance('ecash')
    expect(hasError.value).toBe(true)

    mockFetchSolanaBalance.mockRejectedValueOnce(new Error('Solana error'))
    await fetchChainBalance('solana', true)

    const solanaBalance = useChainBalance('solana')
    expect(solanaBalance.hasError.value).toBe(true)
  })
})

describe('independent Solana observations', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((done, fail) => {
      resolve = done
      reject = fail
    })
    return { promise, resolve, reject }
  }
  const token = {
    mint: 'mint-A',
    symbol: 'A',
    name: 'Token A',
    balanceRaw: 50n,
    decimals: 0,
    uiAmount: 50,
    formatted: '50 A',
    avuFormatted: '',
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    mockAccountStatus.status = 'loading'
    await fetchChainBalance('solana', true)
    mockAccountStatus.status = 'ready'
  })

  afterEach(() => {
    jest.requireMock('@frank/wallet/chain').activeChain.isTestnet = true
  })

  it('keeps native symbol on the published observation scope until a new network read', async () => {
    await fetchChainBalance('solana', true)
    expect(getChainTokens('solana')[0].symbol).toBe('dSOL')
    jest.requireMock('@frank/wallet/chain').activeChain.isTestnet = false
    expect(getChainTokens('solana')[0].symbol).toBe('dSOL')
    mockFetchSolanaBalance.mockResolvedValueOnce({
      lamports: 1n,
      formatted: '0.000000001 SOL',
    })
    await fetchChainBalance('solana', true)
    expect(getChainTokens('solana')[0].symbol).toBe('SOL')
    expect(getChainTokens('solana')[0].balanceFormatted).toBe('0.000000001 SOL')
  })

  it('publishes native success while token accounts are still loading', async () => {
    const tokenRead = deferred<(typeof token)[]>()
    mockFetchSolanaTokenAccounts.mockReturnValueOnce(tokenRead.promise)
    const refresh = fetchChainBalance('solana', true)
    await flushPromises()
    try {
      expect(useChainBalance('solana').balance.value).toBe(2_500_000_000n)
    } finally {
      tokenRead.resolve([])
      await refresh
    }
  })

  it('publishes token success while native SOL is still loading', async () => {
    const native = deferred<{ lamports: bigint; formatted: string }>()
    mockFetchSolanaBalance.mockReturnValueOnce(native.promise)
    mockFetchSolanaTokenAccounts.mockResolvedValueOnce([token])
    const refresh = fetchChainBalance('solana', true)
    await flushPromises()
    try {
      expect(useChainBalance('solana').balance.value).toBeNull()
      expect(getChainTokens('solana').map(t => t.id)).toEqual(['mint-A'])
    } finally {
      native.resolve({ lamports: 7n, formatted: '7 SOL' })
      await refresh
    }
  })

  it('ignores old read failures after a newer successful refresh', async () => {
    const native = deferred<{ lamports: bigint; formatted: string }>()
    const tokens = deferred<(typeof token)[]>()
    mockFetchSolanaBalance.mockReturnValueOnce(native.promise)
    mockFetchSolanaTokenAccounts.mockReturnValueOnce(tokens.promise)
    const oldRefresh = fetchChainBalance('solana', true)
    mockFetchSolanaTokenAccounts.mockResolvedValueOnce([token])
    await fetchChainBalance('solana', true)
    native.reject(new Error('obsolete native failure'))
    tokens.reject(new Error('obsolete token failure'))
    await oldRefresh
    expect(useChainBalance('solana').hasError.value).toBe(false)
    expect(useChainBalance('solana').tokenObservation.value?.status).toBe(
      'available',
    )
    expect(
      getChainTokens('solana')
        .filter(t => !t.isNative)
        .map(t => t.id),
    ).toEqual(['mint-A'])
  })

  it('preserves known tokens after failure and clears them only on successful emptiness', async () => {
    mockFetchSolanaTokenAccounts.mockResolvedValueOnce([token])
    await fetchChainBalance('solana', true)
    mockFetchSolanaTokenAccounts.mockRejectedValueOnce(new Error('offline'))
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      await fetchChainBalance('solana', true)
      expect(
        getChainTokens('solana')
          .filter(t => !t.isNative)
          .map(t => t.id),
      ).toEqual(['mint-A'])
      mockFetchSolanaTokenAccounts.mockResolvedValueOnce([])
      await fetchChainBalance('solana', true)
      expect(getChainTokens('solana').filter(t => !t.isNative)).toEqual([])
    } finally {
      error.mockRestore()
    }
  })

  it('keeps the latest read pending when an older forced refresh finishes', async () => {
    const oldNative = deferred<{ lamports: bigint; formatted: string }>()
    const oldTokens = deferred<(typeof token)[]>()
    const newNative = deferred<{ lamports: bigint; formatted: string }>()
    const newTokens = deferred<(typeof token)[]>()
    mockFetchSolanaBalance
      .mockReturnValueOnce(oldNative.promise)
      .mockReturnValueOnce(newNative.promise)
    mockFetchSolanaTokenAccounts
      .mockReturnValueOnce(oldTokens.promise)
      .mockReturnValueOnce(newTokens.promise)
    const older = fetchChainBalance('solana', true)
    const newer = fetchChainBalance('solana', true)
    oldNative.resolve({ lamports: 1n, formatted: 'old SOL' })
    oldTokens.resolve([])
    await older
    try {
      await fetchChainBalance('solana')
      expect(mockFetchSolanaBalance).toHaveBeenCalledTimes(2)
      expect(mockFetchSolanaTokenAccounts).toHaveBeenCalledTimes(2)
    } finally {
      newNative.resolve({ lamports: 7n, formatted: 'new SOL' })
      newTokens.resolve([])
      await newer
    }
  })

  it('does not start obsolete reads after delayed account address acquisition', async () => {
    const address = deferred<string>()
    mockGetCachedChainAddress.mockReturnValueOnce(undefined)
    mockGetChainAddress.mockReturnValueOnce(address.promise)
    const oldRefresh = fetchChainBalance('solana', true)
    mockAccountStatus.revision++
    await fetchChainBalance('solana', true)
    address.resolve('old-account-address')
    await oldRefresh
    expect(mockFetchSolanaBalance).toHaveBeenCalledTimes(1)
    expect(mockFetchSolanaTokenAccounts).toHaveBeenCalledTimes(1)
    expect(useChainBalance('solana').balance.value).toBe(2_500_000_000n)
  })

  it.each(['account', 'network', 'unavailable'])(
    'ignores completion after %s changes without a replacement request',
    async change => {
      const native = deferred<{ lamports: bigint; formatted: string }>()
      const tokens = deferred<(typeof token)[]>()
      mockFetchSolanaBalance.mockReturnValueOnce(native.promise)
      mockFetchSolanaTokenAccounts.mockReturnValueOnce(tokens.promise)
      const refresh = fetchChainBalance('solana', true)
      if (change === 'account') mockAccountStatus.revision++
      if (change === 'network')
        jest.requireMock('@frank/wallet/chain').activeChain.isTestnet = false
      if (change === 'unavailable') mockAccountStatus.status = 'unavailable'
      native.resolve({ lamports: 1n, formatted: 'old SOL' })
      tokens.resolve([token])
      await refresh
      expect(useChainBalance('solana').balance.value).toBeNull()
      expect(getChainTokens('solana')).toEqual([])
    },
  )

  it.each(['request', 'account', 'network'])(
    'rejects old native and token responses after a newer %s observation',
    async change => {
      const oldNative = deferred<{ lamports: bigint; formatted: string }>()
      const oldTokens = deferred<(typeof token)[]>()
      mockFetchSolanaBalance.mockReturnValueOnce(oldNative.promise)
      mockFetchSolanaTokenAccounts.mockReturnValueOnce(oldTokens.promise)
      const oldRefresh = fetchChainBalance('solana', true)
      if (change === 'account') mockAccountStatus.revision++
      if (change === 'network')
        jest.requireMock('@frank/wallet/chain').activeChain.isTestnet = false
      mockFetchSolanaBalance.mockResolvedValueOnce({
        lamports: 7n,
        formatted: '7 SOL',
      })
      mockFetchSolanaTokenAccounts.mockResolvedValueOnce([
        { ...token, mint: 'new-mint' },
      ])
      await fetchChainBalance('solana', true)
      oldNative.resolve({ lamports: 1n, formatted: 'old SOL' })
      oldTokens.resolve([{ ...token, mint: 'old-mint' }])
      await oldRefresh
      expect(useChainBalance('solana').balance.value).toBe(7n)
      expect(
        getChainTokens('solana')
          .filter(t => !t.isNative)
          .map(t => t.id),
      ).toEqual(['new-mint'])
      jest.requireMock('@frank/wallet/chain').activeChain.isTestnet = true
    },
  )
})

function mountSolanaViews(pinia: ReturnType<typeof createPinia>) {
  const global = {
    plugins: [pinia],
    mocks: { $t: (key: string) => key },
    directives: { ripple: {} },
    stubs: {
      QTooltip: true,
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
          'q-icon',
          'q-list',
          'q-item',
          'q-item-section',
          'q-item-label',
          'q-avatar',
        ].map(name => [name, { template: '<div><slot /></div>' }]),
      ),
    },
  }
  const detail = shallowMount(Wallet, { global })
  const drawer = shallowMount(WalletPanel, { global })
  return { detail, drawer }
}

describe('native Solana AVU presentation', () => {
  it('keeps header, asset row and drawer on the reactive oracle snapshot', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const oracle = useOracleStore()
    jest
      .spyOn(oracle, 'startBackgroundWorker')
      .mockImplementation(() => undefined)
    oracle.snapshot.rates.solana = 37
    await fetchChainBalance('solana', true)

    const { detail, drawer } = mountSolanaViews(pinia)
    try {
      await flushPromises()
      expect(detail.get('[data-testid="wallet-chain"]').text()).toBe(
        'Solana Devnet',
      )
      expect(drawer.get('[data-test="solana-wallet-chain"]').text()).toBe(
        'Solana Devnet',
      )
      expect(detail.get('[data-testid="wallet-balance"]').text()).toBe(
        '2.5 dSOL',
      )
      expect(drawer.get('[data-test="solana-wallet-balance"]').text()).toBe(
        '2.5 dSOL',
      )
      const expectAgreement = (expected: string) => {
        expect(oracle.formatAvuAmount('solana', 2_500_000_000n)).toBe(expected)
        expect(detail.get('[data-testid="wallet-balance-avu"]').text()).toBe(
          expected,
        )
        expect(
          detail
            .get(
              '[data-testid="wallet-token-item-dsol"] .text-grey-7.text-right',
            )
            .text(),
        ).toBe(expected)
        expect(drawer.get('[data-test="solana-wallet-avu"]').text()).toBe(
          `· ${expected}`,
        )
        expect(drawer.get('[data-test="subtoken-dsol"]').text()).toContain(
          `(${expected})`,
        )
      }
      expectAgreement('≈ 92.50 AVU')
      oracle.snapshot = {
        ...oracle.snapshot,
        rates: { ...oracle.snapshot.rates, solana: 83 },
      }
      await nextTick()
      expectAgreement('≈ 207.50 AVU')
      // SPL rows keep their existing independently supplied valuation.
      expect(getChainTokens('solana')[1].avuFormatted).toBe('≈ 1,190.5 AVU')
    } finally {
      detail.unmount()
      drawer.unmount()
      oracle.stopBackgroundWorker()
      setActivePinia(undefined)
    }
  })
})

describe('Solana token availability in both views', () => {
  it.each(['loading', 'unavailable'])(
    'shows one SPL holding while native SOL is %s and retains it after token failure',
    async nativeStatus => {
      mockAccountStatus.status = 'loading'
      await fetchChainBalance('solana', true)
      mockAccountStatus.status = 'ready'
      const pinia = createPinia()
      setActivePinia(pinia)
      const oracle = useOracleStore()
      jest
        .spyOn(oracle, 'startBackgroundWorker')
        .mockImplementation(() => undefined)
      const error = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      let resolveNative!: (value: {
        lamports: bigint
        formatted: string
      }) => void
      const nativeRead = new Promise<{ lamports: bigint; formatted: string }>(
        resolve => {
          resolveNative = resolve
        },
      )
      if (nativeStatus === 'loading')
        mockFetchSolanaBalance.mockReturnValueOnce(nativeRead)
      else
        mockFetchSolanaBalance.mockRejectedValueOnce(
          new Error('native offline'),
        )
      const { detail, drawer } = mountSolanaViews(pinia)
      try {
        await flushPromises()
        expect(useChainBalance('solana').presentation.value.status).toBe(
          nativeStatus,
        )
        expect(getChainTokens('solana')).toHaveLength(1)
        expect(getChainTokens('solana')[0].isNative).toBe(false)
        expect(
          detail.get('[data-testid="wallet-token-item-tusdc"]').text(),
        ).toContain('100.00 tUSDC')
        expect(drawer.get('[data-test="subtoken-tusdc"]').text()).toContain(
          '100.00 tUSDC',
        )
        expect(drawer.find('[data-test="solana-token-status"]').exists()).toBe(
          false,
        )

        mockFetchSolanaBalance.mockRejectedValueOnce(
          new Error('native still offline'),
        )
        mockFetchSolanaTokenAccounts.mockRejectedValueOnce(
          new Error('tokens offline'),
        )
        await fetchChainBalance('solana', true)
        await nextTick()
        expect(getChainTokens('solana')).toHaveLength(1)
        expect(drawer.get('[data-test="subtoken-tusdc"]').text()).toContain(
          '100.00 tUSDC',
        )
        expect(drawer.get('[data-test="solana-token-status"]').text()).toBe(
          'walletPanel.tokenBalancesStale',
        )
        expect(detail.get('[data-testid="wallet-token-status"]').text()).toBe(
          'walletPanel.tokenBalancesStale',
        )
      } finally {
        resolveNative({ lamports: 0n, formatted: '0 dSOL' })
        await flushPromises()
        detail.unmount()
        drawer.unmount()
        oracle.stopBackgroundWorker()
        setActivePinia(undefined)
        error.mockRestore()
      }
    },
  )

  it('shows unknown, recovery and stale tokens independently from native SOL', async () => {
    mockAccountStatus.status = 'loading'
    await fetchChainBalance('solana', true)
    mockAccountStatus.status = 'ready'
    const pinia = createPinia()
    setActivePinia(pinia)
    const oracle = useOracleStore()
    jest
      .spyOn(oracle, 'startBackgroundWorker')
      .mockImplementation(() => undefined)
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    let rejectTokens!: (error: Error) => void
    mockFetchSolanaTokenAccounts.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectTokens = reject
      }),
    )
    const { detail, drawer } = mountSolanaViews(pinia)
    try {
      await flushPromises()
      expect(detail.get('[data-testid="wallet-token-status"]').text()).toBe(
        'walletPanel.tokenBalancesLoading',
      )
      expect(drawer.get('[data-test="solana-token-status"]').text()).toBe(
        'walletPanel.tokenBalancesLoading',
      )
      expect(detail.get('[data-testid="wallet-balance"]').text()).toBe(
        '2.5 dSOL',
      )
      rejectTokens(new Error('offline'))
      await flushPromises()
      expect(detail.get('[data-testid="wallet-token-status"]').text()).toBe(
        'walletPanel.tokenBalancesUnavailable',
      )
      expect(drawer.get('[data-test="solana-token-status"]').text()).toBe(
        'walletPanel.tokenBalancesUnavailable',
      )
      expect(
        detail.get('[data-testid="wallet-send-action"]').attributes('disabled'),
      ).toBeUndefined()
      expect(useChainBalance('solana').tokenObservation.value).toEqual({
        status: 'unavailable',
        lastKnown: undefined,
      })

      mockFetchSolanaTokenAccounts.mockResolvedValueOnce([
        {
          mint: 'known-mint',
          symbol: 'TEST',
          name: 'Test token',
          balanceRaw: 50n,
          decimals: 0,
          uiAmount: 50,
          formatted: '50 TEST',
          avuFormatted: '',
        },
      ])
      await fetchChainBalance('solana', true)
      await nextTick()
      expect(detail.find('[data-testid="wallet-token-status"]').exists()).toBe(
        false,
      )
      expect(drawer.find('[data-test="solana-token-status"]').exists()).toBe(
        false,
      )
      expect(
        detail.get('[data-testid="wallet-token-item-test"]').text(),
      ).toContain('50 TEST')

      mockFetchSolanaBalance.mockResolvedValueOnce({
        lamports: 3_000_000_000n,
        formatted: '3 dSOL',
      })
      mockFetchSolanaTokenAccounts.mockRejectedValueOnce(
        new Error('offline again'),
      )
      await fetchChainBalance('solana', true)
      await nextTick()
      expect(detail.get('[data-testid="wallet-balance"]').text()).toBe('3 dSOL')
      expect(
        detail.get('[data-testid="wallet-token-item-test"]').text(),
      ).toContain('50 TEST')
      expect(drawer.get('[data-test="subtoken-test"]').text()).toContain(
        '50 TEST',
      )
      expect(detail.get('[data-testid="wallet-token-status"]').text()).toBe(
        'walletPanel.tokenBalancesStale',
      )
      expect(drawer.get('[data-test="solana-token-status"]').text()).toBe(
        'walletPanel.tokenBalancesStale',
      )
      expect(
        detail.get('[data-testid="wallet-send-action"]').attributes('disabled'),
      ).toBeUndefined()

      mockFetchSolanaTokenAccounts.mockResolvedValueOnce([])
      await fetchChainBalance('solana', true)
      await nextTick()
      expect(
        detail.find('[data-testid="wallet-token-item-test"]').exists(),
      ).toBe(false)
      expect(drawer.find('[data-test="subtoken-test"]').exists()).toBe(false)
      expect(detail.find('[data-testid="wallet-token-status"]').exists()).toBe(
        false,
      )
      expect(useChainBalance('solana').tokenObservation.value).toEqual({
        status: 'available',
        tokens: [],
      })
    } finally {
      rejectTokens(new Error('fixture cleanup'))
      await flushPromises()
      detail.unmount()
      drawer.unmount()
      oracle.stopBackgroundWorker()
      setActivePinia(undefined)
      error.mockRestore()
    }
  })
})

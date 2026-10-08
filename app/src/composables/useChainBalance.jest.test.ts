/** @jest-environment jsdom */
import { ref } from 'vue'

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

const mockAccountStatus = {
  status: 'ready',
  revision: 1,
}

const mockGetCachedChainAddress = jest.fn((chain: string) => {
  if (chain === 'solana') return '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  return 'ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7'
})
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

const mockFetchEcashBalance = jest.fn().mockResolvedValue({
  sats: 1_000_000n,
  formatted: '10000 tXEC',
  unit: 'tXEC',
  networkId: 'xec-testnet',
})

const mockFetchSolanaBalance = jest.fn().mockResolvedValue({
  lamports: 2_500_000_000n,
  formatted: '2.5 tSOL',
  unit: 'tSOL',
  networkId: 'solana-devnet',
})

jest.mock('@frank/wallet/chain', () => ({
  activeChain: { isTestnet: true },
  fetchEcashBalance: (...args: unknown[]) => mockFetchEcashBalance(...args),
  fetchSolanaBalance: (...args: unknown[]) => mockFetchSolanaBalance(...args),
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: 'http://127.0.0.1:8098',
  }),
}))

import {
  useChainBalance,
  useMultichainBalance,
  fetchChainBalance,
} from './useChainBalance'

describe('useChainBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccountStatus.status = 'ready'
  })

  it('delegates to useBalance for monad', () => {
    const { formattedBalance, loaded } = useChainBalance('monad')
    expect(formattedBalance.value).toBe('10 MON')
    expect(loaded.value).toBe(true)
  })

  it('fetches ecash balance and makes it reactive', async () => {
    await fetchChainBalance('ecash', true)
    expect(mockFetchEcashBalance).toHaveBeenCalledWith({
      address: 'ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7',
      networkId: 'xec-testnet',
      relayBaseUrl: 'http://127.0.0.1:8098',
    })

    const { formattedBalance, loaded, balance } = useChainBalance('ecash')
    expect(loaded.value).toBe(true)
    expect(balance.value).toBe(1_000_000n)
    expect(formattedBalance.value).toBe('10000 tXEC')
  })

  it('fetches solana balance and makes it reactive', async () => {
    await fetchChainBalance('solana', true)
    expect(mockFetchSolanaBalance).toHaveBeenCalledWith({
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      networkId: 'solana-devnet',
      relayBaseUrl: 'http://127.0.0.1:8098',
    })

    const { formattedBalance, loaded, balance } = useChainBalance('solana')
    expect(loaded.value).toBe(true)
    expect(balance.value).toBe(2_500_000_000n)
    expect(formattedBalance.value).toBe('2.5 tSOL')
  })

  it('provides multichain helper methods', async () => {
    await fetchChainBalance('ecash', true)
    await fetchChainBalance('solana', true)
    const { getFormattedBalance, isChainLoaded } = useMultichainBalance()
    expect(getFormattedBalance('monad')).toBe('10 MON')
    expect(getFormattedBalance('ecash')).toBe('10000 tXEC')
    expect(getFormattedBalance('solana')).toBe('2.5 tSOL')
    expect(isChainLoaded('ecash')).toBe(true)
    expect(isChainLoaded('solana')).toBe(true)
  })

  it('handles fetch error gracefully', async () => {
    mockFetchEcashBalance.mockRejectedValueOnce(new Error('Network error'))
    await fetchChainBalance('ecash', true)

    const { hasError } = useChainBalance('ecash')
    expect(hasError.value).toBe(true)

    mockFetchSolanaBalance.mockRejectedValueOnce(new Error('Solana error'))
    await fetchChainBalance('solana', true)

    const solanaBalance = useChainBalance('solana')
    expect(solanaBalance.hasError.value).toBe(true)
  })
})

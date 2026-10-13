import { activeChain } from '@frank/wallet/chain'
import { configuredStealthAssets, nativeDecimals } from './configured-assets'

const mockContext = jest.fn()
jest.mock('../accounts/native-transfer', () => ({
  createNativeTransferContext: (chain: string) => mockContext(chain),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { chainIdentifier: 'monad-testnet', isTestnet: true },
}))
const scales: Record<string, number> = {
  'monad-testnet': 18,
  'monad-regtest': 18,
  'btc-testnet': 8,
  'bch-testnet': 8,
  'xec-testnet': 2,
  'solana-devnet': 9,
}
beforeEach(() => {
  activeChain.chainIdentifier = 'monad-testnet'
  mockContext.mockReset().mockImplementation(async chain => {
    if (!(chain in scales))
      throw new Error(`Unsupported configured test chain ${chain}`)
    return { chain: { fromDisplayAmount: () => 10n ** BigInt(scales[chain]) } }
  })
})
test('native and token options preserve canonical networks and independent denominations', async () => {
  const { options } = await configuredStealthAssets()
  for (const [chainIdentifier, decimals] of Object.entries(scales).filter(
    ([chain]) => chain !== 'monad-regtest',
  )) {
    expect(options).toContainEqual(
      expect.objectContaining({
        chainIdentifier,
        asset: { kind: 'native' },
        decimals,
        nativeDecimals: decimals,
      }),
    )
  }
  const usdc = options.find(
    option =>
      option.chainIdentifier === 'monad-testnet' && option.unit === 'USDC',
  )
  expect(usdc).toEqual(
    expect.objectContaining({
      decimals: 6,
      nativeDecimals: 18,
      nativeUnit: 'MONT',
      asset: expect.objectContaining({ kind: 'erc20' }),
    }),
  )
  expect(options.every(option => option.balanceAtomic === undefined)).toBe(true)
  expect(mockContext).not.toHaveBeenCalled()
})
test('configured regtest retains its identity instead of silently selecting public testnet', async () => {
  activeChain.chainIdentifier = 'monad-regtest'
  const { options } = await configuredStealthAssets()
  expect(options).toContainEqual(
    expect.objectContaining({ chainIdentifier: 'monad-regtest', unit: 'MONR' }),
  )
  expect(
    options.some(option => option.chainIdentifier === 'monad-testnet'),
  ).toBe(false)
})
test('asset listing never opens custody and retains supported assets during RPC failures', async () => {
  mockContext.mockRejectedValue(new Error('Chronik unavailable'))
  const result = await configuredStealthAssets()
  expect(result.unavailable).toEqual([])
  expect(result.options).toContainEqual(
    expect.objectContaining({
      chainIdentifier: 'xec-testnet',
      decimals: 2,
      unit: 'tXEC',
    }),
  )
  expect(mockContext).not.toHaveBeenCalled()
})
test('populates active balance when provided in context', async () => {
  const result = await configuredStealthAssets({
    activeBalance: 21699700000000000000n,
  })
  const mont = result.options.find(
    o => o.chainIdentifier === 'monad-testnet' && o.asset.kind === 'native',
  )
  expect(mont?.balanceAtomic).toBe(21699700000000000000n)
  const txec = result.options.find(
    o => o.chainIdentifier === 'xec-testnet' && o.asset.kind === 'native',
  )
  expect(txec?.balanceAtomic).toBeUndefined()
})

test('invalid adapter denominations fail instead of being guessed from a ticker', () => {
  expect(nativeDecimals(() => 1n)).toBe(0)
  expect(nativeDecimals(() => 100n)).toBe(2)
  expect(() => nativeDecimals(() => 12n)).toThrow('denomination')
})

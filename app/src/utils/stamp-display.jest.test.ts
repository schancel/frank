// The composer's stamp pill: the stamp's AVU value comes from the oracle's one AVU helper,
// for the asset the canonical registry says prices the chain; nothing when it cannot.
import { stampAvu, stampMultiplierText } from './stamp-display'

const valued: Array<[string, bigint]> = []
let mockStaleAgeMs: number | undefined
jest.mock('src/stores/oracle', () => ({
  useSafeOracleStore: () => ({
    getAvu: (asset: string, raw: bigint) => {
      valued.push([asset, raw])
      return asset === 'monad' ? 0.05 : 0
    },
    formatAvuAmount: () => '≈ 50 mAVU · testnet',
    valueStaleAgeMs: () => mockStaleAgeMs,
  }),
}))

const evm = (chainIdentifier: string, decimals = 18) => ({
  chainIdentifier,
  fromDisplayAmount: (amount: string) =>
    BigInt(amount) * 10n ** BigInt(decimals),
})

beforeEach(() => {
  valued.length = 0
  mockStaleAgeMs = undefined
})

describe('stampAvu', () => {
  it('values the stamp as the registry asset of the canonical chain', () => {
    expect(stampAvu(evm('monad-testnet'), 468_800_000_000_000_000n)).toEqual({
      figure: '≈ 50 mAVU',
      line: '≈ 50 mAVU · testnet',
      stale: false,
    })
    expect(valued).toEqual([['monad', 468_800_000_000_000_000n]])
  })

  it('says when the value behind it is stale', () => {
    mockStaleAgeMs = 45 * 60_000
    expect(stampAvu(evm('monad-testnet'), 10n ** 17n)?.stale).toBe(true)
  })

  it('is nothing for a free, unparsed, or unvaluable stamp', () => {
    expect(stampAvu(evm('monad-testnet'), 0n)).toBeUndefined()
    expect(stampAvu(evm('monad-testnet'), undefined)).toBeUndefined()
    expect(stampAvu(evm('no-such-chain'), 10n)).toBeUndefined()
    expect(valued).toEqual([])
  })

  it('does not value an amount whose base unit is not the asset’s', () => {
    expect(stampAvu(evm('monad-testnet', 6), 10n ** 6n)).toBeUndefined()
    expect(valued).toEqual([])
  })

  it('is nothing when there is no rate', () => {
    expect(stampAvu(evm('solana-devnet', 9), 10n ** 9n)).toBeUndefined()
  })
})

describe('stampMultiplierText', () => {
  it('is the multiple of the default, marked when rounded', () => {
    expect(stampMultiplierText(20n, 10n)).toBe('2')
    expect(stampMultiplierText(10n, 10n)).toBe('1')
    expect(stampMultiplierText(10511n, 10000n)).toBe('1.0511')
    expect(stampMultiplierText(105111n, 100000n)).toBe('≈1.0511')
  })

  it('is empty without both amounts or for a free stamp', () => {
    expect(stampMultiplierText(0n, 10n)).toBe('')
    expect(stampMultiplierText(undefined, 10n)).toBe('')
    expect(stampMultiplierText(10n, 0n)).toBe('')
    expect(stampMultiplierText(10n, undefined)).toBe('')
  })
})

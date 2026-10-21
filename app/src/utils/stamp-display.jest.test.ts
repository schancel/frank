// The composer's stamp pill: the stamp's AVU value comes from the oracle's one AVU helper,
// for the asset the canonical registry says prices the chain; nothing when it cannot.
import { formatStampAvu, stampMultiplierText } from './stamp-display'

const valued: Array<[string, bigint]> = []
jest.mock('src/stores/oracle', () => ({
  useSafeOracleStore: () => ({
    formatAvuAmount: (asset: string, raw: bigint) => {
      valued.push([asset, raw])
      return asset === 'monad' ? '≈ 52.3 mAVU · testnet' : ''
    },
  }),
}))

const evm = (chainIdentifier: string, decimals = 18) => ({
  chainIdentifier,
  fromDisplayAmount: (amount: string) =>
    BigInt(amount) * 10n ** BigInt(decimals),
})

beforeEach(() => {
  valued.length = 0
})

describe('formatStampAvu', () => {
  it('values the stamp as the registry asset of the canonical chain', () => {
    expect(formatStampAvu(evm('monad-testnet'), 468_800_000_000_000_000n)).toBe(
      '≈ 52.3 mAVU · testnet',
    )
    expect(valued).toEqual([['monad', 468_800_000_000_000_000n]])
  })

  it('is empty for a free, unparsed, or unvaluable stamp', () => {
    expect(formatStampAvu(evm('monad-testnet'), 0n)).toBe('')
    expect(formatStampAvu(evm('monad-testnet'), undefined)).toBe('')
    expect(formatStampAvu(evm('no-such-chain'), 10n)).toBe('')
    expect(valued).toEqual([])
  })

  it('does not value an amount whose base unit is not the asset’s', () => {
    expect(formatStampAvu(evm('monad-testnet', 6), 10n ** 6n)).toBe('')
    expect(valued).toEqual([])
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

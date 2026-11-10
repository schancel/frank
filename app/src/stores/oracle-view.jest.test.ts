import {
  computeOracleRates,
  createStampDefaultResolver,
  stampPolicyConfig,
  unavailableOracleRates,
  type OracleRates,
} from '@frank/wallet/oracle'
import { testFeed } from './oracle-test-feed'
import {
  MAX_ORACLE_VIEW_BYTES,
  retainOracleView,
  validateOracleView,
} from './oracle-view'

const NOW = 2_000_000_000
const observed = () =>
  computeOracleRates(
    testFeed([NOW], {
      prices: { 'monad-mainnet': 0.025 },
      electricity: [[NOW, 0.2]],
    }),
    NOW,
  )

it('owns a bounded snapshot with real fee-coverage and timestamp provenance', () => {
  const value = observed()
  const restored = validateOracleView(value, NOW)
  expect(restored).toStrictEqual(value)
  expect(restored).not.toBe(value)
  expect(restored.avuHash).not.toBe(value.avuHash)
})

it.each([
  [
    'nonfinite rate',
    (view: OracleRates) => {
      view.rates.monad = Infinity
    },
  ],
  [
    'negative rate',
    (view: OracleRates) => {
      view.rates.monad = -1
    },
  ],
  [
    'future price',
    (view: OracleRates) => {
      view.priceAt.monad = NOW + 1
    },
  ],
  [
    'missing price provenance',
    (view: OracleRates) => {
      delete view.priceAt.monad
    },
  ],
  [
    'wrong hash basis',
    (view: OracleRates) => {
      view.avuHash!.kwhPerValue *= 2
    },
  ],
  [
    'future hash',
    (view: OracleRates) => {
      view.avuHash!.oldestInputAt = NOW + 1
    },
  ],
  [
    'missing fee coverage',
    (view: OracleRates) => {
      Reflect.deleteProperty(view.avuHash!.entries[0], 'feesIncluded')
    },
  ],
  [
    'contradictory spot',
    (view: OracleRates) => {
      view.avuSpot.unavailable = 'no-data'
    },
  ],
  [
    'unknown asset',
    (view: OracleRates) => {
      Object.assign(view.rates, { unknown: 2 })
    },
  ],
  [
    'oversized labels',
    (view: OracleRates) => {
      view.avuHash!.entries[0].label = 'x'.repeat(MAX_ORACLE_VIEW_BYTES)
    },
  ],
] as const)(
  'rejects %s without trusting a corrupted view',
  (_label, change) => {
    const view = observed()
    change(view)
    expect(() => validateOracleView(view, NOW)).toThrow(
      'Invalid retained oracle valuation',
    )
  },
)

it('requires at least one valid historical valuation for capture', () => {
  expect(() => validateOracleView(unavailableOracleRates(NOW), NOW)).toThrow()
})

it('does not expose held-stale data as a fresh stamp quote and preserves configured fallback', async () => {
  const previous = observed()
  const held = retainOracleView(
    unavailableOracleRates(NOW + 1),
    previous,
    NOW + 1,
  )
  expect(held.at).toBe(previous.at)
  expect(held.priceAt).toEqual(previous.priceAt)
  expect(held.avuHash!.oldestInputAt).toBe(previous.avuHash!.oldestInputAt)
  const options = {
    chainIdentifier: 'monad-testnet',
    asset: 'monad' as const,
    supportsDirectMessages: true,
    baseUnitsPerCoin: 10n ** 18n,
    config: stampPolicyConfig(),
    getRates: () => held,
    now: () => (NOW + 1) * 1000,
  }
  const context = { chainIdentifier: 'monad-testnet', minimumStamp: 1n }
  expect(await createStampDefaultResolver(options)(context)).toMatchObject({
    status: 'unavailable',
    reason: 'stale-rate',
  })
  expect(
    await createStampDefaultResolver({ ...options, fallbackStamp: 1000n })(
      context,
    ),
  ).toMatchObject({
    status: 'available',
    amount: 1000n,
    pricingBasis: 'configured-fallback',
  })
})

it('honors an explicitly stale asset price independently of hash age or zero elapsed time', () => {
  const view = observed()
  view.priceStale.monad = true
  const held = retainOracleView(view, undefined, NOW)
  expect(held.priceStale.monad).toBe(true)
  expect(held.priceAt.monad).toBe(NOW)
  expect(held.avuHash!.stale).toBe(false)
})

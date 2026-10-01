import { formatMon } from './monad-amount'

describe('formatMon', () => {
  it.each([
    [0n, '0.0 MON'],
    [5n * 10n ** 14n, '0.0005 MON'],
    [10n ** 16n, '0.01 MON'],
    [10n ** 18n, '1.0 MON'],
    [1_234_500_000_000_000_000n, '1.2345 MON'],
    [1n, '0.000000000000000001 MON'],
  ])('%s wei -> %s', (wei, text) => {
    expect(formatMon(wei)).toBe(text)
  })
})

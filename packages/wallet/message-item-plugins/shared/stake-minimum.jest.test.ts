import { evmPaymentFloorWei } from '../../chain/payment-floor'
import { STAKE_FLOOR_MULTIPLE, stakeAllowed, stakeMinimumWei } from './stake-minimum'

/** One stake rule for the bots and the app's game cards: twice the payment floor. */
describe('the smallest stake', () => {
  // eth_gasPrice on solonet and Monad testnet, 2026-10-25.
  const floor = evmPaymentFloorWei(102_000_000_000n) // 0.02142

  test('is twice the payment floor: 0.04284 at 102 gwei, what the blackjack bot states', () => {
    expect(STAKE_FLOOR_MULTIPLE).toBe(2n)
    expect(stakeMinimumWei(floor)).toBe(42_840_000_000_000_000n)
  })

  test('a configured minimum above it wins; one below it does not', () => {
    expect(stakeMinimumWei(floor, 10n ** 17n)).toBe(10n ** 17n)
    expect(stakeMinimumWei(floor, 10n ** 16n)).toBe(2n * floor)
  })

  test('the old fixed 0.01 stake is below it; a free game is always allowed', () => {
    const minimum = stakeMinimumWei(floor)
    expect(stakeAllowed(10n ** 16n, minimum)).toBe(false)
    expect(stakeAllowed(0n, minimum)).toBe(true)
    expect(stakeAllowed(minimum, minimum)).toBe(true)
  })

  test('an unknown floor states no minimum, and a negative one is refused', () => {
    expect(stakeMinimumWei(0n)).toBe(0n)
    expect(() => stakeMinimumWei(-1n)).toThrow(RangeError)
  })
})

import {
  computeGeometricRadixChangeSplits,
  orderOfMagnitude2,
} from './evm-change-distribution'

describe('transaction-set source change', () => {
  afterEach(() => jest.restoreAllMocks())

  it('keeps the final residual outside the source payment magnitude while conserving every fee', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.01)
    const values = computeGeometricRadixChangeSplits({
      totalAvailableWei: 21n,
      recipientAmountWei: 4n,
      dustThresholdWei: 2n,
      minFeePerTxWei: 1n,
    })
    expect(values.length).toBeGreaterThan(1)
    expect(
      values.every(value => orderOfMagnitude2(value) !== orderOfMagnitude2(4n)),
    ).toBe(true)
    expect(values.every(value => value >= 2n)).toBe(true)
    expect(values.reduce((sum, value) => sum + value + 1n, 0n)).toBe(21n)
  })
})

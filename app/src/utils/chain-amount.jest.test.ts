import { parseEther, formatEther } from 'ethers'

import {
  displayToSafeRawAmount,
  formatSafeRawAmount,
  rawToSafeNumber,
} from './chain-amount'

const monad = {
  unit: 'MON',
  fromDisplayAmount: parseEther,
  toDisplayAmount: formatEther,
}

describe('forum chain amount adapter', () => {
  it('converts the default topic amount between MON and raw wei', () => {
    expect(displayToSafeRawAmount(monad, '0.000001')).toBe(1_000_000_000_000)
    expect(formatSafeRawAmount(monad, 1_000_000_000_000)).toBe('0.000001 MON')
  })

  it('rejects a display amount that the temporary number-backed model cannot represent', () => {
    expect(() => displayToSafeRawAmount(monad, '0.01')).toThrow(
      "exceeds the forum's current exact-value limit",
    )
  })

  it('rejects a raw default that the temporary number-backed model cannot represent', () => {
    expect(() => rawToSafeNumber(monad, 10_000_000_000_000_000n)).toThrow(
      "exceeds the forum's current exact-value limit",
    )
  })
})

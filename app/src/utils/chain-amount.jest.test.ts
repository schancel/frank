import { parseEther, formatEther } from 'ethers'
import {
  displayToRawAmount,
  formatRawAmount,
  formatCompactAmount,
} from './chain-amount'
const monad = {
  unit: 'MON',
  fromDisplayAmount: parseEther,
  toDisplayAmount: formatEther,
}
it('preserves amounts beyond double precision through parsing and display', () => {
  expect(displayToRawAmount(monad, '0.010000000000000001')).toBe(
    10000000000000001n,
  )
  expect(formatRawAmount(monad, '10000000000000001')).toBe(
    '0.010000000000000001 MON',
  )
})
it('formats signed 256-bit weights and zero exactly', () => {
  const weight = -(2n ** 255n - 1n)
  expect(formatRawAmount(monad, weight.toString())).toBe(
    `${formatEther(weight)} MON`,
  )
  expect(formatRawAmount(monad, '0')).toBe('0.0 MON')
})

describe('formatCompactAmount with dynamic SI prefixes', () => {
  it('formats zero compactly as 0 unit', () => {
    expect(formatCompactAmount(monad, '0')).toBe('0 MON')
    expect(formatCompactAmount(monad, 0n)).toBe('0 MON')
  })

  it('formats micro amounts (10^-6 MON / 10^12 wei) as μMON', () => {
    expect(formatCompactAmount(monad, '1000000000000')).toBe('1 μMON')
    expect(formatCompactAmount(monad, '2500000000000')).toBe('2.5 μMON')
    expect(formatCompactAmount(monad, '-1000000000000')).toBe('-1 μMON')
  })

  it('formats milli amounts (10^-3 MON / 10^15 wei) as mMON', () => {
    expect(formatCompactAmount(monad, '1000000000000000')).toBe('1 mMON')
    expect(formatCompactAmount(monad, '1250000000000000')).toBe('1.25 mMON')
  })

  it('formats base amounts (1 MON / 10^18 wei) as MON', () => {
    expect(formatCompactAmount(monad, parseEther('1').toString())).toBe('1 MON')
    expect(formatCompactAmount(monad, parseEther('5.5').toString())).toBe('5.5 MON')
  })

  it('formats kilo and mega amounts as kMON and MMON', () => {
    expect(formatCompactAmount(monad, (parseEther('1000')).toString())).toBe('1 kMON')
    expect(formatCompactAmount(monad, (parseEther('1200')).toString())).toBe('1.2 kMON')
    expect(formatCompactAmount(monad, (parseEther('2500000')).toString())).toBe('2.5 MMON')
  })

  it('formats nano and pico amounts below micro scale', () => {
    expect(formatCompactAmount(monad, '1000000000')).toBe('1 nMON')
    expect(formatCompactAmount(monad, '1000000')).toBe('1 pMON')
    expect(formatCompactAmount(monad, '1000')).toBe('1 fMON')
    expect(formatCompactAmount(monad, '5')).toBe('5 aMON')
  })
})


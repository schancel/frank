import { parseEther, formatEther } from 'ethers'
import {
  displayToRawAmount,
  formatRawAmount,
  compactAmountText,
  formatCompactAmount,
  formatDisplayAmount,
  formatDisplayNumber,
  shortenDisplayAmount,
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
    expect(formatCompactAmount(monad, parseEther('5.5').toString())).toBe(
      '5.5 MON',
    )
  })

  it('formats kilo and mega amounts as kMON and MMON', () => {
    expect(formatCompactAmount(monad, parseEther('1000').toString())).toBe(
      '1 kMON',
    )
    expect(formatCompactAmount(monad, parseEther('1200').toString())).toBe(
      '1.2 kMON',
    )
    expect(formatCompactAmount(monad, parseEther('2500000').toString())).toBe(
      '2.5 MMON',
    )
  })

  it('formats nano and pico amounts below micro scale', () => {
    expect(formatCompactAmount(monad, '1000000000')).toBe('1 nMON')
    expect(formatCompactAmount(monad, '1000000')).toBe('1 pMON')
    expect(formatCompactAmount(monad, '1000')).toBe('1 fMON')
    expect(formatCompactAmount(monad, '5')).toBe('5 aMON')
  })
})

describe('formatDisplayAmount, the one formatter for amounts a user reads', () => {
  const wei = (display: string) => parseEther(display)

  it('reads zero as "0"', () => {
    expect(formatDisplayAmount(monad, 0n)).toBe('0 MON')
    expect(formatDisplayAmount(monad, '0')).toBe('0 MON')
  })

  it('never shows a non-zero amount as zero, down to one wei', () => {
    expect(formatDisplayAmount(monad, 1n)).toBe('0.000000000000000001 MON')
    expect(formatDisplayAmount(monad, wei('0.000001'))).toBe('0.000001 MON')
    expect(formatDisplayAmount(monad, wei('0.0000012345678'))).toBe(
      '0.000001234 MON',
    )
  })

  it('drops trailing zeros and the decimal point of whole amounts', () => {
    expect(formatDisplayAmount(monad, wei('1'))).toBe('1 MON')
    expect(formatDisplayAmount(monad, wei('1234.5'))).toBe('1234.5 MON')
    expect(formatDisplayAmount(monad, wei('0.02'))).toBe('0.02 MON')
    expect(formatDisplayAmount(monad, wei('0.10'))).toBe('0.1 MON')
  })

  it('shortens 18-decimal amounts: four significant digits below one, four decimals above', () => {
    expect(formatDisplayAmount(monad, wei('0.86192379322624184'))).toBe(
      '0.8619 MON',
    )
    expect(formatDisplayAmount(monad, wei('0.01414213562373095'))).toBe(
      '0.01414 MON',
    )
    expect(formatDisplayAmount(monad, wei('12.345678901234567891'))).toBe(
      '12.3456 MON',
    )
    expect(formatDisplayAmount(monad, wei('1.000000000000000001'))).toBe(
      '1 MON',
    )
  })

  it('cuts digits and never rounds up, so a balance is not shown larger than it is', () => {
    expect(formatDisplayAmount(monad, wei('0.99999999'))).toBe('0.9999 MON')
    expect(formatDisplayAmount(monad, wei('1.99999999'))).toBe('1.9999 MON')
    expect(formatDisplayAmount(monad, wei('0.000099999'))).toBe(
      '0.00009999 MON',
    )
  })

  it('keeps every integer digit of very large amounts', () => {
    expect(
      formatDisplayAmount(monad, wei('123456789012345678901234.567891')),
    ).toBe('123456789012345678901234.5678 MON')
    expect(formatDisplayAmount(monad, 2n ** 255n)).toBe(
      '57896044618658097711785492504343953926634992332820282019728.792 MON',
    )
  })

  it('keeps the sign of a negative amount', () => {
    expect(formatDisplayAmount(monad, -wei('0.01414213562373095'))).toBe(
      '-0.01414 MON',
    )
  })

  it('works for a chain with two decimals and for one with none', () => {
    const xec = {
      unit: 'XEC',
      toDisplayAmount: (raw: bigint) =>
        `${raw / 100n}.${(raw % 100n).toString().padStart(2, '0')}`,
    }
    expect(formatDisplayAmount(xec, 123456n)).toBe('1234.56 XEC')
    expect(formatDisplayAmount(xec, 5n)).toBe('0.05 XEC')
    const units = { unit: 'U', toDisplayAmount: (raw: bigint) => `${raw}` }
    expect(formatDisplayAmount(units, 42n)).toBe('42 U')
  })

  it('gives the bare number for a caller that places the unit itself', () => {
    expect(formatDisplayNumber(monad, wei('0.86192379322624184'))).toBe(
      '0.8619',
    )
  })

  it('does not change the exact formatter a title or detail view uses', () => {
    expect(formatRawAmount(monad, wei('0.86192379322624184'))).toBe(
      '0.86192379322624184 MON',
    )
  })

  it('returns text that is not a plain decimal number unchanged', () => {
    expect(shortenDisplayAmount('1e-7')).toBe('1e-7')
    expect(shortenDisplayAmount('n/a')).toBe('n/a')
    expect(shortenDisplayAmount('0.0')).toBe('0')
    expect(shortenDisplayAmount('-0.0')).toBe('0')
    expect(shortenDisplayAmount('007.5')).toBe('7.5')
  })
})

describe('compactAmountText (amount text from a balance observation)', () => {
  it('formats kilo eCash as ktXEC and kXEC to save space', () => {
    expect(compactAmountText('10000 tXEC')).toBe('10 ktXEC')
    expect(compactAmountText('10000 XEC')).toBe('10 kXEC')
    expect(compactAmountText('25500 tXEC')).toBe('25.5 ktXEC')
  })

  it('formats mega balances with M prefix', () => {
    expect(compactAmountText('1000000 XEC')).toBe('1 MXEC')
    expect(compactAmountText('2500000 tXEC')).toBe('2.5 MtXEC')
  })

  it('formats standard balances with trimmed decimals (max 4)', () => {
    expect(compactAmountText('4.72734053 MONT')).toBe('4.7273 MONT')
    expect(compactAmountText('1.500000 MON')).toBe('1.5 MON')
    expect(compactAmountText('10 MON')).toBe('10 MON')
  })

  it('handles zero balances gracefully', () => {
    expect(compactAmountText('0 tSOL')).toBe('0 tSOL')
    expect(compactAmountText('0 tXEC')).toBe('0 tXEC')
    expect(compactAmountText('0')).toBe('0')
  })

  it('formats small balances with milli and micro metric prefixes', () => {
    expect(compactAmountText('0.005 MONT')).toBe('5 mMONT')
    expect(compactAmountText('0.000025 MONT')).toBe('25 μMONT')
  })

  it('preserves loading and status text as-is', () => {
    expect(compactAmountText('Loading balance…')).toBe(
      'Loading balance…',
    )
    expect(compactAmountText('Balance unavailable')).toBe(
      'Balance unavailable',
    )
    expect(compactAmountText('')).toBe('')
  })
})

describe('the compact and the full form agree', () => {
  it('cut the same digits of one amount, never rounding up', () => {
    // 0.0227199... : the full form keeps 0.02271, the compact form 22.71 m: the same digits.
    const raw = 22_719_999_999_999_999n
    expect(formatDisplayAmount(monad, raw)).toBe('0.02271 MON')
    expect(formatCompactAmount(monad, raw)).toBe('22.71 mMON')
    expect(compactAmountText('0.022719999999999999 MON')).toBe('22.71 mMON')
    // The old list rule rounded 0.08849 up to "88.5 m" beside "0.0884" elsewhere.
    expect(compactAmountText('0.08849 MONT')).toBe('88.49 mMONT')
    expect(formatDisplayAmount(monad, parseEther('0.08849'))).toBe('0.08849 MON')
  })

  it('never shows a non-zero amount as zero and keeps exact prefix boundaries', () => {
    expect(formatCompactAmount(monad, 1n)).toBe('1 aMON')
    expect(formatCompactAmount(monad, parseEther('0.001'))).toBe('1 mMON')
    expect(formatCompactAmount(monad, parseEther('0.000999'))).toBe('999 μMON')
    expect(formatCompactAmount(monad, parseEther('999.99999'))).toBe(
      '999.9999 MON',
    )
    expect(formatCompactAmount(monad, parseEther('1000'))).toBe('1 kMON')
    expect(formatCompactAmount(monad, parseEther('-0.0125'))).toBe('-12.5 mMON')
  })
})

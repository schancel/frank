import { formatAvu } from './avu-units'

describe('formatAvu', () => {
  it('writes an AVU figure in the app’s compact amount style', () => {
    expect(formatAvu(92.5)).toBe('92.5 AVU')
    expect(formatAvu(1100)).toBe('1.1 kAVU')
    expect(formatAvu(2_500_000)).toBe('2.5 MAVU')
    expect(formatAvu(0.1875)).toBe('187.5 mAVU')
    expect(formatAvu(0.000025)).toBe('25 μAVU')
  })

  it('is empty, not "0 AVU", for nothing or an unknown value', () => {
    expect(formatAvu(0)).toBe('')
    expect(formatAvu(-3)).toBe('')
    expect(formatAvu(Number.NaN)).toBe('')
    expect(formatAvu(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('never writes an exponent, however large or small the value', () => {
    for (const value of [7.9e11, 3e21, 1.2e-7, 4e-12]) {
      expect(formatAvu(value)).not.toMatch(/e[+-]?\d/i)
      expect(formatAvu(value)).toMatch(/AVU$/)
    }
  })
})

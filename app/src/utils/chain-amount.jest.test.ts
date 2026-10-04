import { parseEther, formatEther } from 'ethers'
import { displayToRawAmount, formatRawAmount } from './chain-amount'
const monad = { unit: 'MON', fromDisplayAmount: parseEther, toDisplayAmount: formatEther }
it('preserves amounts beyond double precision through parsing and display', () => {
  expect(displayToRawAmount(monad, '0.010000000000000001')).toBe(10000000000000001n)
  expect(formatRawAmount(monad, '10000000000000001')).toBe('0.010000000000000001 MON')
})
it('formats signed 256-bit weights and zero exactly', () => {
  const weight = -(2n ** 255n - 1n)
  expect(formatRawAmount(monad, weight.toString())).toBe(`${formatEther(weight)} MON`)
  expect(formatRawAmount(monad, '0')).toBe('0.0 MON')
})

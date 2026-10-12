import {
  parseStealthAmount,
  formatStealthAmount,
  stealthAssetKey,
} from './options'
test('decimal parsing and presentation retain exact atomic values beyond Number precision', () => {
  const atomic = 9007199254740993000001n
  expect(parseStealthAmount('9007199254740993.000001', 6)).toBe(atomic)
  expect(formatStealthAmount(atomic, 6)).toBe('9007199254740993.000001')
  expect(formatStealthAmount(1n, 18)).toBe('0.000000000000000001')
  expect(parseStealthAmount('0.001', 2)).toBeUndefined()
  expect(parseStealthAmount('1e6', 6)).toBeUndefined()
  expect(parseStealthAmount('1', -1)).toBeUndefined()
})
test('canonical asset keys distinguish native and token positions on each chain', () => {
  expect(stealthAssetKey('xec-testnet', { kind: 'native' })).toBe(
    'xec-testnet:native',
  )
  expect(
    stealthAssetKey('monad-testnet', {
      kind: 'erc20',
      contractAddress: '0xAbC',
    }),
  ).toBe('monad-testnet:erc20:0xabc')
})

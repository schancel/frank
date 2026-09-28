import { activeChain } from '@frank/wallet/chain'
import { parseNativeTransferInput } from './native-transfer'

describe('parseNativeTransferInput', () => {
  it('returns a canonical Monad recipient and wei value', () => {
    expect(
      parseNativeTransferInput(
        activeChain,
        ' 0x000000000000000000000000000000000000dead ',
        '1.5',
      ),
    ).toEqual({
      recipient: { raw: '0x000000000000000000000000000000000000dEaD' },
      value: 1_500_000_000_000_000_000n,
    })
  })

  it.each([
    ['not an address', '1'],
    ['0x000000000000000000000000000000000000dead', ''],
    ['0x000000000000000000000000000000000000dead', '0'],
    ['0x000000000000000000000000000000000000dead', '-1'],
    ['0x000000000000000000000000000000000000dead', 'not a number'],
  ])('rejects invalid input (%s, %s)', (address, amount) => {
    expect(
      parseNativeTransferInput(activeChain, address, amount),
    ).toBeUndefined()
  })
})

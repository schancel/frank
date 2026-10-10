import { activeChain } from '@frank/wallet/chain'
import {
  nativeSendChainIdentifier,
  parseNativeTransferInput,
} from './native-transfer'

it.each([
  ['solana', true, 'solana-devnet'],
  ['solana', false, 'solana-mainnet'],
  ['solana-devnet', false, 'solana-devnet'],
  ['unknown', true, undefined],
  ['monad', true, 'monad-testnet'],
  // Receive only: the registry offers a wallet but not Send.
  ['ecash', true, undefined],
  ['bitcoin', true, undefined],
  ['bitcoincash', true, undefined],
  // No wallet at all.
  ['dogecoin', true, undefined],
  ['ethereum', true, undefined],
  ['tempo', true, undefined],
  ['hyperliquid', true, undefined],
  ['bitcoin', false, undefined],
])(
  'resolves the selected native Send network %s (%s)',
  (wallet, testnet, expected) => {
    expect(nativeSendChainIdentifier(wallet, testnet)).toBe(expected)
  },
)

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

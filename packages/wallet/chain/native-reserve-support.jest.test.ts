import { EcashWallet } from '../ecash-wallet'
import { UtxoWallet } from '../utxo-wallet'
import { SolanaWallet } from '../solana-wallet'

// The shared option must fail at the family boundary, before custody, state or network effects.
// These prototypes deliberately have no instance dependencies available to accidentally use.
test.each([
  ['eCash', EcashWallet.prototype.sendNative],
  ['Bitcoin', UtxoWallet.prototype.sendNative],
  ['Solana', SolanaWallet.prototype.sendNative],
] as const)(
  '%s explicitly rejects an unsupported native reserve constraint',
  async (_family, send) => {
    await expect(
      send.call({} as never, {
        recipient: { raw: 'unused' },
        value: 1n,
        minimumRemainingBalance: 0n,
      }),
    ).rejects.toThrow('Minimum native reserve is unsupported')
  },
)

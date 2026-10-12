import {
  activeChain,
  getActiveChain,
  setActiveChain,
} from '@frank/wallet/chain'
import { walletNetworkMetadata, walletSupport } from './wallet-support'
import { getWalletNetworkLabel, WALLET_CONFIGS } from './wallet-configs'
import { nativeSendChainIdentifier } from './native-transfer'

it.each([
  ['monad-regtest', 'MONR'],
  ['monad-testnet', 'MONT'],
  ['monad-mainnet', 'MON'],
])(
  'resolves the primary alias from configured canonical %s, not its testnet flag',
  (id, unit) => {
    const original = getActiveChain()
    try {
      setActiveChain({
        ...activeChain,
        chainIdentifier: id,
        isTestnet: id !== 'monad-mainnet',
      })
      expect(walletNetworkMetadata('monad', activeChain.isTestnet!)?.id).toBe(
        id,
      )
      expect(walletSupport('monad', activeChain.isTestnet!).entry?.unit).toBe(
        unit,
      )
      expect(nativeSendChainIdentifier('monad', activeChain.isTestnet!)).toBe(
        id,
      )
      // Explicit canonical IDs are never redirected to the configured network.
      expect(walletNetworkMetadata('monad-testnet', true)?.id).toBe(
        'monad-testnet',
      )
      expect(nativeSendChainIdentifier('monad-testnet', true)).toBe(
        'monad-testnet',
      )
      if (id === 'monad-regtest') {
        expect(getWalletNetworkLabel(WALLET_CONFIGS[0], true, key => key)).toBe(
          'Monad Regtest',
        )
      }
    } finally {
      setActiveChain(original)
    }
  },
)

it('keeps peer families canonical and fails unknown configuration without guessing a network', () => {
  expect(walletNetworkMetadata('solana', true, 'monad-regtest')?.id).toBe(
    'solana-devnet',
  )
  expect(walletNetworkMetadata('ecash', true, 'monad-regtest')?.id).toBe(
    'xec-testnet',
  )
  expect(
    walletNetworkMetadata('unknown', true, 'monad-regtest'),
  ).toBeUndefined()
  expect(walletNetworkMetadata('monad', true, 'unknown')).toBeUndefined()
  expect(walletNetworkMetadata('solana-devnet', false, 'unknown')?.id).toBe(
    'solana-devnet',
  )
})

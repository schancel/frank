import enUs from '../i18n/en-us'
import frFr from '../i18n/fr-fr'
import {
  DEFAULT_NETWORK_TAG,
  hasTransactionExplorer,
  transactionExplorerUrl,
  multiChainExplorerUrl,
  hasMultiChainExplorer,
} from './explorer'

describe('Monad transaction explorer configuration', () => {
  it('uses Monadscan testnet for the default MONT NetworkTag', () => {
    expect(DEFAULT_NETWORK_TAG).toBe('MONT')
    expect(transactionExplorerUrl('0xabc/def')).toBe(
      'https://testnet.monadscan.com/tx/0xabc%2Fdef',
    )
  })

  it('rejects a network without an explicitly configured explorer', () => {
    expect(() => transactionExplorerUrl('0xabc', 'MON1')).toThrow(
      'No transaction explorer configured for NetworkTag MON1',
    )
  })

  it('detects local RPC chain and handles explorer links gracefully', () => {
    // When forced local or targeting local stack
    expect(
      transactionExplorerUrl('0x71f8b14d', 'MONT', { isLocal: true }),
    ).toBeUndefined()
    expect(
      transactionExplorerUrl('0x71f8b14d', 'MONT', { rpcChain: 'local-stack' }),
    ).toBeUndefined()
    expect(
      transactionExplorerUrl('0x71f8b14d', 'MONT', { rpcChain: 'chain-shim' }),
    ).toBeUndefined()
    expect(
      transactionExplorerUrl('0x71f8b14d', 'MONT', {
        relayBaseUrl: 'http://127.0.0.1:18545',
      }),
    ).toBeUndefined()

    // hasTransactionExplorer returns false on local chain without custom explorer
    expect(hasTransactionExplorer('MONT', { isLocal: true })).toBe(false)
    expect(hasTransactionExplorer('MONT', { isLocal: false })).toBe(true)

    // When a custom local explorer URL is provided
    expect(
      transactionExplorerUrl('0x71f8b14d', 'MONT', {
        isLocal: true,
        localExplorerUrl: 'http://127.0.0.1:3000/tx',
      }),
    ).toBe('http://127.0.0.1:3000/tx/0x71f8b14d')
    expect(
      hasTransactionExplorer('MONT', {
        isLocal: true,
        localExplorerUrl: 'http://127.0.0.1:3000/tx',
      }),
    ).toBe(true)
  })
})

describe('Multi-chain transaction explorer configuration', () => {
  it('generates correct explorer URLs for Monad, Solana, and eCash', () => {
    // Monad
    expect(multiChainExplorerUrl('0x123', 'MONT')).toBe(
      'https://testnet.monadscan.com/tx/0x123',
    )
    expect(multiChainExplorerUrl('0x123', 'monad-testnet')).toBe(
      'https://testnet.monadscan.com/tx/0x123',
    )
    expect(multiChainExplorerUrl('0x123', 'MON1')).toBe(
      'https://monadscan.com/tx/0x123',
    )
    expect(multiChainExplorerUrl('0x123', 'monad-mainnet')).toBe(
      'https://monadscan.com/tx/0x123',
    )

    // Solana
    expect(multiChainExplorerUrl('sig5abc', 'SOLD')).toBe(
      'https://explorer.solana.com/tx/sig5abc?cluster=devnet',
    )
    expect(multiChainExplorerUrl('sig5abc', 'solana-devnet')).toBe(
      'https://explorer.solana.com/tx/sig5abc?cluster=devnet',
    )
    expect(multiChainExplorerUrl('sig5abc', 'SOL1')).toBe(
      'https://explorer.solana.com/tx/sig5abc',
    )
    expect(multiChainExplorerUrl('sig5abc', 'solana-mainnet')).toBe(
      'https://explorer.solana.com/tx/sig5abc',
    )

    // eCash
    expect(multiChainExplorerUrl('ecash123', 'XECT')).toBe(
      'https://testnet.blockchair.com/ecash/transaction/ecash123',
    )
    expect(multiChainExplorerUrl('ecash123', 'ecash-testnet')).toBe(
      'https://testnet.blockchair.com/ecash/transaction/ecash123',
    )
    expect(multiChainExplorerUrl('ecash123', 'XEC1')).toBe(
      'https://blockchair.com/ecash/transaction/ecash123',
    )
    expect(multiChainExplorerUrl('ecash123', 'ecash-mainnet')).toBe(
      'https://blockchair.com/ecash/transaction/ecash123',
    )
  })

  it('safely returns undefined for unknown network without throwing', () => {
    expect(multiChainExplorerUrl('0x123', 'UNKNOWN')).toBeUndefined()
    expect(hasMultiChainExplorer('UNKNOWN')).toBe(false)
  })
})

describe('standard Monad wallet labels', () => {
  it('keeps send and receive available without Lotus branding', () => {
    expect(enUs.SettingPanel.sendMonad).toBe('Send MON')
    expect(enUs.SettingPanel.receiveMonad).toBe('Receive MON')
    expect(frFr.SettingPanel.sendMonad).toBe('Envoyer des MON')
    expect(frFr.SettingPanel.receiveMonad).toBe('Recevoir des MON')
    expect(frFr.sendAddressDialog.enterAmount).toBe(
      'Saisissez le montant (MON)',
    )
  })
})

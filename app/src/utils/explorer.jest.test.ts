import enUs from '../i18n/en-us'
import frFr from '../i18n/fr-fr'
import {
  DEFAULT_NETWORK_TAG,
  hasTransactionExplorer,
  transactionExplorerUrl,
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
    expect(transactionExplorerUrl('0x71f8b14d', 'MONT', { isLocal: true })).toBeUndefined()
    expect(transactionExplorerUrl('0x71f8b14d', 'MONT', { rpcChain: 'local-stack' })).toBeUndefined()
    expect(transactionExplorerUrl('0x71f8b14d', 'MONT', { rpcChain: 'chain-shim' })).toBeUndefined()
    expect(transactionExplorerUrl('0x71f8b14d', 'MONT', { relayBaseUrl: 'http://127.0.0.1:18545' })).toBeUndefined()

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

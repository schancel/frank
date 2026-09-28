import enUs from '../i18n/en-us'
import frFr from '../i18n/fr-fr'
import { DEFAULT_NETWORK_TAG, transactionExplorerUrl } from './explorer'

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

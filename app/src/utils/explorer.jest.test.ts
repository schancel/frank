import enUs from '../i18n/en-us'
import frFr from '../i18n/fr-fr'
import protocol from '../../../docs/protocol/chains/v1.json'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'
import { transactionExplorerUrl } from './explorer'

describe('transaction explorer links', () => {
  it("opens each network's own explorer, by canonical identifier", () => {
    expect(transactionExplorerUrl('0xabc/def', 'monad-testnet')).toBe(
      'https://testnet.monadscan.com/tx/0xabc%2Fdef',
    )
    expect(transactionExplorerUrl('0x123', 'monad-mainnet')).toBe(
      'https://monadscan.com/tx/0x123',
    )
    expect(transactionExplorerUrl('sig5', 'solana-devnet')).toBe(
      'https://explorer.solana.com/tx/sig5?cluster=devnet',
    )
    expect(transactionExplorerUrl('sig5', 'solana-testnet')).toBe(
      'https://explorer.solana.com/tx/sig5?cluster=testnet',
    )
    expect(transactionExplorerUrl('ab', 'btc-testnet')).toBe(
      'https://mempool.space/testnet/tx/ab',
    )
    expect(transactionExplorerUrl('0x1', 'ethereum-sepolia')).toBe(
      'https://sepolia.etherscan.io/tx/0x1',
    )
  })

  it('gives a regtest network no link, never another network explorer', () => {
    expect(transactionExplorerUrl('0x123', 'monad-regtest')).toBeUndefined()
    expect(transactionExplorerUrl('0x123', 'xec-regtest')).toBeUndefined()
  })

  it('gives no link for an alias, an unknown network or no network', () => {
    // Network tags and family names are not network keys.
    expect(transactionExplorerUrl('0x123', 'MONT')).toBeUndefined()
    expect(transactionExplorerUrl('0x123', 'monad')).toBeUndefined()
    expect(transactionExplorerUrl('0x123', 'ecash-testnet')).toBeUndefined()
    expect(transactionExplorerUrl('0x123', 'UNKNOWN')).toBeUndefined()
    expect(transactionExplorerUrl('0x123', 'toString')).toBeUndefined()
    expect(transactionExplorerUrl('0x123', undefined)).toBeUndefined()
    expect(transactionExplorerUrl('', 'monad-testnet')).toBeUndefined()
  })

  it('configures explorers only for protocol networks, each with the placeholder', () => {
    const ids = new Set(protocol.chains.map(chain => chain.id))
    for (const [id, entry] of Object.entries(PROTOCOL_CHAINS)) {
      expect(ids.has(id)).toBe(true)
      if (entry.transactionExplorerUrl === undefined) continue
      expect(entry.transactionExplorerUrl).toMatch(
        /^https:\/\/[^{}]+\{transaction\}[^{}]*$/,
      )
      // A regtest chain is a private local network: no public explorer indexes it.
      expect(entry.network).not.toBe('regtest')
    }
  })
})

describe('standard Monad wallet labels', () => {
  it('keeps send and receive available without Lotus branding', () => {
    expect(enUs.SettingPanel.sendMonad).toBe('Send MON')
    expect(enUs.SettingPanel.receiveMonad).toBe('Receive MON')
    expect(frFr.SettingPanel.sendMonad).toBe('Envoyer des MON')
    expect(frFr.SettingPanel.receiveMonad).toBe('Recevoir des MON')
    expect(frFr.sendAddressDialog.enterAmount).toBe(
      'Saisissez le montant ({unit})',
    )
  })
})

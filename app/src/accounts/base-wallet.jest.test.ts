import { UnsupportedBaseChainError } from '@frank/wallet/chain/base-chain'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import {
  BASE_CHAIN_SETTING,
  mainBalanceNetworkNames,
  resolveMainWalletChain,
} from './base-wallet'
import { buildWalletConfigs } from '../utils/wallet-configs'
import { walletSupport } from '../utils/wallet-support'
import { PUBLIC_CLIENT_ENV } from '../../config/public-client-env.cjs'

const testnetMessaging = { chainIdentifier: 'monad-testnet', isTestnet: true }
const regtestMessaging = { chainIdentifier: 'monad-regtest', isTestnet: true }
const mainnetMessaging = { chainIdentifier: 'monad-mainnet', isTestnet: false }

describe('the main-balance network the host configures', () => {
  it('is the messaging chain when nothing is configured, or when the setting names it', () => {
    expect(resolveMainWalletChain(undefined, testnetMessaging)).toBeUndefined()
    expect(resolveMainWalletChain('', testnetMessaging)).toBeUndefined()
    expect(
      resolveMainWalletChain('monad-testnet', testnetMessaging),
    ).toBeUndefined()
  })

  it('is Lotus v2 when configured, under a test network build', () => {
    expect(
      resolveMainWalletChain('lotus-v2-regtest', regtestMessaging),
    ).toMatchObject({ id: 'lotus-v2-regtest', family: 'bitcoin' })
    expect(
      resolveMainWalletChain('lotus-v2-regtest', testnetMessaging)?.id,
    ).toBe('lotus-v2-regtest')
  })

  it('refuses unknown identifiers, family names and a network the build mode cannot open', () => {
    for (const id of ['lotus', 'monad', 'evm', 'bitcoin', 'xpi-regtest-v3'])
      expect(() => resolveMainWalletChain(id, testnetMessaging)).toThrow(
        UnsupportedBaseChainError,
      )
    expect(() =>
      resolveMainWalletChain('lotus-v2-regtest', mainnetMessaging),
    ).toThrow(/monad-mainnet, a main network/)
  })

  it('refuses an EVM network that is not the messaging chain', () => {
    // Another Monad network would replace the messaging row and leave messaging on no wallet.
    expect(() =>
      resolveMainWalletChain('monad-regtest', testnetMessaging),
    ).toThrow(/must be the messaging chain, monad-testnet/)
    expect(() =>
      resolveMainWalletChain('ethereum-sepolia', testnetMessaging),
    ).toThrow(UnsupportedBaseChainError)
  })

  it('names the networks Settings shows', () => {
    expect(mainBalanceNetworkNames(undefined, 'monad-testnet')).toEqual({
      main: getChainRegistryEntry('monad-testnet')!.name,
    })
    expect(
      mainBalanceNetworkNames(
        getChainRegistryEntry('lotus-v2-regtest'),
        'monad-regtest',
      ),
    ).toEqual({
      main: getChainRegistryEntry('lotus-v2-regtest')!.name,
      messaging: getChainRegistryEntry('monad-regtest')!.name,
    })
  })

  it('is a public build setting (Quasar exposes only the allowlist)', () => {
    expect(BASE_CHAIN_SETTING).toBe('QCLI_FRANK_BASE_CHAIN')
    expect(PUBLIC_CLIENT_ENV.has(`import.meta.env.${BASE_CHAIN_SETTING}`)).toBe(
      true,
    )
  })
})

describe('wallet rows with a configured main-balance network', () => {
  const lotus = getChainRegistryEntry('lotus-v2-regtest')!

  it('without one: the messaging wallet is the main and the messaging row, as before', () => {
    const rows = buildWalletConfigs(undefined)
    expect(rows[0]).toMatchObject({
      id: 'monad',
      isMain: true,
      isMessaging: true,
      dataTest: 'wallet-row',
      defaultNameKey: 'walletPanel.mainWallet',
    })
    expect(rows.filter(row => row.isMain)).toHaveLength(1)
  })

  it('with Lotus v2: its canonical row is first and main; Monad stays as the messaging wallet', () => {
    const rows = buildWalletConfigs(lotus)
    expect(rows[0]).toMatchObject({
      id: 'lotus-v2-regtest',
      isMain: true,
      isMessaging: false,
      dataTest: 'wallet-row',
      balanceDataTest: 'wallet-balance',
      defaultNameKey: 'walletPanel.mainWallet',
    })
    const monad = rows.find(row => row.id === 'monad')!
    expect(monad).toMatchObject({
      isMessaging: true,
      defaultNameKey: 'walletPanel.monad',
      dataTest: 'monad-wallet-row',
    })
    expect(monad.isMain).toBeFalsy()
    expect(rows.filter(row => row.isMain).map(row => row.id)).toEqual([
      'lotus-v2-regtest',
    ])
    expect(rows.filter(row => row.isMessaging).map(row => row.id)).toEqual([
      'monad',
    ])
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
    // The row opens the configured network itself, through the registry's wallet setting.
    expect(walletSupport('lotus-v2-regtest', true, 'monad-regtest')).toEqual({
      status: 'available',
      entry: lotus,
    })
  })

  it('never takes an EVM network as the main row', () => {
    expect(() =>
      buildWalletConfigs(getChainRegistryEntry('ethereum-sepolia')!),
    ).toThrow(/messaging chain/)
  })
})

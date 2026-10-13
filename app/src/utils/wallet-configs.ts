import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'
import { walletNetworkMetadata } from './wallet-support'

export interface WalletItemConfig {
  id: string
  isMain?: boolean
  enabled?: boolean
  icon: string
  dataTest: string
  nameDataTest: string
  nameTextDataTest: string
  badgeDataTest: string
  renameBtnDataTest: string
  chainDataTest: string
  balanceDataTest: string
  defaultNameKey: string
  testnetDefaultNameKey?: string
  chainKey: string
  testnetChainKey: string
  balanceZeroKey?: string
  testnetBalanceZeroKey?: string
}

const WALLET_UI_OVERRIDES: Record<string, Partial<WalletItemConfig>> = {
  monad: {
    isMain: true,
    icon: 'account_balance_wallet',
    dataTest: 'wallet-row',
    nameDataTest: 'wallet-name',
    nameTextDataTest: 'wallet-name-text',
    badgeDataTest: 'testnet-badge',
    renameBtnDataTest: 'rename-monad-btn',
    chainDataTest: 'wallet-chain',
    balanceDataTest: 'wallet-balance',
    defaultNameKey: 'walletPanel.mainWallet',
    chainKey: 'walletPanel.monad',
    testnetChainKey: 'walletPanel.monadTestnet',
  },
  bitcoin: {
    icon: 'currency_bitcoin',
    testnetDefaultNameKey: 'walletPanel.bitcoinTestnet',
    balanceZeroKey: 'walletPanel.zeroBtc',
    testnetBalanceZeroKey: 'walletPanel.zeroTbtc',
  },
  bitcoincash: {
    icon: 'paid',
    testnetDefaultNameKey: 'walletPanel.bitcoincashTestnet',
    balanceZeroKey: 'walletPanel.zeroBch',
    testnetBalanceZeroKey: 'walletPanel.zeroTbch',
  },
  dogecoin: {
    icon: 'pets',
    testnetDefaultNameKey: 'walletPanel.dogecoinTestnet',
    balanceZeroKey: 'walletPanel.zeroDoge',
    testnetBalanceZeroKey: 'walletPanel.zeroTdoge',
  },
  ecash: {
    icon: 'toll',
    balanceZeroKey: 'walletPanel.zeroXec',
    testnetBalanceZeroKey: 'walletPanel.zeroTxec',
  },
  solana: {
    icon: 'account_balance',
    balanceZeroKey: 'walletPanel.zeroSol',
    testnetBalanceZeroKey: 'walletPanel.zeroTsol',
  },
  tempo: {
    icon: 'speed',
    testnetDefaultNameKey: 'walletPanel.tempoTestnet',
    balanceZeroKey: 'walletPanel.zeroUsd',
    testnetBalanceZeroKey: 'walletPanel.zeroTusd',
  },
  ethereum: {
    icon: 'diamond',
    testnetDefaultNameKey: 'walletPanel.ethereumTestnet',
    balanceZeroKey: 'walletPanel.zeroEth',
    testnetBalanceZeroKey: 'walletPanel.zeroEth',
  },
  hyperliquid: {
    icon: 'waves',
    testnetDefaultNameKey: 'walletPanel.hyperliquidTestnet',
    balanceZeroKey: 'walletPanel.zeroHype',
    testnetBalanceZeroKey: 'walletPanel.zeroThype',
  },
  litecoin: {
    icon: 'generating_tokens',
    testnetDefaultNameKey: 'walletPanel.litecoinTestnet',
    balanceZeroKey: 'walletPanel.zeroLtc',
    testnetBalanceZeroKey: 'walletPanel.zeroTltc',
  },
  bnb: {
    icon: 'token',
    testnetDefaultNameKey: 'walletPanel.bnbTestnet',
    balanceZeroKey: 'walletPanel.zeroBnb',
    testnetBalanceZeroKey: 'walletPanel.zeroTbnb',
  },
  polygon: {
    icon: 'polyline',
    testnetDefaultNameKey: 'walletPanel.polygonTestnet',
    balanceZeroKey: 'walletPanel.zeroPol',
    testnetBalanceZeroKey: 'walletPanel.zeroTpol',
  },
  base: {
    icon: 'change_history',
    testnetDefaultNameKey: 'walletPanel.baseTestnet',
    balanceZeroKey: 'walletPanel.zeroEth',
    testnetBalanceZeroKey: 'walletPanel.zeroEth',
  },
  arbitrum: {
    icon: 'hub',
    testnetDefaultNameKey: 'walletPanel.arbitrumTestnet',
    balanceZeroKey: 'walletPanel.zeroEth',
    testnetBalanceZeroKey: 'walletPanel.zeroEth',
  },
}

const PREFERRED_KIND_ORDER = [
  'monad',
  'bitcoin',
  'bitcoincash',
  'dogecoin',
  'ecash',
  'solana',
  'tempo',
  'ethereum',
  'hyperliquid',
  'litecoin',
  'bnb',
  'polygon',
  'base',
  'arbitrum',
]

function buildWalletItemConfig(kind: string): WalletItemConfig {
  const overrides = WALLET_UI_OVERRIDES[kind] ?? {}
  return {
    id: kind,
    enabled: true,
    icon: 'account_balance_wallet',
    dataTest: `${kind}-wallet-row`,
    nameDataTest: `${kind}-wallet-name`,
    nameTextDataTest: `${kind}-wallet-name-text`,
    badgeDataTest: `${kind}-testnet-badge`,
    renameBtnDataTest: `rename-${kind}-btn`,
    chainDataTest: `${kind}-wallet-chain`,
    balanceDataTest: `${kind}-wallet-balance`,
    defaultNameKey: `walletPanel.${kind}`,
    chainKey: `walletPanel.${kind}`,
    testnetChainKey: `walletPanel.${kind}Testnet`,
    ...overrides,
  }
}

// Derived from PROTOCOL_CHAINS so adding a chain to the registry automatically populates WALLET_CONFIGS
const discoveredKinds = Array.from(
  new Set(Object.values(PROTOCOL_CHAINS).map(entry => entry.kind)),
)
const orderedKinds = [
  ...PREFERRED_KIND_ORDER.filter(k => discoveredKinds.includes(k)),
  ...discoveredKinds.filter(k => !PREFERRED_KIND_ORDER.includes(k)),
]

export const WALLET_CONFIGS: WalletItemConfig[] =
  orderedKinds.map(buildWalletItemConfig)

/** Shared caption for the existing wallet presentation aliases. */
export function getWalletNetworkLabel(
  wallet: WalletItemConfig,
  isTestnet: boolean,
  translate: (key: string) => string,
): string {
  const metadata = walletNetworkMetadata(wallet.id, isTestnet)
  if (metadata?.family === 'solana' || metadata?.network === 'regtest')
    return metadata.name

  return translate(isTestnet ? wallet.testnetChainKey : wallet.chainKey)
}

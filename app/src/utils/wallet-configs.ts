import {
  getChainRegistryEntry,
  resolveNetworkId,
} from '@frank/wallet/chain/chains-registry'

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

// Monad is intentionally placed first as the primary stamp wallet
export const WALLET_CONFIGS: WalletItemConfig[] = [
  {
    id: 'monad',
    isMain: true,
    enabled: true,
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
  {
    id: 'bitcoin',
    enabled: true,
    icon: 'currency_bitcoin',
    dataTest: 'bitcoin-wallet-row',
    nameDataTest: 'bitcoin-wallet-name',
    nameTextDataTest: 'bitcoin-wallet-name-text',
    badgeDataTest: 'bitcoin-testnet-badge',
    renameBtnDataTest: 'rename-bitcoin-btn',
    chainDataTest: 'bitcoin-wallet-chain',
    balanceDataTest: 'bitcoin-wallet-balance',
    defaultNameKey: 'walletPanel.bitcoin',
    testnetDefaultNameKey: 'walletPanel.bitcoinTestnet',
    chainKey: 'walletPanel.bitcoin',
    testnetChainKey: 'walletPanel.bitcoinTestnet',
    balanceZeroKey: 'walletPanel.zeroBtc',
    testnetBalanceZeroKey: 'walletPanel.zeroTbtc',
  },
  {
    id: 'bitcoincash',
    enabled: true,
    icon: 'paid',
    dataTest: 'bitcoincash-wallet-row',
    nameDataTest: 'bitcoincash-wallet-name',
    nameTextDataTest: 'bitcoincash-wallet-name-text',
    badgeDataTest: 'bitcoincash-testnet-badge',
    renameBtnDataTest: 'rename-bitcoincash-btn',
    chainDataTest: 'bitcoincash-wallet-chain',
    balanceDataTest: 'bitcoincash-wallet-balance',
    defaultNameKey: 'walletPanel.bitcoincash',
    testnetDefaultNameKey: 'walletPanel.bitcoincashTestnet',
    chainKey: 'walletPanel.bitcoincash',
    testnetChainKey: 'walletPanel.bitcoincashTestnet',
    balanceZeroKey: 'walletPanel.zeroBch',
    testnetBalanceZeroKey: 'walletPanel.zeroTbch',
  },
  {
    id: 'dogecoin',
    enabled: true,
    icon: 'pets',
    dataTest: 'dogecoin-wallet-row',
    nameDataTest: 'dogecoin-wallet-name',
    nameTextDataTest: 'dogecoin-wallet-name-text',
    badgeDataTest: 'dogecoin-testnet-badge',
    renameBtnDataTest: 'rename-dogecoin-btn',
    chainDataTest: 'dogecoin-wallet-chain',
    balanceDataTest: 'dogecoin-wallet-balance',
    defaultNameKey: 'walletPanel.dogecoin',
    testnetDefaultNameKey: 'walletPanel.dogecoinTestnet',
    chainKey: 'walletPanel.dogecoin',
    testnetChainKey: 'walletPanel.dogecoinTestnet',
    balanceZeroKey: 'walletPanel.zeroDoge',
    testnetBalanceZeroKey: 'walletPanel.zeroTdoge',
  },
  {
    id: 'ecash',
    enabled: true,
    icon: 'toll',
    dataTest: 'ecash-wallet-row',
    nameDataTest: 'ecash-wallet-name',
    nameTextDataTest: 'ecash-wallet-name-text',
    badgeDataTest: 'ecash-testnet-badge',
    renameBtnDataTest: 'rename-ecash-btn',
    chainDataTest: 'ecash-wallet-chain',
    balanceDataTest: 'ecash-wallet-balance',
    defaultNameKey: 'walletPanel.ecash',
    chainKey: 'walletPanel.ecash',
    testnetChainKey: 'walletPanel.ecashTestnet',
    balanceZeroKey: 'walletPanel.zeroXec',
    testnetBalanceZeroKey: 'walletPanel.zeroTxec',
  },
  {
    id: 'solana',
    enabled: true,
    icon: 'account_balance',
    dataTest: 'solana-wallet-row',
    nameDataTest: 'solana-wallet-name',
    nameTextDataTest: 'solana-wallet-name-text',
    badgeDataTest: 'solana-testnet-badge',
    renameBtnDataTest: 'rename-solana-btn',
    chainDataTest: 'solana-wallet-chain',
    balanceDataTest: 'solana-wallet-balance',
    defaultNameKey: 'walletPanel.solana',
    chainKey: 'walletPanel.solana',
    testnetChainKey: 'walletPanel.solanaTestnet',
    balanceZeroKey: 'walletPanel.zeroSol',
    testnetBalanceZeroKey: 'walletPanel.zeroTsol',
  },
  {
    id: 'tempo',
    enabled: true,
    icon: 'speed',
    dataTest: 'tempo-wallet-row',
    nameDataTest: 'tempo-wallet-name',
    nameTextDataTest: 'tempo-wallet-name-text',
    badgeDataTest: 'tempo-testnet-badge',
    renameBtnDataTest: 'rename-tempo-btn',
    chainDataTest: 'tempo-wallet-chain',
    balanceDataTest: 'tempo-wallet-balance',
    defaultNameKey: 'walletPanel.tempo',
    testnetDefaultNameKey: 'walletPanel.tempoTestnet',
    chainKey: 'walletPanel.tempo',
    testnetChainKey: 'walletPanel.tempoTestnet',
    balanceZeroKey: 'walletPanel.zeroUsd',
    testnetBalanceZeroKey: 'walletPanel.zeroTusd',
  },
  {
    id: 'ethereum',
    enabled: true,
    icon: 'diamond',
    dataTest: 'ethereum-wallet-row',
    nameDataTest: 'ethereum-wallet-name',
    nameTextDataTest: 'ethereum-wallet-name-text',
    badgeDataTest: 'ethereum-testnet-badge',
    renameBtnDataTest: 'rename-ethereum-btn',
    chainDataTest: 'ethereum-wallet-chain',
    balanceDataTest: 'ethereum-wallet-balance',
    defaultNameKey: 'walletPanel.ethereum',
    testnetDefaultNameKey: 'walletPanel.ethereumTestnet',
    chainKey: 'walletPanel.ethereum',
    testnetChainKey: 'walletPanel.ethereumTestnet',
    balanceZeroKey: 'walletPanel.zeroEth',
    testnetBalanceZeroKey: 'walletPanel.zeroSep',
  },
  {
    id: 'hyperliquid',
    enabled: true,
    icon: 'waves',
    dataTest: 'hyperliquid-wallet-row',
    nameDataTest: 'hyperliquid-wallet-name',
    nameTextDataTest: 'hyperliquid-wallet-name-text',
    badgeDataTest: 'hyperliquid-testnet-badge',
    renameBtnDataTest: 'rename-hyperliquid-btn',
    chainDataTest: 'hyperliquid-wallet-chain',
    balanceDataTest: 'hyperliquid-wallet-balance',
    defaultNameKey: 'walletPanel.hyperliquid',
    testnetDefaultNameKey: 'walletPanel.hyperliquidTestnet',
    chainKey: 'walletPanel.hyperliquid',
    testnetChainKey: 'walletPanel.hyperliquidTestnet',
    balanceZeroKey: 'walletPanel.zeroHype',
    testnetBalanceZeroKey: 'walletPanel.zeroThype',
  },
]

/** Shared caption for the existing wallet presentation aliases. */
export function getWalletNetworkLabel(
  wallet: WalletItemConfig,
  isTestnet: boolean,
  translate: (key: string) => string,
): string {
  if (wallet.id === 'solana') {
    const metadata = getChainRegistryEntry(
      resolveNetworkId(wallet.id, isTestnet),
    )
    if (metadata?.family !== 'solana')
      throw new Error('Missing Solana network metadata')
    return metadata.name
  }
  return translate(isTestnet ? wallet.testnetChainKey : wallet.chainKey)
}

export type SupportedChainFamily = 'evm' | 'bitcoin' | 'solana'
export type SupportedNetwork = 'mainnet' | 'testnet' | 'regtest'
export type SupportedChainKind =
  | 'monad'
  | 'ecash'
  | 'solana'
  | 'ethereum'
  | 'hyperliquid'
  | 'tempo'
export type SupportedCurve = 'secp256k1' | 'ed25519'

export interface ChainContracts {
  readonly stateChannel?: string
  readonly htlc?: string
  readonly channelVault?: string
  readonly tablePotVault?: string
}

export const CANONICAL_EVM_CONTRACTS: Readonly<ChainContracts> = Object.freeze({
  stateChannel: '0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57',
  htlc: '0x391a080Bd6FF21CB4598adF063Dc94018CD186E5',
  channelVault: '0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57',
  tablePotVault: '0x391a080Bd6FF21CB4598adF063Dc94018CD186E5',
})

export const CANONICAL_SOLANA_CONTRACTS: Readonly<ChainContracts> =
  Object.freeze({
    stateChannel: 'CHAN111111111111111111111111111111111111111',
    htlc: 'HTLC111111111111111111111111111111111111111',
    channelVault: 'CHAN111111111111111111111111111111111111111',
    tablePotVault: 'HTLC111111111111111111111111111111111111111',
  })

export type ExchangeAdapterType =
  | 'dex-router'
  | 'dex-aggregator'
  | 'atomic-swap'
  | 'clob-orderbook'
  | 'settlement-engine'

export interface ChainExchangeConfig {
  readonly pluginId: string
  readonly routerName: string
  readonly adapterType: ExchangeAdapterType
  readonly defaultPair: {
    readonly from: string
    readonly to: string
    readonly defaultAmount?: string
  }
  readonly supportedAssets: readonly string[]
}

export interface ChainRegistryEntry {
  readonly id: string
  readonly kind: SupportedChainKind
  readonly family: SupportedChainFamily
  readonly curve: SupportedCurve
  readonly keyType: 1 | 2 // 1 = secp256k1, 2 = ed25519
  readonly network: SupportedNetwork
  readonly isTestnet: boolean
  readonly name: string
  readonly unit: string
  readonly caip2?: string
  readonly nativeChainId?: string | number
  readonly networkTag?: string
  readonly addressPrefix?: string
  readonly rpcUrl?: string
  readonly explorerUrl?: string
  readonly contracts?: ChainContracts
  readonly exchange?: ChainExchangeConfig
}

export const PROTOCOL_CHAINS: Record<string, ChainRegistryEntry> =
  Object.freeze({
    'monad-testnet': Object.freeze({
      id: 'monad-testnet',
      kind: 'monad',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Monad Testnet',
      unit: 'MONT',
      caip2: 'eip155:10143',
      nativeChainId: 10143,
      networkTag: 'MONT',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: Object.freeze({
          from: 'MON',
          to: 'USDC',
          defaultAmount: '100',
        }),
        supportedAssets: Object.freeze(['MON', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'monad-mainnet': Object.freeze({
      id: 'monad-mainnet',
      kind: 'monad',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Monad',
      unit: 'MON',
      caip2: 'eip155:143',
      nativeChainId: 143,
      networkTag: 'MON1',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: Object.freeze({
          from: 'MON',
          to: 'USDC',
          defaultAmount: '100',
        }),
        supportedAssets: Object.freeze(['MON', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'xec-testnet': Object.freeze({
      id: 'xec-testnet',
      kind: 'ecash',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'eCash Testnet',
      unit: 'tXEC',
      addressPrefix: 'ectest',
      networkTag: 'XECT',
      exchange: Object.freeze({
        pluginId: 'ecash-atomic-swap',
        routerName: 'eCash Atomic Swap Router',
        adapterType: 'atomic-swap',
        defaultPair: Object.freeze({
          from: 'XEC',
          to: 'USDC',
          defaultAmount: '1000000',
        }),
        supportedAssets: Object.freeze(['XEC', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'xec-mainnet': Object.freeze({
      id: 'xec-mainnet',
      kind: 'ecash',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'eCash',
      unit: 'XEC',
      addressPrefix: 'ecash',
      networkTag: 'XEC1',
      exchange: Object.freeze({
        pluginId: 'ecash-atomic-swap',
        routerName: 'eCash Atomic Swap Router',
        adapterType: 'atomic-swap',
        defaultPair: Object.freeze({
          from: 'XEC',
          to: 'USDC',
          defaultAmount: '1000000',
        }),
        supportedAssets: Object.freeze(['XEC', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'solana-devnet': Object.freeze({
      id: 'solana-devnet',
      kind: 'solana',
      family: 'solana',
      curve: 'ed25519',
      keyType: 2,
      network: 'testnet',
      isTestnet: true,
      name: 'Solana Devnet',
      unit: 'dSOL',
      caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      networkTag: 'SOLD',
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'jupiter-aggregator',
        routerName: 'Jupiter Aggregator v6',
        adapterType: 'dex-aggregator',
        defaultPair: Object.freeze({
          from: 'SOL',
          to: 'USDC',
          defaultAmount: '1',
        }),
        supportedAssets: Object.freeze(['SOL', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'solana-testnet': Object.freeze({
      id: 'solana-testnet',
      kind: 'solana',
      family: 'solana',
      curve: 'ed25519',
      keyType: 2,
      network: 'testnet',
      isTestnet: true,
      name: 'Solana Testnet',
      unit: 'tSOL',
      caip2: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
      networkTag: 'SOLT',
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'jupiter-aggregator',
        routerName: 'Jupiter Aggregator v6',
        adapterType: 'dex-aggregator',
        defaultPair: Object.freeze({
          from: 'SOL',
          to: 'USDC',
          defaultAmount: '1',
        }),
        supportedAssets: Object.freeze(['SOL', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'solana-mainnet': Object.freeze({
      id: 'solana-mainnet',
      kind: 'solana',
      family: 'solana',
      curve: 'ed25519',
      keyType: 2,
      network: 'mainnet',
      isTestnet: false,
      name: 'Solana',
      unit: 'SOL',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      networkTag: 'SOL1',
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'jupiter-aggregator',
        routerName: 'Jupiter Aggregator v6',
        adapterType: 'dex-aggregator',
        defaultPair: Object.freeze({
          from: 'SOL',
          to: 'USDC',
          defaultAmount: '1',
        }),
        supportedAssets: Object.freeze(['SOL', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'ethereum-sepolia': Object.freeze({
      id: 'ethereum-sepolia',
      kind: 'ethereum',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Sepolia',
      unit: 'SEP',
      caip2: 'eip155:11155111',
      nativeChainId: 11155111,
      networkTag: 'SEPO',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: Object.freeze({
          from: 'ETH',
          to: 'USDC',
          defaultAmount: '0.1',
        }),
        supportedAssets: Object.freeze(['ETH', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'ethereum-holesky': Object.freeze({
      id: 'ethereum-holesky',
      kind: 'ethereum',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Holesky',
      unit: 'HOL',
      caip2: 'eip155:17000',
      nativeChainId: 17000,
      networkTag: 'HOLE',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: Object.freeze({
          from: 'ETH',
          to: 'USDC',
          defaultAmount: '0.1',
        }),
        supportedAssets: Object.freeze(['ETH', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'ethereum-mainnet': Object.freeze({
      id: 'ethereum-mainnet',
      kind: 'ethereum',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Ethereum',
      unit: 'ETH',
      caip2: 'eip155:1',
      nativeChainId: 1,
      networkTag: 'ETH1',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: Object.freeze({
          from: 'ETH',
          to: 'USDC',
          defaultAmount: '0.1',
        }),
        supportedAssets: Object.freeze(['ETH', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'hyperliquid-mainnet': Object.freeze({
      id: 'hyperliquid-mainnet',
      kind: 'hyperliquid',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Hyperliquid',
      unit: 'HYPE',
      caip2: 'eip155:999',
      nativeChainId: 999,
      networkTag: 'HYPE',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'hyperliquid-l1',
        routerName: 'Hyperliquid L1 Orderbook Router',
        adapterType: 'clob-orderbook',
        defaultPair: Object.freeze({
          from: 'HYPE',
          to: 'USDC',
          defaultAmount: '10',
        }),
        supportedAssets: Object.freeze(['HYPE', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'hyperliquid-testnet': Object.freeze({
      id: 'hyperliquid-testnet',
      kind: 'hyperliquid',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Hyperliquid Testnet',
      unit: 'tHYPE',
      caip2: 'eip155:998',
      nativeChainId: 998,
      networkTag: 'HYPT',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'hyperliquid-l1',
        routerName: 'Hyperliquid L1 Orderbook Router',
        adapterType: 'clob-orderbook',
        defaultPair: Object.freeze({
          from: 'HYPE',
          to: 'USDC',
          defaultAmount: '10',
        }),
        supportedAssets: Object.freeze(['HYPE', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'tempo-mainnet': Object.freeze({
      id: 'tempo-mainnet',
      kind: 'tempo',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Tempo',
      unit: 'USD',
      caip2: 'eip155:4217',
      nativeChainId: 4217,
      networkTag: 'TMPO',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'tempo-router',
        routerName: 'Tempo Settlement Engine',
        adapterType: 'settlement-engine',
        defaultPair: Object.freeze({
          from: 'USD',
          to: 'USDC',
          defaultAmount: '100',
        }),
        supportedAssets: Object.freeze(['USD', 'USDC', 'USDT', 'AVU']),
      }),
    }),
    'tempo-testnet': Object.freeze({
      id: 'tempo-testnet',
      kind: 'tempo',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Tempo Moderato',
      unit: 'tUSD',
      caip2: 'eip155:42431',
      nativeChainId: 42431,
      networkTag: 'TMPT',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: 'tempo-router',
        routerName: 'Tempo Settlement Engine',
        adapterType: 'settlement-engine',
        defaultPair: Object.freeze({
          from: 'USD',
          to: 'USDC',
          defaultAmount: '100',
        }),
        supportedAssets: Object.freeze(['USD', 'USDC', 'USDT', 'AVU']),
      }),
    }),
  })

const DYNAMIC_CHAINS: Map<string, ChainRegistryEntry> = new Map()

/**
 * Registers an arbitrary, rotating, or ephemeral chain entry at runtime (such as new
 * testnets, local devnets, or rotating L2 rollups) without requiring codebase modifications.
 */
export function registerProtocolChain(entry: ChainRegistryEntry): void {
  DYNAMIC_CHAINS.set(entry.id, Object.freeze({ ...entry }))
}

/**
 * Clears dynamically registered chain entries. Primarily useful for test isolation.
 */
export function clearDynamicChains(): void {
  DYNAMIC_CHAINS.clear()
}

export function getChainRegistryEntry(
  id: string,
): ChainRegistryEntry | undefined {
  if (id === 'ecash-testnet') return PROTOCOL_CHAINS['xec-testnet']
  if (id === 'ecash-mainnet') return PROTOCOL_CHAINS['xec-mainnet']
  return PROTOCOL_CHAINS[id] ?? DYNAMIC_CHAINS.get(id)
}

export function getChainRegistryByKind(
  kind: SupportedChainKind,
  isTestnet: boolean,
): ChainRegistryEntry {
  const targetNetwork = isTestnet ? 'testnet' : 'mainnet'
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()]
  const entry = all.find(c => c.kind === kind && c.network === targetNetwork)
  if (!entry) {
    throw new Error(
      `No chain registry entry found for ${kind} (${targetNetwork})`,
    )
  }
  return entry
}

/**
 * Retrieves all registered chain entries matching a chain kind with optional testnet filter.
 * Enables ecosystems with multiple concurrent testnets (e.g., Ethereum Sepolia + Holesky,
 * Solana Devnet + Testnet) to enumerate all available testnets.
 */
export function getAllChainsByKind(
  kind: SupportedChainKind | string,
  filter?: { isTestnet?: boolean },
): ChainRegistryEntry[] {
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()]
  return all.filter(c => {
    if (c.kind !== kind) return false
    if (filter?.isTestnet !== undefined && c.isTestnet !== filter.isTestnet)
      return false
    return true
  })
}

/**
 * Retrieves all registered chain entries belonging to a given cryptographic / VM family
 * ("evm" | "bitcoin" | "solana") with optional testnet filter.
 */
export function getChainsByFamily(
  family: SupportedChainFamily,
  filter?: { isTestnet?: boolean },
): ChainRegistryEntry[] {
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()]
  return all.filter(c => {
    if (c.family !== family) return false
    if (filter?.isTestnet !== undefined && c.isTestnet !== filter.isTestnet)
      return false
    return true
  })
}

export function getChainRegistryByNetworkTag(
  networkTag: string,
): ChainRegistryEntry | undefined {
  return (
    Object.values(PROTOCOL_CHAINS).find(c => c.networkTag === networkTag) ??
    Array.from(DYNAMIC_CHAINS.values()).find(c => c.networkTag === networkTag)
  )
}

export function getChainRegistryByCaip2(
  caip2: string,
): ChainRegistryEntry | undefined {
  return (
    Object.values(PROTOCOL_CHAINS).find(c => c.caip2 === caip2) ??
    Array.from(DYNAMIC_CHAINS.values()).find(c => c.caip2 === caip2)
  )
}

export function getChainsByCurve(curve: SupportedCurve): ChainRegistryEntry[] {
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()]
  return all.filter(c => c.curve === curve)
}

export function resolveChainIdentifier(
  idOrTagOrCaip2: string,
): ChainRegistryEntry | undefined {
  return (
    getChainRegistryEntry(idOrTagOrCaip2) ??
    getChainRegistryByNetworkTag(idOrTagOrCaip2) ??
    getChainRegistryByCaip2(idOrTagOrCaip2)
  )
}

/**
 * Resolves the exchange / swap router configuration for a chain entry by its ID or kind.
 * Enables swap and dApp views to dynamically discover the native router (Uniswap Universal Router
 * for EVM, Jupiter for Solana, eCash Atomic Swap Router for eCash, etc.) without hardcoding.
 */
export function getChainExchangeConfig(
  idOrKind: string,
  isTestnet?: boolean,
): ChainExchangeConfig | undefined {
  const direct = getChainRegistryEntry(idOrKind)
  if (direct?.exchange) return direct.exchange

  try {
    const byKind = getChainRegistryByKind(
      idOrKind as SupportedChainKind,
      isTestnet ?? false,
    )
    if (byKind?.exchange) return byKind.exchange
  } catch {
    // not a registered chain kind
  }

  const resolved = resolveChainIdentifier(idOrKind)
  return resolved?.exchange
}

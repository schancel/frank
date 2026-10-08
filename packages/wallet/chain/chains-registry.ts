export type SupportedChainFamily = "evm" | "bitcoin" | "solana";
export type SupportedNetwork = "mainnet" | "testnet" | "regtest";
export type SupportedChainKind =
  | "monad"
  | "ecash"
  | "solana"
  | "ethereum"
  | "hyperliquid"
  | "tempo"
  | "bitcoin"
  | "bitcoincash"
  | "dogecoin";
export type SupportedCurve = "secp256k1" | "ed25519";

export interface ChainContracts {
  readonly stateChannel?: string;
  readonly htlc?: string;
  readonly channelVault?: string;
  readonly tablePotVault?: string;
}

export const CANONICAL_EVM_CONTRACTS: Readonly<ChainContracts> = Object.freeze({
  stateChannel: "0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57",
  htlc: "0x391a080Bd6FF21CB4598adF063Dc94018CD186E5",
  channelVault: "0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57",
  tablePotVault: "0x391a080Bd6FF21CB4598adF063Dc94018CD186E5",
});

export const CANONICAL_SOLANA_CONTRACTS: Readonly<ChainContracts> =
  Object.freeze({
    stateChannel: "CHAN111111111111111111111111111111111111111",
    htlc: "HTLC111111111111111111111111111111111111111",
    channelVault: "CHAN111111111111111111111111111111111111111",
    tablePotVault: "HTLC111111111111111111111111111111111111111",
  });

export type ExchangeAdapterType =
  | "dex-router"
  | "dex-aggregator"
  | "atomic-swap"
  | "clob-orderbook"
  | "settlement-engine";

export interface ChainExchangeConfig {
  readonly pluginId: string;
  readonly routerName: string;
  readonly adapterType: ExchangeAdapterType;
  readonly defaultPair: {
    readonly from: string;
    readonly to: string;
    readonly defaultAmount?: string;
  };
  readonly supportedAssets: readonly string[];
}

export interface ChainRegistryEntry {
  readonly id: string;
  readonly kind: SupportedChainKind;
  readonly family: SupportedChainFamily;
  readonly curve: SupportedCurve;
  readonly keyType: 1 | 2; // 1 = secp256k1, 2 = ed25519
  readonly network: SupportedNetwork;
  readonly isTestnet: boolean;
  readonly enabled?: boolean;
  readonly name: string;
  readonly unit: string;
  readonly caip2?: string;
  readonly nativeChainId?: string | number;
  readonly networkTag?: string;
  readonly addressPrefix?: string;
  readonly rpcUrl?: string;
  readonly rpcUrls?: readonly string[];
  readonly explorerUrl?: string;
  readonly contracts?: ChainContracts;
  readonly exchange?: ChainExchangeConfig;
  readonly electrumServers?: readonly string[];
}

export const PROTOCOL_CHAINS: Record<string, ChainRegistryEntry> =
  Object.freeze({
    "monad-testnet": Object.freeze({
      id: "monad-testnet",
      kind: "monad",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Monad Testnet",
      unit: "MONT",
      caip2: "eip155:10143",
      nativeChainId: 10143,
      networkTag: "MONT",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: Object.freeze({
          from: "MON",
          to: "USDC",
          defaultAmount: "100",
        }),
        supportedAssets: Object.freeze(["MON", "USDC", "USDT", "AVU"]),
      }),
    }),
    "monad-mainnet": Object.freeze({
      id: "monad-mainnet",
      kind: "monad",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Monad",
      unit: "MON",
      caip2: "eip155:143",
      nativeChainId: 143,
      networkTag: "MON1",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: Object.freeze({
          from: "MON",
          to: "USDC",
          defaultAmount: "100",
        }),
        supportedAssets: Object.freeze(["MON", "USDC", "USDT", "AVU"]),
      }),
    }),
    "xec-testnet": Object.freeze({
      id: "xec-testnet",
      kind: "ecash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "eCash Testnet",
      unit: "tXEC",
      addressPrefix: "ectest",
      networkTag: "XECT",
      exchange: Object.freeze({
        pluginId: "ecash-atomic-swap",
        routerName: "eCash Atomic Swap Router",
        adapterType: "atomic-swap",
        defaultPair: Object.freeze({
          from: "XEC",
          to: "USDC",
          defaultAmount: "1000000",
        }),
        supportedAssets: Object.freeze(["XEC", "USDC", "USDT", "AVU"]),
      }),
    }),
    "xec-mainnet": Object.freeze({
      id: "xec-mainnet",
      kind: "ecash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "eCash",
      unit: "XEC",
      addressPrefix: "ecash",
      networkTag: "XEC1",
      exchange: Object.freeze({
        pluginId: "ecash-atomic-swap",
        routerName: "eCash Atomic Swap Router",
        adapterType: "atomic-swap",
        defaultPair: Object.freeze({
          from: "XEC",
          to: "USDC",
          defaultAmount: "1000000",
        }),
        supportedAssets: Object.freeze(["XEC", "USDC", "USDT", "AVU"]),
      }),
    }),
    "solana-devnet": Object.freeze({
      id: "solana-devnet",
      kind: "solana",
      family: "solana",
      curve: "ed25519",
      keyType: 2,
      network: "testnet",
      isTestnet: true,
      name: "Solana Devnet",
      unit: "dSOL",
      caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      networkTag: "SOLD",
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "jupiter-aggregator",
        routerName: "Jupiter Aggregator v6",
        adapterType: "dex-aggregator",
        defaultPair: Object.freeze({
          from: "SOL",
          to: "USDC",
          defaultAmount: "1",
        }),
        supportedAssets: Object.freeze(["SOL", "USDC", "USDT", "AVU"]),
      }),
    }),
    "solana-testnet": Object.freeze({
      id: "solana-testnet",
      kind: "solana",
      family: "solana",
      curve: "ed25519",
      keyType: 2,
      network: "testnet",
      isTestnet: true,
      name: "Solana Testnet",
      unit: "tSOL",
      caip2: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
      networkTag: "SOLT",
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "jupiter-aggregator",
        routerName: "Jupiter Aggregator v6",
        adapterType: "dex-aggregator",
        defaultPair: Object.freeze({
          from: "SOL",
          to: "USDC",
          defaultAmount: "1",
        }),
        supportedAssets: Object.freeze(["SOL", "USDC", "USDT", "AVU"]),
      }),
    }),
    "solana-mainnet": Object.freeze({
      id: "solana-mainnet",
      kind: "solana",
      family: "solana",
      curve: "ed25519",
      keyType: 2,
      network: "mainnet",
      isTestnet: false,
      name: "Solana",
      unit: "SOL",
      caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      networkTag: "SOL1",
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "jupiter-aggregator",
        routerName: "Jupiter Aggregator v6",
        adapterType: "dex-aggregator",
        defaultPair: Object.freeze({
          from: "SOL",
          to: "USDC",
          defaultAmount: "1",
        }),
        supportedAssets: Object.freeze(["SOL", "USDC", "USDT", "AVU"]),
      }),
    }),
    "ethereum-sepolia": Object.freeze({
      id: "ethereum-sepolia",
      kind: "ethereum",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Sepolia",
      unit: "SEP",
      caip2: "eip155:11155111",
      nativeChainId: 11155111,
      networkTag: "SEPO",
      rpcUrls: Object.freeze([
        "https://magical-prettiest-mountain.ethereum-sepolia.quiknode.pro/c080e49e29466648ec94f6f18020b705be336ddf/",
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://rpc.sepolia.org",
      ]),
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: Object.freeze({
          from: "ETH",
          to: "USDC",
          defaultAmount: "0.1",
        }),
        supportedAssets: Object.freeze(["ETH", "USDC", "USDT", "AVU"]),
      }),
    }),
    "ethereum-holesky": Object.freeze({
      id: "ethereum-holesky",
      kind: "ethereum",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Holesky",
      unit: "HOL",
      caip2: "eip155:17000",
      nativeChainId: 17000,
      networkTag: "HOLE",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: Object.freeze({
          from: "ETH",
          to: "USDC",
          defaultAmount: "0.1",
        }),
        supportedAssets: Object.freeze(["ETH", "USDC", "USDT", "AVU"]),
      }),
    }),
    "ethereum-mainnet": Object.freeze({
      id: "ethereum-mainnet",
      kind: "ethereum",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Ethereum",
      unit: "ETH",
      caip2: "eip155:1",
      nativeChainId: 1,
      networkTag: "ETH1",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "uniswap-universal-router",
        routerName: "Uniswap Universal Router",
        adapterType: "dex-router",
        defaultPair: Object.freeze({
          from: "ETH",
          to: "USDC",
          defaultAmount: "0.1",
        }),
        supportedAssets: Object.freeze(["ETH", "USDC", "USDT", "AVU"]),
      }),
    }),
    "hyperliquid-mainnet": Object.freeze({
      id: "hyperliquid-mainnet",
      kind: "hyperliquid",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Hyperliquid",
      unit: "HYPE",
      caip2: "eip155:999",
      nativeChainId: 999,
      networkTag: "HYPE",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "hyperliquid-l1",
        routerName: "Hyperliquid L1 Orderbook Router",
        adapterType: "clob-orderbook",
        defaultPair: Object.freeze({
          from: "HYPE",
          to: "USDC",
          defaultAmount: "10",
        }),
        supportedAssets: Object.freeze(["HYPE", "USDC", "USDT", "AVU"]),
      }),
    }),
    "hyperliquid-testnet": Object.freeze({
      id: "hyperliquid-testnet",
      kind: "hyperliquid",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Hyperliquid Testnet",
      unit: "tHYPE",
      caip2: "eip155:998",
      nativeChainId: 998,
      networkTag: "HYPT",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "hyperliquid-l1",
        routerName: "Hyperliquid L1 Orderbook Router",
        adapterType: "clob-orderbook",
        defaultPair: Object.freeze({
          from: "HYPE",
          to: "USDC",
          defaultAmount: "10",
        }),
        supportedAssets: Object.freeze(["HYPE", "USDC", "USDT", "AVU"]),
      }),
    }),
    "tempo-mainnet": Object.freeze({
      id: "tempo-mainnet",
      kind: "tempo",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Tempo",
      unit: "USD",
      caip2: "eip155:4217",
      nativeChainId: 4217,
      networkTag: "TMPO",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "tempo-router",
        routerName: "Tempo Settlement Engine",
        adapterType: "settlement-engine",
        defaultPair: Object.freeze({
          from: "USD",
          to: "USDC",
          defaultAmount: "100",
        }),
        supportedAssets: Object.freeze(["USD", "USDC", "USDT", "AVU"]),
      }),
    }),
    "tempo-testnet": Object.freeze({
      id: "tempo-testnet",
      kind: "tempo",
      family: "evm",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Tempo Moderato",
      unit: "tUSD",
      caip2: "eip155:42431",
      nativeChainId: 42431,
      networkTag: "TMPT",
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: Object.freeze({
        pluginId: "tempo-router",
        routerName: "Tempo Settlement Engine",
        adapterType: "settlement-engine",
        defaultPair: Object.freeze({
          from: "USD",
          to: "USDC",
          defaultAmount: "100",
        }),
        supportedAssets: Object.freeze(["USD", "USDC", "USDT", "AVU"]),
      }),
    }),
    "btc-mainnet": Object.freeze({
      id: "btc-mainnet",
      kind: "bitcoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Bitcoin",
      unit: "BTC",
      caip2: "bip122:000000000019d6689c085ae165831e93",
      networkTag: "BTC1",
      electrumServers: Object.freeze(["wss://electrum.blockstream.info:50002"]),
    }),
    "btc-testnet": Object.freeze({
      id: "btc-testnet",
      kind: "bitcoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Bitcoin Testnet",
      unit: "tBTC",
      caip2: "bip122:000000000933ea01ad0ee984209779ba",
      networkTag: "BTCT",
      electrumServers: Object.freeze([
        "wss://testnet.aranguren.org:51004",
        "wss://blackie.c3-soft.com:57008",
      ]),
    }),
    "btc-testnet4": Object.freeze({
      id: "btc-testnet4",
      kind: "bitcoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Bitcoin Testnet4",
      unit: "tBTC",
      networkTag: "BTC4",
      electrumServers: Object.freeze(["wss://blackie.c3-soft.com:57012"]),
    }),
    "bch-mainnet": Object.freeze({
      id: "bch-mainnet",
      kind: "bitcoincash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Bitcoin Cash",
      unit: "BCH",
      addressPrefix: "bitcoincash",
      networkTag: "BCH1",
      electrumServers: Object.freeze([
        "wss://fulcrum.fountainhead.cash:50004",
        "wss://bch.ninja:50004",
      ]),
    }),
    "bch-testnet": Object.freeze({
      id: "bch-testnet",
      kind: "bitcoincash",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Bitcoin Cash Chipnet",
      unit: "tBCH",
      addressPrefix: "bchtest",
      networkTag: "BCHT",
      electrumServers: Object.freeze([
        "wss://chipnet.bch.ninja:50004",
        "wss://chipnet.imaginary.cash:50004",
        "wss://blackie.c3-soft.com:64004",
      ]),
    }),
    "doge-mainnet": Object.freeze({
      id: "doge-mainnet",
      kind: "dogecoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "mainnet",
      isTestnet: false,
      name: "Dogecoin",
      unit: "DOGE",
      networkTag: "DOGE",
      electrumServers: Object.freeze([
        "wss://electrum.doge.keys4coins.com:50002",
        "wss://doge-electrum.cryptonode.id:50004",
      ]),
    }),
    "doge-testnet": Object.freeze({
      id: "doge-testnet",
      kind: "dogecoin",
      family: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      network: "testnet",
      isTestnet: true,
      name: "Dogecoin Testnet",
      unit: "tDOGE",
      networkTag: "DOGT",
      electrumServers: Object.freeze([
        "wss://testnet-electrum.cryptonode.id:50004",
      ]),
    }),
  });

const DYNAMIC_CHAINS: Map<string, ChainRegistryEntry> = new Map();

/**
 * Registers an arbitrary, rotating, or ephemeral chain entry at runtime (such as new
 * testnets, local devnets, or rotating L2 rollups) without requiring codebase modifications.
 */
export function registerProtocolChain(entry: ChainRegistryEntry): void {
  DYNAMIC_CHAINS.set(entry.id, Object.freeze({ ...entry }));
}

/**
 * Clears dynamically registered chain entries. Primarily useful for test isolation.
 */
export function clearDynamicChains(): void {
  DYNAMIC_CHAINS.clear();
}

export function getChainRegistryEntry(
  id: string
): ChainRegistryEntry | undefined {
  if (id === "ecash-testnet") return PROTOCOL_CHAINS["xec-testnet"];
  if (id === "ecash-mainnet") return PROTOCOL_CHAINS["xec-mainnet"];
  return PROTOCOL_CHAINS[id] ?? DYNAMIC_CHAINS.get(id);
}

export function getChainRegistryByKind(
  kind: SupportedChainKind,
  isTestnet: boolean
): ChainRegistryEntry {
  const targetNetwork = isTestnet ? "testnet" : "mainnet";
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()];
  const entry = all.find((c) => c.kind === kind && c.network === targetNetwork);
  if (!entry) {
    throw new Error(
      `No chain registry entry found for ${kind} (${targetNetwork})`
    );
  }
  return entry;
}

/**
 * Retrieves all registered chain entries matching a chain kind with optional testnet filter.
 * Enables ecosystems with multiple concurrent testnets (e.g., Ethereum Sepolia + Holesky,
 * Solana Devnet + Testnet) to enumerate all available testnets.
 */
export function getAllChainsByKind(
  kind: SupportedChainKind | string,
  filter?: { isTestnet?: boolean }
): ChainRegistryEntry[] {
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()];
  return all.filter((c) => {
    if (c.kind !== kind) return false;
    if (filter?.isTestnet !== undefined && c.isTestnet !== filter.isTestnet)
      return false;
    return true;
  });
}

/**
 * Retrieves all registered chain entries belonging to a given cryptographic / VM family
 * ("evm" | "bitcoin" | "solana") with optional testnet filter.
 */
export function getChainsByFamily(
  family: SupportedChainFamily,
  filter?: { isTestnet?: boolean }
): ChainRegistryEntry[] {
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()];
  return all.filter((c) => {
    if (c.family !== family) return false;
    if (filter?.isTestnet !== undefined && c.isTestnet !== filter.isTestnet)
      return false;
    return true;
  });
}

export function getChainRegistryByNetworkTag(
  networkTag: string
): ChainRegistryEntry | undefined {
  return (
    Object.values(PROTOCOL_CHAINS).find((c) => c.networkTag === networkTag) ??
    Array.from(DYNAMIC_CHAINS.values()).find((c) => c.networkTag === networkTag)
  );
}

export function getChainRegistryByCaip2(
  caip2: string
): ChainRegistryEntry | undefined {
  return (
    Object.values(PROTOCOL_CHAINS).find((c) => c.caip2 === caip2) ??
    Array.from(DYNAMIC_CHAINS.values()).find((c) => c.caip2 === caip2)
  );
}

export function getChainsByCurve(curve: SupportedCurve): ChainRegistryEntry[] {
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()];
  return all.filter((c) => c.curve === curve);
}

export function resolveChainIdentifier(
  idOrTagOrCaip2: string
): ChainRegistryEntry | undefined {
  return (
    getChainRegistryEntry(idOrTagOrCaip2) ??
    getChainRegistryByNetworkTag(idOrTagOrCaip2) ??
    getChainRegistryByCaip2(idOrTagOrCaip2)
  );
}

/**
 * Resolves the exchange / swap router configuration for a chain entry by its ID or kind.
 * Enables swap and dApp views to dynamically discover the native router (Uniswap Universal Router
 * for EVM, Jupiter for Solana, eCash Atomic Swap Router for eCash, etc.) without hardcoding.
 */
export function getChainExchangeConfig(
  idOrKind: string,
  isTestnet?: boolean
): ChainExchangeConfig | undefined {
  const direct = getChainRegistryEntry(idOrKind);
  if (direct?.exchange) return direct.exchange;

  try {
    const byKind = getChainRegistryByKind(
      idOrKind as SupportedChainKind,
      isTestnet ?? false
    );
    if (byKind?.exchange) return byKind.exchange;
  } catch {
    // not a registered chain kind
  }

  const resolved = resolveChainIdentifier(idOrKind);
  return resolved?.exchange;
}

/**
 * Checks whether a chain is enabled. Defaults to `isTestnet` if no explicit
 * `enabled` flag is set on the registry entry (mainnet chains locked by default).
 */
export function isChainEnabled(id: string): boolean {
  const chain = getChainRegistryEntry(id);
  if (!chain) return false;
  if (chain.enabled !== undefined) return chain.enabled;
  return chain.isTestnet;
}

/**
 * Resolves an arbitrary chain identifier or kind to its canonical registry network ID
 * (e.g. 'bitcoin' with isTestnet: true -> 'btc-testnet', 'solana' -> 'solana-devnet').
 * If the input is already a canonical network ID, returns it directly.
 */
export function resolveNetworkId(chainOrId: string, isTestnet = false): string {
  const direct = getChainRegistryEntry(chainOrId);
  if (direct) return direct.id;
  try {
    const byKind = getChainRegistryByKind(
      chainOrId as SupportedChainKind,
      isTestnet
    );
    if (byKind) return byKind.id;
  } catch {
    // not a known chain kind
  }
  const resolved = resolveChainIdentifier(chainOrId);
  if (resolved) return resolved.id;
  return chainOrId;
}

/**
 * Retrieves all registered chains for a given network type (testnet vs mainnet).
 */
export function getChainsByNetwork(isTestnet: boolean): ChainRegistryEntry[] {
  const all = [...Object.values(PROTOCOL_CHAINS), ...DYNAMIC_CHAINS.values()];
  return all.filter((c) => c.isTestnet === isTestnet);
}

/**
 * Validates whether an address string matches the structural and cryptographic
 * formatting rules of a given chain kind or registered chain ID.
 */
export function validateChainAddress(
  chainKindOrId: string,
  address: string
): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  const entry = getChainRegistryEntry(chainKindOrId);
  const kind = entry ? entry.kind : (chainKindOrId as SupportedChainKind);

  switch (kind) {
    case "monad":
    case "ethereum":
    case "tempo":
    case "hyperliquid": {
      return /^0x[0-9a-fA-F]{40}$/.test(trimmed);
    }
    case "solana": {
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
    }
    case "ecash": {
      return (
        trimmed.startsWith("ecash:") ||
        trimmed.startsWith("ectest:") ||
        /^[1-9A-HJ-NP-Za-km-z]{33,35}$/.test(trimmed)
      );
    }
    case "bitcoincash": {
      return (
        trimmed.startsWith("bitcoincash:") ||
        trimmed.startsWith("bchtest:") ||
        /^[1-9A-HJ-NP-Za-km-z]{33,35}$/.test(trimmed)
      );
    }
    case "bitcoin": {
      return (
        trimmed.startsWith("bc1") ||
        trimmed.startsWith("tb1") ||
        /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(trimmed)
      );
    }
    case "dogecoin": {
      return /^[D9n][1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed);
    }
    default:
      return false;
  }
}

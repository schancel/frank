export type SupportedChainFamily = "evm" | "bitcoin" | "solana";
export type SupportedNetwork = "mainnet" | "testnet" | "regtest";
export type SupportedChainKind = "monad" | "ecash" | "solana";

export interface ChainRegistryEntry {
  readonly id: string;
  readonly kind: SupportedChainKind;
  readonly family: SupportedChainFamily;
  readonly network: SupportedNetwork;
  readonly isTestnet: boolean;
  readonly name: string;
  readonly unit: string;
  readonly caip2?: string;
  readonly nativeChainId?: string | number;
  readonly networkTag?: string;
  readonly addressPrefix?: string;
}

export const PROTOCOL_CHAINS: Record<string, ChainRegistryEntry> = Object.freeze({
  "monad-testnet": Object.freeze({
    id: "monad-testnet",
    kind: "monad",
    family: "evm",
    network: "testnet",
    isTestnet: true,
    name: "Monad Testnet",
    unit: "MONT",
    caip2: "eip155:10143",
    nativeChainId: 10143,
    networkTag: "MONT",
  }),
  "monad-mainnet": Object.freeze({
    id: "monad-mainnet",
    kind: "monad",
    family: "evm",
    network: "mainnet",
    isTestnet: false,
    name: "Monad",
    unit: "MON",
    caip2: "eip155:143",
    nativeChainId: 143,
    networkTag: "MON1",
  }),
  "ecash-testnet": Object.freeze({
    id: "ecash-testnet",
    kind: "ecash",
    family: "bitcoin",
    network: "testnet",
    isTestnet: true,
    name: "eCash Testnet",
    unit: "tXEC",
    addressPrefix: "ectest",
  }),
  "xec-testnet": Object.freeze({
    id: "xec-testnet",
    kind: "ecash",
    family: "bitcoin",
    network: "testnet",
    isTestnet: true,
    name: "eCash Testnet",
    unit: "tXEC",
    addressPrefix: "ectest",
  }),
  "ecash-mainnet": Object.freeze({
    id: "ecash-mainnet",
    kind: "ecash",
    family: "bitcoin",
    network: "mainnet",
    isTestnet: false,
    name: "eCash",
    unit: "XEC",
    addressPrefix: "ecash",
  }),
  "xec-mainnet": Object.freeze({
    id: "xec-mainnet",
    kind: "ecash",
    family: "bitcoin",
    network: "mainnet",
    isTestnet: false,
    name: "eCash",
    unit: "XEC",
    addressPrefix: "ecash",
  }),
  "solana-testnet": Object.freeze({
    id: "solana-testnet",
    kind: "solana",
    family: "solana",
    network: "testnet",
    isTestnet: true,
    name: "Solana Testnet",
    unit: "tSOL",
    caip2: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
  }),
  "solana-mainnet": Object.freeze({
    id: "solana-mainnet",
    kind: "solana",
    family: "solana",
    network: "mainnet",
    isTestnet: false,
    name: "Solana",
    unit: "SOL",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  }),
});

export function getChainRegistryEntry(id: string): ChainRegistryEntry | undefined {
  return PROTOCOL_CHAINS[id];
}

export function getChainRegistryByKind(
  kind: SupportedChainKind,
  isTestnet: boolean
): ChainRegistryEntry {
  const targetNetwork = isTestnet ? "testnet" : "mainnet";
  const entry = Object.values(PROTOCOL_CHAINS).find(
    (c) => c.kind === kind && c.network === targetNetwork
  );
  if (!entry) {
    throw new Error(`No chain registry entry found for ${kind} (${targetNetwork})`);
  }
  return entry;
}

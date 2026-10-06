export type SupportedChainFamily = "evm" | "bitcoin" | "solana";
export type SupportedNetwork = "mainnet" | "testnet" | "regtest";
export type SupportedChainKind = "monad" | "ecash" | "solana" | "ethereum";
export type SupportedCurve = "secp256k1" | "ed25519";

export interface ChainRegistryEntry {
  readonly id: string;
  readonly kind: SupportedChainKind;
  readonly family: SupportedChainFamily;
  readonly curve: SupportedCurve;
  readonly keyType: 1 | 2; // 1 = secp256k1, 2 = ed25519
  readonly network: SupportedNetwork;
  readonly isTestnet: boolean;
  readonly name: string;
  readonly unit: string;
  readonly caip2?: string;
  readonly nativeChainId?: string | number;
  readonly networkTag?: string;
  readonly addressPrefix?: string;
  readonly rpcUrl?: string;
  readonly explorerUrl?: string;
}

export const PROTOCOL_CHAINS: Record<string, ChainRegistryEntry> = Object.freeze({
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
  }),
  "ecash-testnet": Object.freeze({
    id: "ecash-testnet",
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
  }),
  "ecash-mainnet": Object.freeze({
    id: "ecash-mainnet",
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

export function getChainRegistryByNetworkTag(
  networkTag: string
): ChainRegistryEntry | undefined {
  return Object.values(PROTOCOL_CHAINS).find(
    (c) => c.networkTag === networkTag
  );
}

export function getChainRegistryByCaip2(
  caip2: string
): ChainRegistryEntry | undefined {
  return Object.values(PROTOCOL_CHAINS).find((c) => c.caip2 === caip2);
}

export function getChainsByCurve(
  curve: SupportedCurve
): ChainRegistryEntry[] {
  return Object.values(PROTOCOL_CHAINS).filter((c) => c.curve === curve);
}

export function resolveChainIdentifier(
  idOrTagOrCaip2: string
): ChainRegistryEntry | undefined {
  return (
    PROTOCOL_CHAINS[idOrTagOrCaip2] ??
    getChainRegistryByNetworkTag(idOrTagOrCaip2) ??
    getChainRegistryByCaip2(idOrTagOrCaip2)
  );
}

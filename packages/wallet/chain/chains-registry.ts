import protocolChains from "../../../docs/protocol/chains/v1.json";
import { DEPLOYMENTS } from "../../contracts/deployments";
import {
  projectProtocolChains,
  type ProtocolChainFacts,
} from "./protocol-chain-registry";

import { MONAD_TESTNET_DEX, type EvmDexEntry } from "./dex-entries";
import {
  SOLANA_DEVNET_DEX,
  SOLANA_MAINNET_DEX,
  type SolanaDexEntry,
} from "./solana-dex-entries";

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
}

/**
 * The contract addresses of one EVM network, taken from its deployment record in
 * packages/contracts/deployments. A network without a record gets no `contracts` at all:
 * there is no address shared between networks and no default.
 */
function deployedContracts(
  chainIdentifier: string
): { readonly contracts?: ChainContracts } {
  const record = DEPLOYMENTS[chainIdentifier];
  if (!record) return {};
  if (record.chainIdentifier !== chainIdentifier) {
    throw new Error(
      `Deployment record listed for ${chainIdentifier} is for ${record.chainIdentifier}`
    );
  }
  return {
    contracts: Object.freeze({
      stateChannel: record.contracts.StateChannel.address,
      htlc: record.contracts.GenericHTLC.address,
    }),
  };
}

export const CANONICAL_SOLANA_CONTRACTS: Readonly<ChainContracts> =
  Object.freeze({
    stateChannel: "CHAN111111111111111111111111111111111111111",
    htlc: "HTLC111111111111111111111111111111111111111",
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

export interface ChainRegistryEntry extends ProtocolChainFacts {
  readonly kind: SupportedChainKind;
  readonly curve: SupportedCurve;
  readonly keyType: 1 | 2; // 1 = secp256k1, 2 = ed25519
  readonly enabled?: boolean;
  readonly name: string;
  readonly unit: string;
  readonly networkTag?: string;
  readonly addressPrefix?: string;
  readonly rpcUrl?: string;
  readonly rpcUrls?: readonly string[];
  readonly explorerUrl?: string;
  readonly contracts?: ChainContracts;
  /**
   * The exchanges this network's wallet can swap on, in order: facts only (addresses, pools,
   * which adapter speaks to it, enabled or not). An absent or empty list, or only disabled
   * entries, means no swap on this network. Each chain family has its own entry
   * types, told apart by `adapter`: `dex-entries.ts` (EVM), `solana-dex-entries.ts` (Solana).
   */
  readonly dex?: readonly (EvmDexEntry | SolanaDexEntry)[];
  /**
   * What an EVM network charges a transaction's gas price on: the gas it `used` (the usual
   * rule, and the default), or the whole gas `limit` it reserved. Monad charges the limit, so
   * there every unit of headroom above the estimate is paid for and a fee shown to the user is
   * limit times price, not an upper bound.
   */
  readonly gasChargedOn?: "used" | "limit";
  /**
   * An account-based network's rule that a value transfer is reverted (mined, fee charged, no
   * value moved) when it takes its sender below a reserve, unless the sender has sent nothing
   * in the last `spendSpacingBlocks` blocks. Monad: 10 MON and 3 blocks, measured in
   * `docs/protocol/chains/monad-reserve-balance.md`. A wallet waits that many blocks after an
   * account's last transaction before the next transfer from it, unless the transfer leaves
   * the account at or above `reserveBalanceWei`. Absent: the network has no such rule.
   * The same delay governs incoming money: the node admits a transaction against the sender's
   * balance of `spendSpacingBlocks + 1` blocks ago, so funds newer than that are not signed
   * against (same document, "Money that has just arrived").
   */
  /** Decimal wei (a string: the registry is plain data). */
  readonly reserveBalanceWei?: string;
  readonly spendSpacingBlocks?: number;
  readonly exchange?: ChainExchangeConfig;
  /** What the app's own wallet does on this network. Absent: nothing, and no address is shown. */
  readonly wallet?: ChainWalletSupport;
}

/**
 * The wallet the app offers for a network: balance, receive and send. A network without one is
 * listed as unsupported and shows no deposit address, because money sent there could not be seen.
 */
export interface ChainWalletSupport {
  /** How the wallet reads the chain, always through the relay's proxy of this kind. */
  readonly indexer: "json-rpc" | "chronik" | "electrum";
}

/** The Monad client's reserve-balance rule (v0.16.4: `monad_default_max_reserve_balance_mon`
 * and delay factor k), the same on every Monad network. */
const MONAD_RESERVE_BALANCE_WEI = "10000000000000000000";
const MONAD_SPEND_SPACING_BLOCKS = 3;

const JSON_RPC_WALLET: ChainWalletSupport = Object.freeze({
  indexer: "json-rpc",
});

export type ClientChainExtension = Omit<
  ChainRegistryEntry,
  keyof ProtocolChainFacts
>;

// Keys are the explicit client-supported canonical subset, not another identity table.
const CLIENT_CHAIN_EXTENSIONS: Readonly<Record<string, ClientChainExtension>> =
  Object.freeze({
    "monad-testnet": Object.freeze({
      wallet: JSON_RPC_WALLET,
      kind: "monad",
      curve: "secp256k1",
      keyType: 1,
      name: "Monad Testnet",
      unit: "MONT",
      networkTag: "MONT",
      ...deployedContracts("monad-testnet"),
      gasChargedOn: "limit",
      reserveBalanceWei: MONAD_RESERVE_BALANCE_WEI,
      spendSpacingBlocks: MONAD_SPEND_SPACING_BLOCKS,
      dex: MONAD_TESTNET_DEX,
    }),
    // A local Monad network (monad-solonet, packages/bot/demo/regtest). Each run is a new
    // chain: no public endpoint, and its contracts are deployed by whoever started it.
    "monad-regtest": Object.freeze({
      wallet: JSON_RPC_WALLET,
      kind: "monad",
      curve: "secp256k1",
      keyType: 1,
      name: "Monad Regtest",
      unit: "MONR",
      networkTag: "MONR",
      gasChargedOn: "limit",
      reserveBalanceWei: MONAD_RESERVE_BALANCE_WEI,
      spendSpacingBlocks: MONAD_SPEND_SPACING_BLOCKS,
    }),
    "monad-mainnet": Object.freeze({
      wallet: JSON_RPC_WALLET,
      kind: "monad",
      curve: "secp256k1",
      keyType: 1,
      name: "Monad",
      unit: "MON",
      networkTag: "MON1",
      ...deployedContracts("monad-mainnet"),
      gasChargedOn: "limit",
      reserveBalanceWei: MONAD_RESERVE_BALANCE_WEI,
      spendSpacingBlocks: MONAD_SPEND_SPACING_BLOCKS,
    }),
    "xec-testnet": Object.freeze({
      // The eCash SDK wallet on the relay's Chronik proxy.
      wallet: Object.freeze({ indexer: "chronik" }),
      kind: "ecash",
      curve: "secp256k1",
      keyType: 1,
      name: "eCash Testnet",
      unit: "tXEC",
      addressPrefix: "ectest",
      networkTag: "XECT",
    }),
    // A local eCash node in regtest mode (packages/bot/demo/regtest). Each run is a new chain, so
    // there are no public endpoints and the checkpoint block is given by whoever started it.
    "xec-regtest": Object.freeze({
      wallet: Object.freeze({ indexer: "chronik" }),
      kind: "ecash",
      curve: "secp256k1",
      keyType: 1,
      name: "eCash Regtest",
      unit: "rXEC",
      addressPrefix: "ecregtest",
      networkTag: "XECR",
    }),
    "xec-mainnet": Object.freeze({
      kind: "ecash",
      curve: "secp256k1",
      keyType: 1,
      name: "eCash",
      unit: "XEC",
      addressPrefix: "ecash",
      networkTag: "XEC1",
    }),
    "solana-devnet": Object.freeze({
      wallet: JSON_RPC_WALLET,
      kind: "solana",
      curve: "ed25519",
      keyType: 2,
      name: "Solana Devnet",
      unit: "dSOL",
      networkTag: "SOLD",
      contracts: CANONICAL_SOLANA_CONTRACTS,
      dex: SOLANA_DEVNET_DEX,
    }),
    "solana-testnet": Object.freeze({
      kind: "solana",
      curve: "ed25519",
      keyType: 2,
      name: "Solana Testnet",
      unit: "tSOL",
      networkTag: "SOLT",
      contracts: CANONICAL_SOLANA_CONTRACTS,
    }),
    "solana-mainnet": Object.freeze({
      wallet: JSON_RPC_WALLET,
      kind: "solana",
      curve: "ed25519",
      keyType: 2,
      name: "Solana",
      unit: "SOL",
      networkTag: "SOL1",
      contracts: CANONICAL_SOLANA_CONTRACTS,
      dex: SOLANA_MAINNET_DEX,
    }),
    "ethereum-sepolia": Object.freeze({
      kind: "ethereum",
      curve: "secp256k1",
      keyType: 1,
      name: "Sepolia",
      unit: "SEP",
      networkTag: "SEPO",
      rpcUrls: Object.freeze([
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://rpc.sepolia.org",
      ]),
      ...deployedContracts("ethereum-sepolia"),
    }),
    "ethereum-mainnet": Object.freeze({
      kind: "ethereum",
      curve: "secp256k1",
      keyType: 1,
      name: "Ethereum",
      unit: "ETH",
      networkTag: "ETH1",
      ...deployedContracts("ethereum-mainnet"),
    }),
    "hyperliquid-mainnet": Object.freeze({
      kind: "hyperliquid",
      curve: "secp256k1",
      keyType: 1,
      name: "Hyperliquid",
      unit: "HYPE",
      networkTag: "HYPE",
      ...deployedContracts("hyperliquid-mainnet"),
    }),
    "hyperliquid-testnet": Object.freeze({
      kind: "hyperliquid",
      curve: "secp256k1",
      keyType: 1,
      name: "Hyperliquid Testnet",
      unit: "tHYPE",
      networkTag: "HYPT",
      ...deployedContracts("hyperliquid-testnet"),
    }),
    "tempo-mainnet": Object.freeze({
      kind: "tempo",
      curve: "secp256k1",
      keyType: 1,
      name: "Tempo",
      unit: "USD",
      networkTag: "TMPO",
      ...deployedContracts("tempo-mainnet"),
    }),
    "tempo-testnet": Object.freeze({
      kind: "tempo",
      curve: "secp256k1",
      keyType: 1,
      name: "Tempo Moderato",
      unit: "tUSD",
      networkTag: "TMPT",
      ...deployedContracts("tempo-testnet"),
    }),
    "btc-mainnet": Object.freeze({
      kind: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      name: "Bitcoin",
      unit: "BTC",
      networkTag: "BTC1",
    }),
    "btc-testnet": Object.freeze({
      // utxo-wallet.ts on the relay's Electrum route (testnet3).
      wallet: Object.freeze({ indexer: "electrum" }),
      kind: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      name: "Bitcoin Testnet",
      unit: "tBTC",
      networkTag: "BTCT",
    }),
    "btc-testnet4": Object.freeze({
      kind: "bitcoin",
      curve: "secp256k1",
      keyType: 1,
      name: "Bitcoin Testnet4",
      unit: "tBTC",
      networkTag: "BTC4",
    }),
    "bch-mainnet": Object.freeze({
      kind: "bitcoincash",
      curve: "secp256k1",
      keyType: 1,
      name: "Bitcoin Cash",
      unit: "BCH",
      addressPrefix: "bitcoincash",
      networkTag: "BCH1",
    }),
    "bch-testnet": Object.freeze({
      // utxo-wallet.ts on the relay's Electrum route (Bitcoin Cash testnet3, not chipnet).
      wallet: Object.freeze({ indexer: "electrum" }),
      kind: "bitcoincash",
      curve: "secp256k1",
      keyType: 1,
      name: "Bitcoin Cash Chipnet",
      unit: "tBCH",
      addressPrefix: "bchtest",
      networkTag: "BCHT",
    }),
    "doge-mainnet": Object.freeze({
      kind: "dogecoin",
      curve: "secp256k1",
      keyType: 1,
      name: "Dogecoin",
      unit: "DOGE",
      networkTag: "DOGE",
    }),
    "doge-testnet": Object.freeze({
      kind: "dogecoin",
      curve: "secp256k1",
      keyType: 1,
      name: "Dogecoin Testnet",
      unit: "tDOGE",
      networkTag: "DOGT",
    }),
  });

export const PROTOCOL_CHAINS: Readonly<Record<string, ChainRegistryEntry>> =
  projectProtocolChains(protocolChains, CLIENT_CHAIN_EXTENSIONS);

export function getChainRegistryEntry(
  id: string
): ChainRegistryEntry | undefined {
  if (id === "ecash-testnet") return PROTOCOL_CHAINS["xec-testnet"];
  if (id === "ecash-mainnet") return PROTOCOL_CHAINS["xec-mainnet"];
  return PROTOCOL_CHAINS[id];
}

const CONTRACT_NAMES: Readonly<Record<keyof ChainContracts, string>> = {
  htlc: "GenericHTLC",
  stateChannel: "StateChannel",
};

/**
 * The address of a Frank contract on one network, by canonical `chainIdentifier`.
 * Throws when the identifier is unknown or the contract is not deployed there.
 */
export function requireChainContract(
  chainIdentifier: string,
  contract: keyof ChainContracts
): string {
  const entry = PROTOCOL_CHAINS[chainIdentifier];
  if (!entry) {
    throw new Error(`Unknown chain identifier "${chainIdentifier}"`);
  }
  const address = entry.contracts?.[contract];
  if (!address) {
    throw new Error(
      `${CONTRACT_NAMES[contract]} is not deployed on ${chainIdentifier}`
    );
  }
  return address;
}

/**
 * The canonical id of a chain kind's main network. A coin is priced under this id by the
 * oracle feed, on every network of the kind: a test network's coin is valued at its main
 * network's price (and shown marked as testnet). Undefined when the kind has no main
 * network in the client registry.
 */
export function mainnetChainIdOfKind(
  kind: SupportedChainKind
): string | undefined {
  return Object.values(PROTOCOL_CHAINS).find(
    (c) => c.kind === kind && c.network === "mainnet"
  )?.id;
}

export function getChainRegistryByKind(
  kind: SupportedChainKind,
  isTestnet: boolean
): ChainRegistryEntry {
  const targetNetwork = isTestnet ? "testnet" : "mainnet";
  const all = Object.values(PROTOCOL_CHAINS);
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
 * Enables ecosystems with multiple concurrent testnets (e.g., Solana Devnet + Testnet) to enumerate all available testnets.
 */
export function getAllChainsByKind(
  kind: SupportedChainKind | string,
  filter?: { isTestnet?: boolean }
): ChainRegistryEntry[] {
  const all = Object.values(PROTOCOL_CHAINS);
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
  const all = Object.values(PROTOCOL_CHAINS);
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
  return Object.values(PROTOCOL_CHAINS).find(
    (c) => c.networkTag === networkTag
  );
}

export function getChainRegistryByCaip2(
  caip2: string
): ChainRegistryEntry | undefined {
  return Object.values(PROTOCOL_CHAINS).find((c) => c.caip2 === caip2);
}

export function getChainsByCurve(curve: SupportedCurve): ChainRegistryEntry[] {
  const all = Object.values(PROTOCOL_CHAINS);
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
 * for EVM, eCash Atomic Swap Router for eCash, etc.; Solana exchanges are `dex` entries) without hardcoding.
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
  const all = Object.values(PROTOCOL_CHAINS);
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

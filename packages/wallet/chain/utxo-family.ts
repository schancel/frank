/**
 * One way to open any Bitcoin-family wallet the registry says the app has, through a relay.
 *
 * The registry's `wallet.indexer` picks the adapter: Chronik is the eCash SDK wallet, Electrum is
 * `UtxoWallet`. Nothing is inferred from names or prefixes, and a chain without a wallet row is
 * refused.
 */
import { BIP39_DERIVATION } from "../../domain-roots/src";
import type { HistoricalBip39Seed } from "../../domain-roots/src";
import { ChronikClient } from "chronik-client";
import type { NativeAssetChain } from "./active-chain";
import type {
  NativeTransactionAttemptStore,
  NativeWalletHandle,
} from "./chain-wallet";
import { getChainRegistryEntry } from "./chains-registry";
import { createEcashChain } from "./ecash-chain";
import type { EcashCheckpoint } from "../ecash-wallet";
import { ElectrumClient } from "./electrum-client";
import { electrumIndexer, relayElectrumUrl } from "./electrum-indexer";
import { createUtxoChain } from "./utxo-chain";
import { browserUtxoWalletStore } from "../utxo-wallet";
import type { UtxoWalletStore } from "../utxo-wallet";

export interface RelayUtxoChain {
  readonly chain: Omit<NativeAssetChain, "createWallet">;
  /**
   * `root` is either the existing 32-byte ecash-bch-wallet domain root or explicitly tagged
   * original BIP39 seed64. Both use the configured family HD paths. The caller owns the input.
   */
  createWallet(
    root: Uint8Array | HistoricalBip39Seed
  ): Promise<NativeWalletHandle>;
  /** Release the indexer connection. */
  close(): Promise<void>;
}

async function withMaterial<T>(
  material: Uint8Array | HistoricalBip39Seed,
  open: (material: Uint8Array | HistoricalBip39Seed) => Promise<T>
): Promise<T> {
  const historical = !(material instanceof Uint8Array);
  const source = historical ? material.seed : material;
  if (
    !(source instanceof Uint8Array) ||
    source.length !== (historical ? 64 : 32) ||
    (historical && material.derivation !== BIP39_DERIVATION)
  )
    throw new Error("Expected a domain root32 or tagged original BIP39 seed64");
  const bytes = new Uint8Array(source);
  try {
    return await open(
      historical ? { derivation: BIP39_DERIVATION, seed: bytes } : bytes
    );
  } finally {
    bytes.fill(0);
  }
}

export function openRelayUtxoChain(params: {
  chainIdentifier: string;
  relayBaseUrl: string;
  /** For a regtest network: the checkpoint block of the node the relay serves. */
  checkpoint?: EcashCheckpoint;
  /** Durable storage for one Electrum wallet; browser storage when omitted. */
  storeFor?: (chainIdentifier: string, firstAddress: string) => UtxoWalletStore;
  /** Where a Chronik wallet records a send before broadcasting it; browser storage when omitted. */
  nativeAttemptStore?: NativeTransactionAttemptStore;
}): RelayUtxoChain {
  const { chainIdentifier } = params;
  const entry = getChainRegistryEntry(chainIdentifier);
  if (entry?.family !== "bitcoin" || entry.wallet === undefined) {
    throw new Error(`No wallet is available for ${chainIdentifier}`);
  }
  const relay = params.relayBaseUrl.replace(/\/+$/, "");
  if (entry.wallet.indexer === "chronik") {
    if (
      chainIdentifier !== "xec-testnet" &&
      chainIdentifier !== "xec-mainnet" &&
      chainIdentifier !== "xec-regtest"
    ) {
      throw new Error(`No Chronik wallet is available for ${chainIdentifier}`);
    }
    const chain = createEcashChain({
      networkId: chainIdentifier,
      checkpoint: params.checkpoint,
      nativeAttemptStore: params.nativeAttemptStore,
      chronik: new ChronikClient([
        `${relay}/chain-rpc/${chainIdentifier}/chronik`,
      ]),
    });
    return {
      chain,
      createWallet: (root) =>
        withMaterial(root, (material) =>
          chain.createWallet(
            material instanceof Uint8Array
              ? {
                  registry: "frank-domain-roots-v1",
                  purpose: "ecash-bch-wallet",
                  bytes: material,
                }
              : material
          )
        ),
      close: async () => undefined,
    };
  }
  if (entry.wallet.indexer === "electrum") {
    const client = new ElectrumClient({
      endpoints: [relayElectrumUrl(relay, chainIdentifier)],
      requestTimeoutMs: 30_000,
    });
    const chain = createUtxoChain({
      chainIdentifier,
      indexer: electrumIndexer(client),
      storeFor: (firstAddress) =>
        params.storeFor?.(chainIdentifier, firstAddress) ??
        browserUtxoWalletStore(`${chainIdentifier}:${firstAddress}`),
    });
    return {
      chain,
      createWallet: (root) =>
        withMaterial(root, (material) =>
          chain.createWallet(
            material instanceof Uint8Array ? material : material.seed
          )
        ),
      close: () => client.close(),
    };
  }
  throw new Error(`No wallet is available for ${chainIdentifier}`);
}

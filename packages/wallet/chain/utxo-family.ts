/**
 * One way to open any Bitcoin-family wallet the registry says the app has, through a relay.
 *
 * The registry's `wallet.indexer` picks the adapter: Chronik is the eCash SDK wallet, Electrum is
 * `UtxoWallet`. Nothing is inferred from names or prefixes, and a chain without a wallet row is
 * refused.
 */
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
   * `root` is the 32-byte `ecash-bch-wallet` domain root, the BIP32 seed of every Bitcoin-family
   * wallet. The caller keeps ownership and may clear it once this resolves.
   */
  createWallet(root: Uint8Array): Promise<NativeWalletHandle>;
  /** Release the indexer connection. */
  close(): Promise<void>;
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
      chronik: new ChronikClient([`${relay}/chain-rpc/${chainIdentifier}/chronik`]),
    });
    return {
      chain,
      createWallet: (root) =>
        chain.createWallet({
          registry: "frank-domain-roots-v1",
          purpose: "ecash-bch-wallet",
          bytes: root,
        }),
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
      createWallet: (root) => chain.createWallet(root),
      close: () => client.close(),
    };
  }
  throw new Error(`No wallet is available for ${chainIdentifier}`);
}

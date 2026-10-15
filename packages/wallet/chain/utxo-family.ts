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
import type { EcashOperationStoreFactory } from "../ecash-operation-store";
import type { EcashWallet } from "../ecash-wallet";
import { createEcashChain } from "./ecash-chain";
import type {
  EcashCheckpoint,
  EcashWalletFactory,
  EcashBip39WalletFactory,
} from "../ecash-wallet";
import { ElectrumClient } from "./electrum-client";
import { electrumIndexer, relayElectrumUrl } from "./electrum-indexer";
import { createUtxoChain } from "./utxo-chain";
import { browserUtxoWalletStore } from "../utxo-wallet";
import type { UtxoStealthCustody } from "../utxo-stealth";
import type { UtxoWalletStore } from "../utxo-wallet";

export interface RelayUtxoChain {
  readonly chain: Omit<NativeAssetChain, "createWallet">;
  /**
   * `root` is either the existing 32-byte ecash-bch-wallet domain root or explicitly tagged
   * original BIP39 seed64. Both use the configured family HD paths. The caller owns the input.
   */
  createWallet(
    root: Uint8Array | HistoricalBip39Seed,
    options?: {
      stealthCustody?: UtxoStealthCustody;
      ecashWalletFactory?: EcashWalletFactory;
      ecashBip39WalletFactory?: EcashBip39WalletFactory;
    }
  ): Promise<NativeWalletHandle>;
  /** Nonsecret lifecycle check for session-owned custody bound to this relay. */
  readonly assertActive?: () => void;
  /** Release the indexer connection and synchronously revoke its signing lifetime. */
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
  operationStoreFactory?: EcashOperationStoreFactory;
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
    const wallets = new Set<EcashWallet>();
    const openings = new Set<Promise<NativeWalletHandle>>();
    let closing: Promise<void> | undefined;
    let closed = false;
    const requireOpen = () => {
      if (closed) throw new Error("UTXO wallet is closed");
    };
    const chronik = new ChronikClient([
      `${relay}/chain-rpc/${chainIdentifier}/chronik`,
    ]);
    const makeChain = (options?: {
      ecashWalletFactory?: EcashWalletFactory;
      ecashBip39WalletFactory?: EcashBip39WalletFactory;
    }) =>
      createEcashChain({
        networkId: chainIdentifier,
        checkpoint: params.checkpoint,
        nativeAttemptStore: params.nativeAttemptStore,
        operationStoreFactory: params.operationStoreFactory!,
        assertActive: requireOpen,
        chronik,
        walletFactory: options?.ecashWalletFactory,
        bip39WalletFactory: options?.ecashBip39WalletFactory,
      });
    const chain = makeChain();
    return {
      chain,
      assertActive: requireOpen,
      createWallet: (root, options) => {
        requireOpen();
        if (options?.stealthCustody)
          throw new Error(
            "Stealth custody is unsupported by the Chronik adapter"
          );
        const opening = withMaterial(root, async (material) => {
          requireOpen();
          const wallet = await makeChain(options).createWallet(
            material instanceof Uint8Array
              ? {
                  registry: "frank-domain-roots-v1",
                  purpose: "ecash-bch-wallet",
                  bytes: material,
                }
              : material
          );
          wallets.add(wallet);
          try {
            requireOpen();
          } catch (error) {
            try {
              await wallet.close();
            } catch (cleanup) {
              throw new AggregateError(
                [error, cleanup],
                "Late UTXO wallet cleanup failed"
              );
            }
            throw error;
          }
          return wallet;
        });
        openings.add(opening);
        void opening.then(
          () => openings.delete(opening),
          () => openings.delete(opening)
        );
        return opening;
      },
      close: () => {
        closed = true;
        const closedWallets = [...wallets].map((wallet) => wallet.close());
        return (closing ??= (async () => {
          const results = await Promise.allSettled([
            ...closedWallets,
            ...openings,
          ]);
          // Opening callers observe cancellation; cleanup failures remain observable too.
          const cleanupFailures = results.flatMap((result, index) =>
            result.status === "rejected" &&
            (index < closedWallets.length ||
              result.reason instanceof AggregateError)
              ? [result.reason]
              : []
          );
          if (cleanupFailures.length)
            throw new AggregateError(
              cleanupFailures,
              "UTXO relay cleanup failed"
            );
        })());
      },
    };
  }
  if (entry.wallet.indexer === "electrum") {
    const client = new ElectrumClient({
      endpoints: [relayElectrumUrl(relay, chainIdentifier)],
      requestTimeoutMs: 30_000,
    });
    let closed = false;
    const requireOpen = () => {
      if (closed) throw new Error("UTXO wallet is closed");
    };
    const indexer = electrumIndexer(client);
    const makeChain = (stealthCustody?: UtxoStealthCustody) =>
      createUtxoChain({
        chainIdentifier,
        indexer,
        stealthCustody,
        storeFor: (firstAddress) =>
          params.storeFor?.(chainIdentifier, firstAddress) ??
          browserUtxoWalletStore(`${chainIdentifier}:${firstAddress}`),
      });
    const chain = makeChain();
    return {
      chain,
      assertActive: requireOpen,
      createWallet: async (root, options) => {
        requireOpen();
        if (options?.ecashWalletFactory || options?.ecashBip39WalletFactory)
          throw new Error(
            "eCash factories are unsupported by the Electrum adapter"
          );
        const source = options?.stealthCustody;
        const guarded: UtxoStealthCustody | undefined = source && {
          identityPublicKey: new Uint8Array(source.identityPublicKey),
          assertActive() {
            requireOpen();
            source.assertActive();
          },
          async deriveStealthSigner(derivation) {
            requireOpen();
            source.assertActive();
            const signer = await source.deriveStealthSigner(derivation);
            requireOpen();
            source.assertActive();
            return {
              publicKey: new Uint8Array(signer.publicKey),
              sign(digest) {
                requireOpen();
                source.assertActive();
                return signer.sign(digest);
              },
            };
          },
        };
        const wallet = await withMaterial(root, (material) =>
          makeChain(guarded).createWallet(
            material instanceof Uint8Array ? material : material.seed
          )
        );
        requireOpen();
        return wallet;
      },
      close: async () => {
        closed = true;
        await client.close();
      },
    };
  }
  throw new Error(`No wallet is available for ${chainIdentifier}`);
}

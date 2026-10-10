/**
 * Bitcoin-family chains read through Electrum (Bitcoin, Bitcoin Cash), as the chain-neutral
 * surface the Send page uses. eCash has its own adapter (./ecash-chain) on Chronik.
 */
import type { NativeAssetChain } from "./active-chain";
import { formatBaseUnit, parseBaseUnit } from "./base-unit";
import { getChainRegistryEntry } from "./chains-registry";
import {
  canonicalUtxoAddress,
  UTXO_NETWORKS,
  UtxoWallet,
} from "../utxo-wallet";
import type { UtxoIndexer, UtxoWalletStore } from "../utxo-wallet";

export interface UtxoChainConfig {
  /** Canonical chain identifier, e.g. `btc-testnet`. */
  readonly chainIdentifier: string;
  readonly indexer: UtxoIndexer;
  /** Durable storage for one wallet, named by its first address. */
  readonly storeFor: (firstAddress: string) => UtxoWalletStore;
}

export interface UtxoChain extends Omit<NativeAssetChain, "createWallet"> {
  /** `seed` is the 32-byte `ecash-bch-wallet` domain root; the caller keeps ownership. */
  createWallet(seed: Uint8Array): Promise<UtxoWallet>;
}

const DECIMALS = 8;

export function createUtxoChain(config: UtxoChainConfig): UtxoChain {
  const network = UTXO_NETWORKS[config.chainIdentifier];
  const entry = getChainRegistryEntry(config.chainIdentifier);
  if (network === undefined || entry === undefined || entry.family !== "bitcoin") {
    throw new Error(
      `No Electrum wallet is available for ${config.chainIdentifier}`
    );
  }
  const own = (wallet: { chainIdentifier: string }): UtxoWallet => {
    if (
      !(wallet instanceof UtxoWallet) ||
      wallet.chainIdentifier !== config.chainIdentifier
    ) {
      throw new Error(`Expected a ${config.chainIdentifier} wallet`);
    }
    return wallet;
  };
  const parseAddress = (input: string) => {
    const raw = canonicalUtxoAddress(network, input);
    return raw === undefined ? undefined : { raw };
  };
  return {
    family: "bitcoin",
    chainIdentifier: config.chainIdentifier,
    name: entry.name,
    unit: entry.unit,
    networkId: config.chainIdentifier,
    network: entry.network,
    isTestnet: entry.isTestnet,
    capabilities: {
      profiles: false,
      directMessages: false,
      topics: false,
      stealthPayments: false,
    },
    toDisplayAmount: (raw) => formatBaseUnit(raw, DECIMALS),
    fromDisplayAmount: (display) => parseBaseUnit(display, DECIMALS),
    addressToString: (address) => address.raw,
    transactionToString: (transaction) => transaction.txHash,
    formatAddress: (address) => address.raw,
    parseAddress,
    createWallet(seed) {
      return UtxoWallet.create({
        network,
        seed,
        indexer: config.indexer,
        storeFor: config.storeFor,
      });
    },
    nativeTransfers: {
      getBalance: ({ wallet }) => own(wallet).getBalance(),
      send: ({ wallet, recipient, value, maxFee, onSigned }) => {
        const canonical = parseAddress(recipient.raw);
        if (canonical === undefined) {
          throw new Error("Invalid recipient address for this network");
        }
        return own(wallet).sendNative({
          recipient: canonical,
          value,
          maxFee,
          onSigned,
        });
      },
      async getTransactionStatus({ wallet, transaction }) {
        own(wallet);
        try {
          return (await config.indexer.hasTransaction(transaction.txHash))
            ? "pending"
            : "unknown";
        } catch {
          return "unknown";
        }
      },
      async estimateLegacyFee({ wallet, recipient, value }) {
        const { fee, inputCount } = await own(wallet).estimateFee({
          recipient,
          value,
        });
        return { totalFee: fee, inputCount, deliveryFee: fee };
      },
    },
  };
}

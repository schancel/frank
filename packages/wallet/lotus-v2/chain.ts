/**
 * The Lotus v2 network as a `NativeAssetChain`: amounts, addresses and native transfers over a
 * {@link LotusV2Wallet}. Regtest only; any other registry row is refused when the chain is made.
 */
import type { NativeAssetChain } from "../chain/active-chain";
import { formatBaseUnit, parseBaseUnit } from "../chain/base-unit";
import type { ChainTransaction, NativeWalletHandle } from "../chain/chain-wallet";
import { getChainRegistryEntry } from "../chain/chains-registry";
import type { LotusV2Indexer } from "./chronik";
import { decodeAddress } from "./native";
import { LotusV2Wallet, lotusV2NetworkOf, type LotusV2WalletStore } from "./wallet";

export interface LotusV2ChainConfig {
  readonly chainIdentifier: string;
  readonly indexer: LotusV2Indexer;
  /** The node's operator checkpoint block for this regtest run. */
  readonly checkpoint: { readonly height: number; readonly hash: string };
  readonly storeFor: (firstAddress: string) => LotusV2WalletStore;
}

export interface LotusV2Chain extends Omit<NativeAssetChain, "createWallet"> {
  /** `seed`: the `ecash-bch-wallet` domain root32 or the original BIP39 seed64. */
  createWallet(seed: Uint8Array): Promise<LotusV2Wallet>;
}

function requireLotusWallet(wallet: NativeWalletHandle, chainIdentifier: string): LotusV2Wallet {
  if (!(wallet instanceof LotusV2Wallet) || wallet.chainIdentifier !== chainIdentifier)
    throw new Error(`Expected a Lotus v2 wallet on ${chainIdentifier}, got ${wallet.chainIdentifier}`);
  return wallet;
}

export function createLotusV2Chain(config: LotusV2ChainConfig): LotusV2Chain {
  const network = lotusV2NetworkOf(config.chainIdentifier);
  const entry = getChainRegistryEntry(config.chainIdentifier)!;
  const decimals = entry.nativeDecimals ?? 6;
  const { chainIdentifier } = config;
  const parse = (input: string) => {
    try {
      const text = input.trim().toLowerCase();
      decodeAddress(network, text);
      return { raw: text };
    } catch {
      return undefined;
    }
  };
  return {
    family: "bitcoin",
    chainIdentifier,
    name: entry.name,
    unit: entry.unit,
    networkId: chainIdentifier,
    network: "regtest",
    isTestnet: true,
    capabilities: { profiles: false, directMessages: false, topics: false, stealthPayments: false },
    toDisplayAmount: (raw) => formatBaseUnit(raw, decimals),
    fromDisplayAmount: (display) => parseBaseUnit(display, decimals),
    addressToString: (address) => address.raw,
    transactionToString: (transaction: ChainTransaction) => transaction.txHash,
    formatAddress: (address) => address.raw,
    parseAddress: parse,
    createWallet: (seed) =>
      LotusV2Wallet.create({
        chainIdentifier,
        seed,
        indexer: config.indexer,
        checkpoint: config.checkpoint,
        storeFor: config.storeFor,
      }),
    nativeTransfers: {
      async getBalance({ wallet }) {
        return requireLotusWallet(wallet, chainIdentifier).getBalance();
      },
      async send({ wallet, recipient, value, maxFee, onSigned }) {
        const lotus = requireLotusWallet(wallet, chainIdentifier);
        const canonical = parse(recipient.raw);
        if (!canonical) throw new Error("Invalid Lotus recipient for the configured network");
        return lotus.sendNative({ recipient: canonical, value, maxFee, onSigned });
      },
      async getTransactionStatus({ wallet, transaction }) {
        return requireLotusWallet(wallet, chainIdentifier).getNativeTransactionStatus(transaction);
      },
      async estimateLegacyFee({ wallet, recipient, value }) {
        const plan = await requireLotusWallet(wallet, chainIdentifier).planSend({ recipient, value });
        return { totalFee: plan.fee, inputCount: plan.inputs.length, deliveryFee: plan.fee };
      },
    },
  };
}

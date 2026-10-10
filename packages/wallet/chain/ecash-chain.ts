// The package root eagerly initializes its browser WASM module, which Jest/CommonJS cannot parse;
// the address codec is a standalone published module with no WASM side effects.
import { Address } from "ecash-lib/dist/address/address";

import { NativeAssetChain } from "./active-chain";
import type { DomainRoot } from "../../domain-roots/src";
import { formatBaseUnit, parseBaseUnit } from "./base-unit";
import { NativeTransactionAttemptStore } from "./chain-wallet";
import {
  canonicalEcashNetworkId,
  EcashAddressPrefix,
  EcashNetworkId,
  EcashWallet,
  EcashWalletFactory,
} from "../ecash-wallet";
import type { ChronikClient } from "chronik-client";
import type { ChainUtxoPool } from "../chain-utxo-pool";

export interface EcashChainConfig {
  /** Optional chain identifier override; defaults to networkId. */
  readonly chainIdentifier?: string;
  /** eCash network identity. Additional networks require a reviewed genesis/prefix profile. */
  networkId: EcashNetworkId;
  /** Initialized SDK-compatible Chronik client; callers own endpoint selection and lifecycle. */
  chronik: ChronikClient;
  /** Test/embedding seam; production uses ecash-wallet's HD wallet implementation. */
  walletFactory?: EcashWalletFactory;
  nativeAttemptStore?: NativeTransactionAttemptStore;
  chainUtxoPool?: ChainUtxoPool;
}

const ECASH_MAINNET_PREFIX: EcashAddressPrefix = "ecash";
const ECASH_TESTNET_PREFIX: EcashAddressPrefix = "ectest";

async function getEcashTransactionStatus(
  config: EcashChainConfig,
  transaction: import("./chain-wallet").ChainTransaction
): Promise<"confirmed" | "failed" | "pending" | "unknown"> {
  const hashes = transaction.relatedTxHashes ?? [transaction.txHash];
  const statuses = await Promise.all(
    hashes.map(async (txHash) => {
      try {
        const transaction = await config.chronik.tx(txHash);
        return transaction.block === undefined ? "pending" : "confirmed";
      } catch {
        // Chronik 0.8 does not expose a structured not-found error. Treat every lookup failure as
        // unknown (never failed/not-submitted), which safely keeps the durable send guard.
        return "unknown";
      }
    })
  );
  if (statuses.every((status) => status === "confirmed")) return "confirmed";
  if (statuses.some((status) => status === "pending")) return "pending";
  return "unknown";
}

function parseEcashAddress(
  config: EcashChainConfig,
  input: string
): { raw: string } | undefined {
  try {
    const parsed = Address.fromCashAddress(input.toLowerCase());
    const isTestnet =
      canonicalEcashNetworkId(config.networkId) === "xec-testnet";
    const expectedPrefix = isTestnet
      ? ECASH_TESTNET_PREFIX
      : ECASH_MAINNET_PREFIX;
    if (parsed.prefix !== expectedPrefix) return undefined;
    return { raw: parsed.toString().toLowerCase() };
  } catch {
    return undefined;
  }
}

export interface EcashChain extends Omit<NativeAssetChain, "createWallet"> {
  createWallet(
    domainRoot: DomainRoot<"ecash-bch-wallet">
  ): Promise<EcashWallet>;
}

export function createEcashChain(config: EcashChainConfig): EcashChain {
  const canonicalNetwork = canonicalEcashNetworkId(config.networkId);
  const isTestnet = canonicalNetwork === "xec-testnet";
  const chainIdentifier = config.chainIdentifier ?? canonicalNetwork;
  const name = isTestnet ? "eCash Testnet" : "eCash";
  const unit = isTestnet ? "tXEC" : "XEC";
  const network = isTestnet ? "testnet" : "mainnet";

  return {
    family: "bitcoin",
    chainIdentifier,
    name,
    unit,
    networkId: canonicalNetwork,
    network,
    isTestnet,
    capabilities: {
      profiles: false,
      directMessages: false,
      topics: false,
      stealthPayments: false,
    },
    toDisplayAmount: (raw) => formatBaseUnit(raw, 2),
    fromDisplayAmount: (display) => parseBaseUnit(display, 2),
    addressToString: (address) => address.raw,
    transactionToString: (transaction) => transaction.txHash,
    formatAddress: (address) => address.raw,
    parseAddress(input) {
      return parseEcashAddress(config, input);
    },
    async createWallet(domainRoot) {
      return EcashWallet.fromDomainRoot({
        domainRoot,
        chronik: config.chronik,
        networkId: canonicalNetwork,
        walletFactory: config.walletFactory,
        nativeAttemptStore: config.nativeAttemptStore,
        chainUtxoPool: config.chainUtxoPool,
        getTransactionStatus: (transaction) =>
          getEcashTransactionStatus(config, transaction),
        rebroadcast: async (rawTransactions) => {
          await config.chronik.broadcastTxs([...rawTransactions]);
        },
      });
    },
    nativeTransfers: {
      async getBalance({ wallet }) {
        if (wallet.family !== "bitcoin") {
          throw new Error(
            `Expected a Bitcoin/eCash wallet, got ${wallet.family}`
          );
        }
        if (
          canonicalEcashNetworkId(wallet.networkId as EcashNetworkId) !==
          canonicalNetwork
        ) {
          throw new Error(
            `Expected eCash network ${canonicalNetwork}, got ${wallet.networkId}`
          );
        }
        return wallet.getBalance();
      },
      async send({ wallet, recipient, value, onSigned }) {
        if (wallet.family !== "bitcoin") {
          throw new Error(
            `Expected a Bitcoin/eCash wallet, got ${wallet.family}`
          );
        }
        if (
          canonicalEcashNetworkId(wallet.networkId as EcashNetworkId) !==
          canonicalNetwork
        ) {
          throw new Error(
            `Expected eCash network ${canonicalNetwork}, got ${wallet.networkId}`
          );
        }
        const canonicalRecipient = parseEcashAddress(config, recipient.raw);
        if (canonicalRecipient === undefined) {
          throw new Error("Invalid eCash recipient for the configured network");
        }
        return wallet.sendNative({
          recipient: canonicalRecipient,
          value,
          onSigned,
        });
      },
      async getTransactionStatus({ wallet, transaction }) {
        if (wallet.family !== "bitcoin") {
          throw new Error(
            `Expected a Bitcoin/eCash wallet, got ${wallet.family}`
          );
        }
        if (
          canonicalEcashNetworkId(wallet.networkId as EcashNetworkId) !==
          canonicalNetwork
        ) {
          throw new Error(
            `Expected eCash network ${canonicalNetwork}, got ${wallet.networkId}`
          );
        }
        return getEcashTransactionStatus(config, transaction);
      },
      async estimateLegacyFee({ wallet, recipient, value }) {
        if (!(wallet instanceof EcashWallet)) {
          throw new Error(`Expected an eCash wallet, got ${wallet.family}`);
        }
        const canonicalRecipient = parseEcashAddress(config, recipient.raw);
        if (canonicalRecipient === undefined) {
          throw new Error("Invalid eCash recipient for the configured network");
        }
        const totalFee = await wallet.estimateFee({
          recipient: canonicalRecipient,
          value,
        });
        return { totalFee, inputCount: 1, deliveryFee: totalFee };
      },
    },
  };
}

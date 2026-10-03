// The package root eagerly initializes its browser WASM module, which Jest/CommonJS cannot parse;
// the address codec is a standalone published module with no WASM side effects.
import { Address } from "ecash-lib/dist/address/address";

import { HDSeed, NativeAssetChain } from "./active-chain";
import { formatBaseUnit, parseBaseUnit } from "./base-unit";
import { NativeTransactionAttemptStore } from "./chain-wallet";
import {
  EcashAddressPrefix,
  EcashWallet,
  EcashWalletFactory,
} from "../ecash-wallet";

export interface EcashChainConfig {
  /** eCash network identity. Additional networks require a reviewed genesis/prefix profile. */
  networkId: "ecash-mainnet";
  /** Initialized Chronik client. Kept structural so callers own endpoint selection and lifecycle. */
  chronik: {
    block(heightOrHash: number | string): Promise<{
      blockInfo: { hash: string };
    }>;
    tx(txHash: string): Promise<{ block: unknown | undefined }>;
  };
  /** Test/embedding seam; production uses ecash-wallet's HD wallet implementation. */
  walletFactory?: EcashWalletFactory;
  nativeAttemptStore?: NativeTransactionAttemptStore;
}

const ECASH_MAINNET_GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const ECASH_MAINNET_PREFIX: EcashAddressPrefix = "ecash";

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
    if (parsed.prefix !== ECASH_MAINNET_PREFIX) return undefined;
    return { raw: parsed.toString().toLowerCase() };
  } catch {
    return undefined;
  }
}

export function createEcashChain(config: EcashChainConfig): NativeAssetChain {
  return {
    kind: "ecash",
    name: "eCash",
    unit: "XEC",
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
    async createWallet(seed: HDSeed) {
      const genesis = await config.chronik.block(0);
      if (genesis.blockInfo.hash !== ECASH_MAINNET_GENESIS_HASH) {
        throw new Error(
          `eCash Chronik genesis mismatch: expected ${ECASH_MAINNET_GENESIS_HASH}, got ${genesis.blockInfo.hash}`
        );
      }
      return EcashWallet.fromMnemonic({
        ...seed,
        chronik: config.chronik,
        networkId: config.networkId,
        attemptNetworkId: ECASH_MAINNET_GENESIS_HASH,
        addressPrefix: ECASH_MAINNET_PREFIX,
        walletFactory: config.walletFactory,
        nativeAttemptStore: config.nativeAttemptStore,
        getTransactionStatus: (transaction) =>
          getEcashTransactionStatus(config, transaction),
      });
    },
    nativeTransfers: {
      async getBalance({ wallet }) {
        if (wallet.chainKind !== "ecash") {
          throw new Error(`Expected an eCash wallet, got ${wallet.chainKind}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected eCash network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return wallet.getBalance();
      },
      async send({ wallet, recipient, value, onSigned }) {
        if (wallet.chainKind !== "ecash") {
          throw new Error(`Expected an eCash wallet, got ${wallet.chainKind}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected eCash network ${config.networkId}, got ${wallet.networkId}`
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
        if (wallet.chainKind !== "ecash") {
          throw new Error(`Expected an eCash wallet, got ${wallet.chainKind}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected eCash network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return getEcashTransactionStatus(config, transaction);
      },
    },
  };
}

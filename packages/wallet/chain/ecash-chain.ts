// The package root eagerly initializes its browser WASM module, which Jest/CommonJS cannot parse;
// the address codec is a standalone published module with no WASM side effects.
import { Address } from "ecash-lib/dist/address/address";

import { HDSeed, NativeAssetChain } from "./active-chain";
import { formatBaseUnit, parseBaseUnit } from "./base-unit";
import { NativeTransactionAttemptStore } from "./chain-wallet";
import { EcashWallet, EcashWalletFactory } from "../ecash-wallet";

export interface EcashChainConfig {
  /** Stable network identifier used to namespace durable transaction attempts. */
  networkId: string;
  /** Initialized Chronik client. Kept structural so callers own endpoint selection and lifecycle. */
  chronik: unknown;
  /** Test/embedding seam; production uses ecash-wallet's HD wallet implementation. */
  walletFactory?: EcashWalletFactory;
  nativeAttemptStore?: NativeTransactionAttemptStore;
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
      try {
        const parsed = Address.fromCashAddress(input);
        if (parsed.prefix !== "ecash") return undefined;
        return { raw: parsed.toString() };
      } catch {
        return undefined;
      }
    },
    createWallet(seed: HDSeed) {
      return EcashWallet.fromMnemonic({
        ...seed,
        chronik: config.chronik,
        networkId: config.networkId,
        walletFactory: config.walletFactory,
        nativeAttemptStore: config.nativeAttemptStore,
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
        return wallet.sendNative({ recipient, value, onSigned });
      },
    },
  };
}

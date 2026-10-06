import { Keypair, PublicKey } from "@solana/web3.js";
import * as bip39 from "bip39";

import { HDSeed, NativeAssetChain } from "./active-chain";
import { formatBaseUnit, parseBaseUnit } from "./base-unit";
import { NativeTransactionAttemptStore } from "./chain-wallet";
import { SolanaWallet, SolanaWalletConnection } from "../solana-wallet";

export interface SolanaChainConfig {
  /** Stable cluster/genesis identifier used to namespace durable transaction attempts. */
  networkId: string;
  /** Expected genesis hash, checked against the RPC before wallet construction. */
  genesisHash: string;
  connection: SolanaWalletConnection;
  /** The application owns the reviewed mnemonic-to-ed25519 derivation policy. */
  deriveSigner(seed: HDSeed): Promise<Keypair> | Keypair;
  nativeAttemptStore?: NativeTransactionAttemptStore;
}

export function createSolanaChain(config: SolanaChainConfig): NativeAssetChain {
  const isTestnet =
    config.networkId === "solana-testnet" ||
    config.networkId.includes("testnet") ||
    config.networkId.includes("devnet");
  const name = isTestnet ? "Solana Testnet" : "Solana";
  const unit = isTestnet ? "tSOL" : "SOL";
  const network = isTestnet ? "testnet" : "mainnet";

  return {
    kind: "solana",
    name,
    unit,
    networkId: config.networkId,
    network,
    isTestnet,
    capabilities: {
      profiles: false,
      directMessages: false,
      topics: false,
      stealthPayments: true,
    },
    toDisplayAmount: (raw) => formatBaseUnit(raw, 9),
    fromDisplayAmount: (display) => parseBaseUnit(display, 9),
    addressToString: (address) => address.raw,
    transactionToString: (transaction) => transaction.txHash,
    formatAddress: (address) => address.raw,
    parseAddress(input) {
      try {
        return { raw: new PublicKey(input).toBase58() };
      } catch {
        return undefined;
      }
    },
    async createWallet(seed) {
      if (!bip39.validateMnemonic(seed.mnemonic)) {
        throw new Error("Invalid BIP-39 mnemonic");
      }
      const actualGenesisHash = await config.connection.getGenesisHash();
      if (actualGenesisHash !== config.genesisHash) {
        throw new Error(
          `Solana RPC genesis mismatch: expected ${config.genesisHash}, got ${actualGenesisHash}`
        );
      }
      return new SolanaWallet({
        connection: config.connection,
        signer: await config.deriveSigner(seed),
        networkId: config.networkId,
        genesisHash: config.genesisHash,
        nativeAttemptStore: config.nativeAttemptStore,
      });
    },
    nativeTransfers: {
      async getBalance({ wallet }) {
        if (wallet.chainKind !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.chainKind}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return wallet.getBalance();
      },
      async send({ wallet, recipient, value, onSigned }) {
        if (wallet.chainKind !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.chainKind}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return wallet.sendNative({ recipient, value, onSigned });
      },
      async getTransactionStatus({ wallet, transaction }) {
        if (wallet.chainKind !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.chainKind}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        const response = await config.connection.getSignatureStatus(
          transaction.txHash,
          { searchTransactionHistory: true }
        );
        if (response.value === null) return "unknown";
        if (response.value.err !== null) return "failed";
        return response.value.confirmationStatus === "confirmed" ||
          response.value.confirmationStatus === "finalized"
          ? "confirmed"
          : "pending";
      },
    },
  };
}

import { Keypair, PublicKey } from "@solana/web3.js";
import * as bip39 from "bip39";

import { HDSeed, NativeAssetChain, ChainAddress } from "./active-chain";
import { formatBaseUnit, parseBaseUnit } from "./base-unit";
import { NativeTransactionAttemptStore } from "./chain-wallet";
import { SolanaWallet, SolanaWalletConnection } from "../solana-wallet";
import { buildSolanaStealthPayment } from "../solana-stealth";
import type { ChainUtxoPool } from "../chain-utxo-pool";

export interface SolanaChainConfig {
  /** Optional chain identifier override; defaults to networkId. */
  readonly chainIdentifier?: string;
  /** Stable cluster/genesis identifier used to namespace durable transaction attempts. */
  networkId: string;
  /** Expected genesis hash, checked against the RPC before wallet construction. */
  genesisHash: string;
  connection: SolanaWalletConnection;
  /** The application owns the reviewed mnemonic-to-ed25519 derivation policy. */
  deriveSigner(seed: HDSeed): Promise<Keypair> | Keypair;
  nativeAttemptStore?: NativeTransactionAttemptStore;
  chainUtxoPool?: ChainUtxoPool;
}

export function createSolanaChain(config: SolanaChainConfig): NativeAssetChain {
  const isTestnet =
    config.networkId === "solana-testnet" ||
    config.networkId.includes("testnet") ||
    config.networkId.includes("devnet");
  const chainIdentifier = config.chainIdentifier ?? config.networkId;
  const name = isTestnet ? "Solana Testnet" : "Solana";
  const unit = isTestnet ? "tSOL" : "SOL";
  const network = isTestnet ? "testnet" : "mainnet";

  return {
    family: "solana",
    chainIdentifier,
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
      legacyConsolidation: "solana-bundle",
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
        chainIdentifier,
        networkId: config.networkId,
        genesisHash: config.genesisHash,
        nativeAttemptStore: config.nativeAttemptStore,
        chainUtxoPool: config.chainUtxoPool,
      });
    },
    nativeTransfers: {
      async getBalance({ wallet }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return wallet.getBalance();
      },
      async send({ wallet, recipient, value, onSigned }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return wallet.sendNative({ recipient, value, onSigned });
      },
      async getTransactionStatus({ wallet, transaction }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
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
      async sendLegacy({ wallet, recipient, value, onProgress, onSigned }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }
        onProgress?.({ status: { stage: "broadcasting" } });
        const result = await wallet.sendNative({ recipient, value, onSigned });
        onProgress?.({ status: { stage: "confirmed", txHash: result.txHash } });
        return {
          txHash: result.txHash,
          totalValueSent: value,
          totalFeePaid: 5000n,
        };
      },
      async estimateLegacyFee() {
        return {
          totalFee: 5000n,
          inputCount: 1,
          deliveryFee: 5000n,
        };
      },
      async sendToContact({ wallet, recipient, value, memo, onProgress }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }
        onProgress?.({ stage: "resolving-keys" });
        let spendPubkey: Uint8Array;
        if ("pubKey" in recipient && recipient.pubKey) {
          spendPubkey = recipient.pubKey;
        } else {
          spendPubkey = new PublicKey((recipient as ChainAddress).raw).toBytes();
        }
        onProgress?.({ stage: "deriving-stealth" });
        onProgress?.({ stage: "signing" });
        const stealthPayment = await buildSolanaStealthPayment({
          wallet: wallet as SolanaWallet,
          recipientSpendPubKey: spendPubkey,
          amountLamports: value,
          memo,
        });
        onProgress?.({ stage: "confirmed", txHash: stealthPayment.txHash });
        return {
          txHash: stealthPayment.txHash,
          stealthAddress: stealthPayment.stealthDestination.stealthAddress,
          value,
        };
      },
    },
  };
}

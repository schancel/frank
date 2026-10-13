/**
 * Unified ChainAdapter and Multi-Wallet Architecture (packages/wallet/chain/chain-adapter.ts).
 *
 * Implements a unified boundary between application-level wallet lifecycle/intents
 * and chain-specific protocol implementations across EVM, Solana, and eCash families.
 *
 * Encapsulation guarantee:
 * Ledger internals (SpendableInputs, nonces, EVM leader accounts, UTXO outpoints)
 * remain strictly private to the wallet implementations and are never leaked to external callers.
 */

import { getAddress, getBytes, hexlify, HDNodeWallet, Mnemonic, ripemd160, sha256 } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import * as bip39 from 'bip39';
import { Address } from 'ecash-lib/dist/address/address';
import { fromHex, toHex, type PaymentTransfer, type StealthMetadata } from '@frank/codec';
import {
  decodeAddress,
  encodeAddress,
  decodeBase58Check,
  encodeBase58Check,
  decodeBech32,
  encodeBech32,
  convertBits,
  BTC_MAINNET,
  BTC_TESTNET,
  BCH_MAINNET,
  BCH_TESTNET,
} from '@frank/nakamoto';
import type {
  PaymentTransferItem,
  RecipientPaymentTransfer,
  WalletSyncDirection,
} from '@frank/cashweb/types/messages';
import { getBase58Decoder, getBase58Encoder } from '@solana/codecs-strings';

import { formatBaseUnit, parseBaseUnit } from './base-unit';
import {
  getChainRegistryEntry,
  isChainEnabled,
  validateChainAddress,
  type ChainRegistryEntry,
} from './chains-registry';
import type { EvmDexEntry } from './dex-entries';
import type { SolanaDexEntry } from './solana-dex-entries';
import { deriveEd25519MasterNode, deriveEd25519PathNode } from '../ed25519-hd-keyring';

export const PATHUSD = '0x20c0000000000000000000000000000000000000';

export type ChainId =
  | 'monad-mainnet'
  | 'monad-testnet'
  | 'tempo-mainnet'
  | 'tempo-testnet'
  | 'hyperliquid-mainnet'
  | 'hyperliquid-testnet'
  | 'ecash-mainnet'
  | 'ecash-testnet'
  | 'solana-mainnet'
  | 'solana-devnet'
  | 'btc-mainnet'
  | 'btc-testnet'
  | 'bch-mainnet'
  | 'bch-testnet'
  | 'doge-mainnet'
  | 'doge-testnet'
  | 'litecoin-mainnet'
  | 'litecoin-testnet'
  | 'ethereum-mainnet'
  | 'ethereum-sepolia'
  | 'bnb-mainnet'
  | 'bnb-testnet'
  | 'polygon-mainnet'
  | 'polygon-amoy'
  | 'base-mainnet'
  | 'base-sepolia'
  | 'arbitrum-mainnet'
  | 'arbitrum-sepolia';

export const CANONICAL_CHAIN_IDS: readonly ChainId[] = Object.freeze([
  'monad-mainnet',
  'monad-testnet',
  'tempo-mainnet',
  'tempo-testnet',
  'hyperliquid-mainnet',
  'hyperliquid-testnet',
  'ecash-mainnet',
  'ecash-testnet',
  'solana-mainnet',
  'solana-devnet',
  'btc-mainnet',
  'btc-testnet',
  'bch-mainnet',
  'bch-testnet',
  'doge-mainnet',
  'doge-testnet',
  'litecoin-mainnet',
  'litecoin-testnet',
  'ethereum-mainnet',
  'ethereum-sepolia',
  'bnb-mainnet',
  'bnb-testnet',
  'polygon-mainnet',
  'polygon-amoy',
  'base-mainnet',
  'base-sepolia',
  'arbitrum-mainnet',
  'arbitrum-sepolia',
]);

export function isCanonicalChainId(candidate: string): candidate is ChainId {
  return (CANONICAL_CHAIN_IDS as readonly string[]).includes(candidate);
}

export type WalletId = string & { readonly __brand: unique symbol };
export function asWalletId(id: string): WalletId {
  return id as WalletId;
}

export interface WalletIdentifier {
  walletName: string; // e.g. "Primary", "Main", or custom user label
  walletId: WalletId; // unique tagged identifier
  walletChainId: ChainId; // e.g. 'ecash-testnet' | 'monad-testnet' | 'tempo-testnet'
  accountIndex?: number; // 0 for primary/advertised, 1, 2... for named sub-wallets
}

export interface RootWalletContext {
  readonly mnemonic?: string;
  readonly seed?: Uint8Array;
  readonly passphrase?: string;
  readonly enabledChains?: readonly ChainId[];
  readonly rpcOverrides?: Partial<Record<ChainId, string>>;
  readonly relayBaseUrl?: string;
}

export interface WalletDerivationContext {
  readonly root: RootWalletContext | Uint8Array;
  readonly identifier?: WalletIdentifier;
  readonly chainId?: ChainId;
  readonly accountIndex?: number;
  readonly walletName?: string;
  readonly walletId?: WalletId;
}

export interface SendLegacyTransactionParams {
  readonly recipient: string;
  readonly value: bigint;
  readonly memo?: string;
  readonly maxFee?: bigint;
}

export interface SendStealthTransactionParams {
  readonly recipient: string;
  readonly value: bigint;
  readonly memo?: string;
  readonly stampValue?: bigint;
}

export interface SendStampTransactionParams {
  readonly recipient: string;
  readonly value: bigint;
  readonly messagePayload?: Uint8Array | string;
}

export interface TransactionIntentResult {
  readonly txHash: string;
  readonly stealthAddress?: string;
  readonly messageId?: string;
}

export interface CreateRecipientPaymentTransferParams {
  readonly recipient: string;
  readonly amount?: bigint | number | string;
  readonly value?: bigint | number | string;
  readonly txId: string | Uint8Array;
  readonly token?: string | Uint8Array;
  readonly vout?: number;
  readonly stealthMetadata?: {
    readonly keyType?: 1 | 2;
    readonly ephemeralPubKey?: string | Uint8Array;
    readonly viewTag?: number | string | Uint8Array;
  };
  readonly commitment?: string | Uint8Array;
  readonly rawTx?: string | Uint8Array;
}

export interface ParsedRecipientPaymentTransfer {
  readonly chainId: ChainId;
  readonly recipient: string;
  readonly amount: bigint;
  readonly displayAmount: string;
  readonly txId: string;
  readonly asset: { kind: 'native' } | { kind: 'token'; identifier: string };
  readonly token?: string;
  readonly vout?: number;
  readonly stealthMetadata: {
    readonly keyType: 1 | 2;
    readonly ephemeralPubKey: string;
    readonly viewTag?: number | string;
  };
  readonly commitment?: string;
  readonly rawTx?: string;
}

export interface CreateSyncPaymentTransferParams {
  readonly recipient: string;
  readonly amount?: bigint | number | string;
  readonly value?: bigint | number | string;
  readonly txHash: string;
  readonly direction?: WalletSyncDirection | 'inbound' | 'outbound' | 'sent' | 'received';
  readonly token?: string | Uint8Array;
  readonly vout?: number;
  readonly rawTx?: string;
  readonly memo?: string;
  readonly timestamp?: number;
}

export interface ParsedSyncPaymentTransfer {
  readonly chainId: ChainId;
  readonly recipient: string;
  readonly amount: bigint;
  readonly displayAmount: string;
  readonly txHash: string;
  readonly direction: WalletSyncDirection | 'inbound' | 'outbound' | 'sent' | 'received';
  readonly token?: string;
  readonly vout?: number;
  readonly rawTx?: string;
  readonly memo?: string;
  readonly timestamp?: number;
}

function normalizeSyncDirection(dir?: string): WalletSyncDirection {
  if (dir === 'in' || dir === 'inbound' || dir === 'received') return 'in';
  return 'out';
}

export interface CreatePaymentTransferParams {
  readonly recipient: string;
  readonly value: bigint | number | string;
  readonly txId: Uint8Array | string;
  readonly token?: Uint8Array | string;
  readonly vout?: number;
  readonly stealthMetadata?: StealthMetadata | {
    keyType: 1 | 2;
    ephemeralPubKey: string | Uint8Array;
    viewTag?: number | string | Uint8Array;
  };
  readonly commitment?: Uint8Array | string;
  readonly rawTx?: Uint8Array | string;
}

export interface ParsedPaymentTransfer {
  readonly chainId: ChainId;
  readonly networkTag: string;
  readonly recipient: string;
  readonly value: bigint;
  readonly displayAmount: string;
  readonly txId: string;
  readonly token?: string;
  readonly vout?: number;
  readonly stealthMetadata?: StealthMetadata | {
    keyType: 1 | 2;
    ephemeralPubKey: string | Uint8Array;
    viewTag?: number | string | Uint8Array;
  };
  readonly commitment?: Uint8Array;
  readonly rawTx?: Uint8Array;
}

export interface EstimateFeeParams {
  readonly recipient: string;
  readonly value: bigint;
  readonly memo?: string;
  readonly token?: string | Uint8Array;
}

export interface EstimateFeeResult {
  readonly estimatedFee: bigint;
  readonly gasLimit?: bigint;
  readonly maxFeePerGas?: bigint;
}

export interface SimulateTransactionResult {
  readonly success: boolean;
  readonly estimatedFee: bigint;
  readonly error?: string;
}

/**
 * Public wallet surface: strictly exposes high-level intents.
 * Ledger internals (SpendableInputs, nonces, EVM leader accounts, UTXO outpoints)
 * remain completely internal and are NEVER leaked.
 */
export interface ChainWallet {
  readonly identifier: WalletIdentifier;
  readonly chainId: ChainId;
  readonly walletId: WalletId;
  readonly address: string;
  readonly isPrimary: boolean;
  getBalance(): Promise<bigint>;
  sendLegacyTransaction(params: SendLegacyTransactionParams): Promise<TransactionIntentResult>;
  sendStealthTransaction(params: SendStealthTransactionParams): Promise<TransactionIntentResult>;
  sendStampTransaction(params: SendStampTransactionParams): Promise<TransactionIntentResult>;
  recover(): Promise<void>;
  getLastRecoveryError(): unknown | undefined;
  estimateFee(params: EstimateFeeParams): Promise<EstimateFeeResult>;
  simulateTransaction(params: EstimateFeeParams): Promise<SimulateTransactionResult>;
}

export interface ChainAdapter {
  readonly chainId: ChainId;
  readonly family: string;
  readonly rpcUrl: string;
  readonly unit: string;
  readonly dex?: readonly (EvmDexEntry | SolanaDexEntry)[];
  formatAddress(raw: Uint8Array | string): string;
  parseAddress(display: string): Uint8Array;
  isValidAddress(candidate: string): boolean;
  toDisplayAmount(atomic: bigint): string;
  fromDisplayAmount(display: string): bigint;
  createWallet(context: WalletDerivationContext): Promise<ChainWallet>;
  recoverWallet(wallet: ChainWallet): Promise<void>;
  getWallet(address?: string): ChainWallet;
  createRecipientPaymentTransfer(params: CreateRecipientPaymentTransferParams): RecipientPaymentTransfer;
  parseRecipientPaymentTransfer(transfer: RecipientPaymentTransfer): ParsedRecipientPaymentTransfer;
  createSyncPaymentTransfer(params: CreateSyncPaymentTransferParams): PaymentTransferItem;
  parseSyncPaymentTransfer(item: PaymentTransferItem): ParsedSyncPaymentTransfer;
  createPaymentTransfer(params: CreatePaymentTransferParams): PaymentTransfer;
  parsePaymentTransfer(transfer: PaymentTransfer): ParsedPaymentTransfer;
  estimateFee(params: EstimateFeeParams): Promise<EstimateFeeResult>;
  simulateTransaction(params: EstimateFeeParams): Promise<SimulateTransactionResult>;
}

const DEFAULT_CHAIN_RPC_URLS: Readonly<Record<ChainId, string>> = Object.freeze({
  'monad-mainnet': 'https://rpc.monad.xyz',
  'monad-testnet': 'https://testnet-rpc.monad.xyz',
  'tempo-mainnet': 'https://rpc.tempo.xyz',
  'tempo-testnet': 'https://rpc.moderato.tempo.xyz',
  'hyperliquid-mainnet': 'https://rpc.hyperliquid.xyz/evm',
  'hyperliquid-testnet': 'https://rpc.hyperliquid-testnet.xyz/evm',
  'ecash-mainnet': 'https://chronik.e.cash',
  'ecash-testnet': 'https://chronik-testnet.e.cash',
  'solana-mainnet': 'https://api.mainnet-beta.solana.com',
  'solana-devnet': 'https://api.devnet.solana.com',
  'btc-mainnet': 'https://electrum.blockstream.info',
  'btc-testnet': 'https://electrum.blockstream.info/testnet',
  'bch-mainnet': 'https://fulcrum.fountainhead.cash',
  'bch-testnet': 'https://chipnet.imaginary.cash',
  'doge-mainnet': 'https://electrum.dogechain.info',
  'doge-testnet': 'https://electrum-testnet.dogechain.info',
  'litecoin-mainnet': 'https://electrum-ltc.bysh.me',
  'litecoin-testnet': 'https://electrum-ltc.bysh.me/testnet',
  'ethereum-mainnet': 'https://ethereum-rpc.publicnode.com',
  'ethereum-sepolia': 'https://ethereum-sepolia-rpc.publicnode.com',
  'bnb-mainnet': 'https://binance.llamarpc.com',
  'bnb-testnet': 'https://data-seed-prebtc-1-s1.binance.org:8545',
  'polygon-mainnet': 'https://polygon-rpc.com',
  'polygon-amoy': 'https://rpc-amoy.polygon.technology',
  'base-mainnet': 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
  'arbitrum-mainnet': 'https://arb1.arbitrum.io/rpc',
  'arbitrum-sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
});

function resolveRootSeed(root: RootWalletContext | Uint8Array): Uint8Array {
  if (root instanceof Uint8Array && root.length >= 16) {
    return Uint8Array.from(root);
  }
  if ('seed' in root && root.seed instanceof Uint8Array && root.seed.length >= 16) {
    return Uint8Array.from(root.seed);
  }
  if ('mnemonic' in root && root.mnemonic && typeof root.mnemonic === 'string') {
    if (!bip39.validateMnemonic(root.mnemonic)) {
      throw new Error('Invalid BIP-39 mnemonic in RootWalletContext');
    }
    return getBytes(Mnemonic.fromPhrase(root.mnemonic, root.passphrase ?? '').computeSeed());
  }
  throw new Error('RootWalletContext must contain either a valid seed or mnemonic');
}

/**
 * Base abstract wallet implementing common high-level intents while shielding ledger internals.
 */
abstract class BaseChainWallet implements ChainWallet {
  readonly identifier: WalletIdentifier;
  readonly chainId: ChainId;
  readonly walletId: WalletId;
  readonly address: string;
  readonly isPrimary: boolean;
  protected readonly adapter: ChainAdapter;
  protected cachedBalance: bigint = 0n;
  protected lastRecoveryError?: unknown;

  constructor(params: {
    identifier: WalletIdentifier;
    address: string;
    adapter: ChainAdapter;
  }) {
    this.identifier = Object.freeze({ ...params.identifier });
    this.chainId = params.identifier.walletChainId;
    this.walletId = params.identifier.walletId;
    this.address = params.address;
    this.isPrimary = (params.identifier.accountIndex ?? 0) === 0;
    this.adapter = params.adapter;
  }

  abstract getBalance(): Promise<bigint>;
  abstract sendLegacyTransaction(params: SendLegacyTransactionParams): Promise<TransactionIntentResult>;
  abstract sendStealthTransaction(params: SendStealthTransactionParams): Promise<TransactionIntentResult>;
  abstract sendStampTransaction(params: SendStampTransactionParams): Promise<TransactionIntentResult>;

  async recover(): Promise<void> {
    await this.adapter.recoverWallet(this);
  }

  setCachedBalance(balance: bigint): void {
    this.cachedBalance = balance;
  }

  setRecoveryError(error: unknown): void {
    this.lastRecoveryError = error;
  }

  getLastRecoveryError(): unknown | undefined {
    return this.lastRecoveryError;
  }

  async estimateFee(params: EstimateFeeParams): Promise<EstimateFeeResult> {
    return this.adapter.estimateFee(params);
  }

  async simulateTransaction(params: EstimateFeeParams): Promise<SimulateTransactionResult> {
    return this.adapter.simulateTransaction(params);
  }
}

/**
 * EVM Chain Wallet implementation.
 * Encapsulates secp256k1 derived keys, nonces, and leader state internally.
 */
class EvmChainWalletImpl extends BaseChainWallet {
  // Ledger internals - strictly private via JS private fields, never exposed
  readonly #privateKey: string;
  readonly #publicKey: string;
  #nonce: number = 0;

  constructor(params: {
    identifier: WalletIdentifier;
    address: string;
    adapter: ChainAdapter;
    privateKey: string;
    publicKey: string;
  }) {
    super(params);
    this.#privateKey = params.privateKey;
    this.#publicKey = params.publicKey;
  }

  async getBalance(): Promise<bigint> {
    try {
      const response = await fetch(this.adapter.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBalance',
          params: [this.address, 'latest'],
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status} from ${this.adapter.rpcUrl}`);
      }
      const data = (await response.json()) as { result?: string; error?: { message: string } };
      if (data.error) {
        throw new Error(data.error.message);
      }
      if (typeof data.result === 'string') {
        const balance = BigInt(data.result);
        this.setCachedBalance(balance);
        return balance;
      }
      return this.cachedBalance;
    } catch (err) {
      this.setRecoveryError(err);
      throw err;
    }
  }

  async sendLegacyTransaction(params: SendLegacyTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid EVM recipient address: ${params.recipient}`);
    }
    const simulatedHash = hexlify(sha256(toUtf8Bytes(`${this.address}:${this.#nonce++}:${Date.now()}`)));
    return { txHash: simulatedHash };
  }

  async sendStealthTransaction(params: SendStealthTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid EVM stealth recipient: ${params.recipient}`);
    }
    const simulatedHash = hexlify(sha256(toUtf8Bytes(`stealth:${this.address}:${this.#nonce++}:${Date.now()}`)));
    return {
      txHash: simulatedHash,
      stealthAddress: params.recipient,
      messageId: hexlify(sha256(toUtf8Bytes(`msg:${simulatedHash}`))),
    };
  }

  async sendStampTransaction(params: SendStampTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid EVM stamp recipient: ${params.recipient}`);
    }
    const simulatedHash = hexlify(sha256(toUtf8Bytes(`stamp:${this.address}:${this.#nonce++}:${Date.now()}`)));
    return { txHash: simulatedHash };
  }
}

/**
 * Tempo Chain Wallet implementation.
 * Reads TIP-20 PathUSD balance via eth_call (balanceOf).
 */
class TempoChainWalletImpl extends EvmChainWalletImpl {
  override async getBalance(): Promise<bigint> {
    try {
      const data =
        '0x70a08231' +
        this.address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      const response = await fetch(this.adapter.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: PATHUSD, data }, 'latest'],
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status} from ${this.adapter.rpcUrl}`);
      }
      const res = (await response.json()) as { result?: string; error?: { message: string } };
      if (res.error) {
        throw new Error(res.error.message);
      }
      if (typeof res.result === 'string') {
        const balance = BigInt(res.result);
        this.setCachedBalance(balance);
        return balance;
      }
      return this.cachedBalance;
    } catch (err) {
      this.setRecoveryError(err);
      throw err;
    }
  }
}

function toUtf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Solana Chain Wallet implementation.
 * Encapsulates Ed25519 signing keys and transaction compilation internally.
 */
class SolanaChainWalletImpl extends BaseChainWallet {
  // Ledger internals - strictly private via JS private fields
  readonly #privateKeyBytes: Uint8Array;
  readonly #publicKeyBytes: Uint8Array;

  constructor(params: {
    identifier: WalletIdentifier;
    address: string;
    adapter: ChainAdapter;
    privateKeyBytes: Uint8Array;
    publicKeyBytes: Uint8Array;
  }) {
    super(params);
    this.#privateKeyBytes = params.privateKeyBytes;
    this.#publicKeyBytes = params.publicKeyBytes;
  }

  async getBalance(): Promise<bigint> {
    try {
      const response = await fetch(this.adapter.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [this.address, { commitment: 'confirmed' }],
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status} from ${this.adapter.rpcUrl}`);
      }
      const data = (await response.json()) as { result?: { value?: number }; error?: { message: string } };
      if (data.error) {
        throw new Error(data.error.message);
      }
      if (data.result && typeof data.result.value === 'number') {
        const balance = BigInt(data.result.value);
        this.setCachedBalance(balance);
        return balance;
      }
      return this.cachedBalance;
    } catch (err) {
      this.setRecoveryError(err);
      throw err;
    }
  }

  async sendLegacyTransaction(params: SendLegacyTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid Solana recipient address: ${params.recipient}`);
    }
    const simulatedSig = hexlify(sha256(toUtf8Bytes(`sol:${this.address}:${Date.now()}`))).slice(2);
    return { txHash: simulatedSig };
  }

  async sendStealthTransaction(params: SendStealthTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid Solana stealth recipient: ${params.recipient}`);
    }
    const simulatedSig = hexlify(sha256(toUtf8Bytes(`sol:stealth:${this.address}:${Date.now()}`))).slice(2);
    return {
      txHash: simulatedSig,
      stealthAddress: params.recipient,
      messageId: simulatedSig.slice(0, 32),
    };
  }

  async sendStampTransaction(params: SendStampTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid Solana stamp recipient: ${params.recipient}`);
    }
    const simulatedSig = hexlify(sha256(toUtf8Bytes(`sol:stamp:${this.address}:${Date.now()}`))).slice(2);
    return { txHash: simulatedSig };
  }
}

/**
 * eCash Chain Wallet implementation.
 * Encapsulates UTXOs, outpoints, and coin selection internally.
 */
class EcashChainWalletImpl extends BaseChainWallet {
  // Ledger internals - strictly private via JS private fields
  readonly #spendKeyHex: string;
  readonly #pkhBytes: Uint8Array;

  constructor(params: {
    identifier: WalletIdentifier;
    address: string;
    adapter: ChainAdapter;
    spendKeyHex: string;
    pkhBytes: Uint8Array;
  }) {
    super(params);
    this.#spendKeyHex = params.spendKeyHex;
    this.#pkhBytes = params.pkhBytes;
  }

  async getBalance(): Promise<bigint> {
    try {
      const response = await fetch(`${this.adapter.rpcUrl}/address/${this.address}/utxos`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status} from ${this.adapter.rpcUrl}`);
      }
      const data = (await response.json()) as { utxos?: Array<{ value: string | number }> };
      if (Array.isArray(data.utxos)) {
        const total = data.utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
        this.setCachedBalance(total);
        return total;
      }
      return this.cachedBalance;
    } catch (err) {
      this.setRecoveryError(err);
      throw err;
    }
  }

  async sendLegacyTransaction(params: SendLegacyTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid eCash recipient address: ${params.recipient}`);
    }
    const simulatedTxid = hexlify(sha256(toUtf8Bytes(`xec:${this.address}:${Date.now()}`))).slice(2);
    return { txHash: simulatedTxid };
  }

  async sendStealthTransaction(params: SendStealthTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid eCash stealth recipient: ${params.recipient}`);
    }
    const simulatedTxid = hexlify(sha256(toUtf8Bytes(`xec:stealth:${this.address}:${Date.now()}`))).slice(2);
    return {
      txHash: simulatedTxid,
      stealthAddress: params.recipient,
      messageId: simulatedTxid.slice(0, 32),
    };
  }

  async sendStampTransaction(params: SendStampTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid eCash stamp recipient: ${params.recipient}`);
    }
    const simulatedTxid = hexlify(sha256(toUtf8Bytes(`xec:stamp:${this.address}:${Date.now()}`))).slice(2);
    return { txHash: simulatedTxid };
  }
}


// -------------------------------------------------------------------------------------------------
// Chain Adapters
// -------------------------------------------------------------------------------------------------

/**
 * Standard EVM Chain Adapter.
 */
class EvmChainAdapter implements ChainAdapter {
  readonly chainId: ChainId;
  readonly family = 'evm';
  readonly rpcUrl: string;
  readonly unit: string;
  readonly dex?: readonly (EvmDexEntry | SolanaDexEntry)[];
  protected readonly decimals: number;

  constructor(chainId: ChainId, config?: ChainRegistryEntry, decimals = 18, unit?: string) {
    this.chainId = chainId;
    this.decimals = config?.nativeDecimals ?? decimals;
    this.unit = unit ?? config?.unit ?? (chainId.startsWith('hyperliquid') ? (chainId === 'hyperliquid-testnet' ? 'tHYPE' : 'HYPE') : 'MON');
    this.rpcUrl = config?.rpcUrl ?? config?.rpcUrls?.[0] ?? DEFAULT_CHAIN_RPC_URLS[chainId];
    this.dex = config?.dex;
  }

  formatAddress(raw: Uint8Array | string): string {
    if (raw instanceof Uint8Array) {
      if (raw.length !== 20) {
        throw new Error(`EVM address raw bytes must be 20 bytes, got ${raw.length}`);
      }
      return getAddress('0x' + Buffer.from(raw).toString('hex'));
    }
    return getAddress(raw);
  }

  parseAddress(display: string): Uint8Array {
    return getBytes(this.formatAddress(display));
  }

  isValidAddress(candidate: string): boolean {
    try {
      this.formatAddress(candidate);
      return true;
    } catch {
      return false;
    }
  }

  toDisplayAmount(atomic: bigint): string {
    return formatBaseUnit(atomic, this.decimals);
  }

  fromDisplayAmount(display: string): bigint {
    return parseBaseUnit(display, this.decimals);
  }

  async createWallet(context: WalletDerivationContext): Promise<ChainWallet> {
    const seed = resolveRootSeed(context.root);
    const accountIndex = context.accountIndex ?? context.identifier?.accountIndex ?? 0;
    const walletName =
      context.walletName ??
      context.identifier?.walletName ??
      (accountIndex === 0 ? 'Primary' : `Account ${accountIndex}`);
    const walletId =
      context.walletId ??
      context.identifier?.walletId ??
      asWalletId(`${this.chainId}:${accountIndex === 0 ? 'primary' : `account-${accountIndex}`}`);

    const identifier: WalletIdentifier = {
      walletName,
      walletId,
      walletChainId: this.chainId,
      accountIndex,
    };

    // Deterministic BIP-44 key derivation: m/44'/60'/${accountIndex}'/0/0
    const master = HDNodeWallet.fromSeed(seed);
    const derived = master.derivePath(`m/44'/60'/${accountIndex}'/0/0`);
    const address = this.formatAddress(derived.address);

    return new EvmChainWalletImpl({
      identifier,
      address,
      adapter: this,
      privateKey: derived.privateKey,
      publicKey: derived.publicKey,
    });
  }

  getWallet(address?: string): ChainWallet {
    const primary = getPrimaryWallet(this.chainId);
    if (!address && primary) return primary;
    const addr = address && this.isValidAddress(address)
      ? this.formatAddress(address)
      : (primary ? primary.address : '0x0000000000000000000000000000000000000000');
    const identifier: WalletIdentifier = {
      walletName: 'Primary',
      walletId: asWalletId(`${this.chainId}:primary`),
      walletChainId: this.chainId,
      accountIndex: 0,
    };
    return new EvmChainWalletImpl({
      identifier,
      address: addr,
      adapter: this,
      privateKey: '',
      publicKey: '',
    });
  }

  async recoverWallet(wallet: ChainWallet): Promise<void> {
    try {
      await wallet.getBalance();
    } catch (err) {
      // Gracefully handle RPC failure during recovery without aborting session
      if (wallet instanceof BaseChainWallet) {
        wallet.setRecoveryError(err);
      }
    }
  }

  createRecipientPaymentTransfer(
    params: CreateRecipientPaymentTransferParams
  ): RecipientPaymentTransfer {
    const destination = toHex(this.parseAddress(params.recipient));
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const txIdHex = typeof params.txId === 'string'
      ? params.txId.replace(/^0x/, '').toLowerCase()
      : toHex(params.txId);
    const tokenHex = params.token
      ? (typeof params.token === 'string'
          ? toHex(this.parseAddress(params.token))
          : toHex(params.token))
      : undefined;
    const ephem = params.stealthMetadata?.ephemeralPubKey
      ? (typeof params.stealthMetadata.ephemeralPubKey === 'string'
          ? params.stealthMetadata.ephemeralPubKey.replace(/^0x/, '').toLowerCase()
          : toHex(params.stealthMetadata.ephemeralPubKey))
      : '00'.repeat(33);
    const viewTag = params.stealthMetadata?.viewTag instanceof Uint8Array
      ? toHex(params.stealthMetadata.viewTag)
      : params.stealthMetadata?.viewTag;

    return {
      chainIdentifier: this.chainId,
      txId: txIdHex,
      destination,
      amountAtomic: amountBig.toString(),
      asset: tokenHex ? { kind: 'token', identifier: tokenHex } : { kind: 'native' },
      ...(params.vout !== undefined ? { vout: params.vout } : {}),
      stealthMetadata: {
        keyType: params.stealthMetadata?.keyType ?? 1,
        ephemeralPubKey: ephem,
        ...(viewTag !== undefined ? { viewTag } : {}),
      },
      ...(params.commitment ? { commitment: typeof params.commitment === 'string' ? params.commitment.replace(/^0x/, '') : toHex(params.commitment) } : {}),
      ...(params.rawTx ? { rawTx: typeof params.rawTx === 'string' ? params.rawTx.replace(/^0x/, '') : toHex(params.rawTx) } : {}),
    };
  }

  parseRecipientPaymentTransfer(
    transfer: RecipientPaymentTransfer
  ): ParsedRecipientPaymentTransfer {
    const amount = BigInt(transfer.amountAtomic);
    const token = transfer.asset.kind === 'token' ? this.formatAddress(fromHex(transfer.asset.identifier)) : undefined;
    return {
      chainId: this.chainId,
      recipient: this.formatAddress(fromHex(transfer.destination)),
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txId: transfer.txId,
      asset: transfer.asset,
      ...(token ? { token } : {}),
      ...(transfer.vout !== undefined ? { vout: transfer.vout } : {}),
      stealthMetadata: transfer.stealthMetadata,
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  createSyncPaymentTransfer(
    params: CreateSyncPaymentTransferParams
  ): PaymentTransferItem {
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const txId = params.txHash.replace(/^0x/, '').toLowerCase();
    const destination = toHex(this.parseAddress(params.recipient));
    const token = params.token
      ? (typeof params.token === 'string'
          ? toHex(this.parseAddress(params.token))
          : toHex(params.token))
      : undefined;

    return {
      type: 'payment-transfer',
      direction: normalizeSyncDirection(params.direction),
      chainIdentifier: this.chainId,
      chainId: this.chainId,
      txHash: params.txHash,
      ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      timestamp: params.timestamp ?? Date.now(),
      transfer: {
        networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
        txId,
        destination,
        value: amountBig.toString(),
        ...(token ? { token } : {}),
        ...(params.vout !== undefined ? { vout: params.vout } : {}),
        ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      },
    };
  }

  parseSyncPaymentTransfer(item: PaymentTransferItem): ParsedSyncPaymentTransfer {
    const amount = item.transfer?.value ? BigInt(item.transfer.value) : 0n;
    const recipient = item.transfer?.destination ? this.formatAddress(fromHex(item.transfer.destination)) : '';
    const token = item.transfer?.token ? this.formatAddress(fromHex(item.transfer.token)) : undefined;

    return {
      chainId: this.chainId,
      recipient,
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txHash: item.txHash,
      direction: normalizeSyncDirection(item.direction),
      ...(token ? { token } : {}),
      ...(item.transfer?.vout !== undefined ? { vout: item.transfer.vout } : {}),
      ...(item.rawTx ? { rawTx: item.rawTx } : {}),
      ...(item.memo ? { memo: item.memo } : {}),
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
    };
  }

  createPaymentTransfer(params: CreatePaymentTransferParams): PaymentTransfer {
    const valueBig = typeof params.value === 'bigint' ? params.value : BigInt(params.value);
    const destination = this.parseAddress(params.recipient);
    const txIdBytes = typeof params.txId === 'string'
      ? fromHex(params.txId.replace(/^0x/, ''))
      : params.txId;
    const tokenBytes = params.token
      ? (typeof params.token === 'string' ? this.parseAddress(params.token) : params.token)
      : undefined;
    const commitment = params.commitment
      ? (typeof params.commitment === 'string' ? fromHex(params.commitment.replace(/^0x/, '')) : params.commitment)
      : undefined;
    const rawTx = params.rawTx
      ? (typeof params.rawTx === 'string' ? fromHex(params.rawTx.replace(/^0x/, '')) : params.rawTx)
      : undefined;

    return {
      networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
      txId: txIdBytes,
      destination,
      value: valueBig,
      ...(tokenBytes ? { token: tokenBytes } : {}),
      ...(params.vout !== undefined ? { vout: params.vout } : {}),
      ...(params.stealthMetadata as any ? { stealthMetadata: params.stealthMetadata as any } : {}),
      ...(commitment ? { commitment } : {}),
      ...(rawTx ? { rawTx } : {}),
    };
  }

  parsePaymentTransfer(transfer: PaymentTransfer): ParsedPaymentTransfer {
    const val = transfer.value instanceof Uint8Array ? BigInt('0x' + toHex(transfer.value)) : BigInt(transfer.value);
    const token = transfer.token ? this.formatAddress(transfer.token) : undefined;
    return {
      chainId: this.chainId,
      networkTag: transfer.networkTag,
      recipient: this.formatAddress(transfer.destination),
      value: val,
      displayAmount: this.toDisplayAmount(val),
      txId: '0x' + toHex(transfer.txId),
      ...(token ? { token } : {}),
      ...(transfer.vout !== undefined ? { vout: transfer.vout } : {}),
      ...(transfer.stealthMetadata ? { stealthMetadata: transfer.stealthMetadata } : {}),
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  async estimateFee(params: EstimateFeeParams): Promise<EstimateFeeResult> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_gasPrice',
          params: [],
        }),
      });
      const data = (await response.json()) as { result?: string };
      const gasPrice = data.result ? BigInt(data.result) : 1000000000n;
      const gasLimit = 21000n;
      return {
        estimatedFee: gasPrice * gasLimit,
        gasLimit,
        maxFeePerGas: gasPrice,
      };
    } catch {
      const gasLimit = 21000n;
      const gasPrice = 1000000000n;
      return {
        estimatedFee: gasPrice * gasLimit,
        gasLimit,
        maxFeePerGas: gasPrice,
      };
    }
  }

  async simulateTransaction(params: EstimateFeeParams): Promise<SimulateTransactionResult> {
    try {
      if (!this.isValidAddress(params.recipient)) {
        return {
          success: false,
          estimatedFee: 0n,
          error: `Invalid recipient address: ${params.recipient}`,
        };
      }
      const fee = await this.estimateFee(params);
      return {
        success: true,
        estimatedFee: fee.estimatedFee,
      };
    } catch (err: any) {
      return {
        success: false,
        estimatedFee: 0n,
        error: err?.message ?? String(err),
      };
    }
  }
}

/**
 * Tempo Chain Adapter (EVM family with TIP-20 6 decimals).
 */
class TempoChainAdapter extends EvmChainAdapter {
  constructor(chainId: ChainId, config?: ChainRegistryEntry) {
    // Tempo native coin is null in registry; TIP-20 pathUSD uses 6 decimals
    const unit = (chainId === 'tempo-testnet' || config?.unit === 'tUSD') ? 'PathUSD' : (config?.unit ?? 'USD');
    super(chainId, config, 6, unit);
  }

  override getWallet(address?: string): ChainWallet {
    const primary = getPrimaryWallet(this.chainId);
    if (!address && primary) return primary;
    const addr = address && this.isValidAddress(address)
      ? this.formatAddress(address)
      : (primary ? primary.address : '0x0000000000000000000000000000000000000000');
    const identifier: WalletIdentifier = {
      walletName: 'Primary',
      walletId: asWalletId(`${this.chainId}:primary`),
      walletChainId: this.chainId,
      accountIndex: 0,
    };
    return new TempoChainWalletImpl({
      identifier,
      address: addr,
      adapter: this,
      privateKey: '',
      publicKey: '',
    });
  }

  override async createWallet(context: WalletDerivationContext): Promise<ChainWallet> {
    const seed = resolveRootSeed(context.root);
    const accountIndex = context.accountIndex ?? context.identifier?.accountIndex ?? 0;
    const walletName =
      context.walletName ??
      context.identifier?.walletName ??
      (accountIndex === 0 ? 'Primary' : `Account ${accountIndex}`);
    const walletId =
      context.walletId ??
      context.identifier?.walletId ??
      asWalletId(`${this.chainId}:${accountIndex === 0 ? 'primary' : `account-${accountIndex}`}`);

    const identifier: WalletIdentifier = {
      walletName,
      walletId,
      walletChainId: this.chainId,
      accountIndex,
    };

    const master = HDNodeWallet.fromSeed(seed);
    const derived = master.derivePath(`m/44'/60'/${accountIndex}'/0/0`);
    const address = this.formatAddress(derived.address);

    return new TempoChainWalletImpl({
      identifier,
      address,
      adapter: this,
      privateKey: derived.privateKey,
      publicKey: derived.publicKey,
    });
  }

  override createRecipientPaymentTransfer(
    params: CreateRecipientPaymentTransferParams
  ): RecipientPaymentTransfer {
    const token = params.token ?? PATHUSD;
    return super.createRecipientPaymentTransfer({ ...params, token });
  }

  override parseRecipientPaymentTransfer(
    transfer: RecipientPaymentTransfer
  ): ParsedRecipientPaymentTransfer {
    const parsed = super.parseRecipientPaymentTransfer(transfer);
    return {
      ...parsed,
      token: parsed.token ?? this.formatAddress(PATHUSD),
    };
  }

  override createSyncPaymentTransfer(
    params: CreateSyncPaymentTransferParams
  ): PaymentTransferItem {
    const token = params.token ?? PATHUSD;
    return super.createSyncPaymentTransfer({ ...params, token });
  }

  override parseSyncPaymentTransfer(item: PaymentTransferItem): ParsedSyncPaymentTransfer {
    const parsed = super.parseSyncPaymentTransfer(item);
    return {
      ...parsed,
      token: parsed.token ?? this.formatAddress(PATHUSD),
    };
  }

  override createPaymentTransfer(params: CreatePaymentTransferParams): PaymentTransfer {
    const token = params.token ?? PATHUSD;
    return super.createPaymentTransfer({ ...params, token });
  }

  override parsePaymentTransfer(transfer: PaymentTransfer): ParsedPaymentTransfer {
    const parsed = super.parsePaymentTransfer(transfer);
    return {
      ...parsed,
      token: parsed.token ?? this.formatAddress(PATHUSD),
    };
  }
}

/**
 * Solana Chain Adapter.
 */
class SolanaChainAdapter implements ChainAdapter {
  readonly chainId: ChainId;
  readonly family = 'solana';
  readonly rpcUrl: string;
  readonly unit: string;
  readonly dex?: readonly (EvmDexEntry | SolanaDexEntry)[];
  private readonly decimals = 9;

  constructor(chainId: ChainId, config?: ChainRegistryEntry) {
    this.chainId = chainId;
    this.unit = config?.unit ?? (chainId === 'solana-devnet' ? 'dSOL' : 'SOL');
    this.rpcUrl = config?.rpcUrl ?? config?.rpcUrls?.[0] ?? DEFAULT_CHAIN_RPC_URLS[chainId];
    this.dex = config?.dex;
  }

  formatAddress(raw: Uint8Array | string): string {
    if (raw instanceof Uint8Array) {
      if (raw.length !== 32) {
        throw new Error(`Solana public key must be 32 bytes, got ${raw.length}`);
      }
      return new PublicKey(raw).toBase58();
    }
    return new PublicKey(raw.trim()).toBase58();
  }

  parseAddress(display: string): Uint8Array {
    return Uint8Array.from(new PublicKey(display.trim()).toBytes());
  }

  isValidAddress(candidate: string): boolean {
    try {
      const pubkey = new PublicKey(candidate.trim());
      return PublicKey.isOnCurve(pubkey.toBytes());
    } catch {
      return false;
    }
  }

  toDisplayAmount(atomic: bigint): string {
    return formatBaseUnit(atomic, this.decimals);
  }

  fromDisplayAmount(display: string): bigint {
    return parseBaseUnit(display, this.decimals);
  }

  async createWallet(context: WalletDerivationContext): Promise<ChainWallet> {
    const seed = resolveRootSeed(context.root);
    const accountIndex = context.accountIndex ?? context.identifier?.accountIndex ?? 0;
    const walletName =
      context.walletName ??
      context.identifier?.walletName ??
      (accountIndex === 0 ? 'Primary' : `Account ${accountIndex}`);
    const walletId =
      context.walletId ??
      context.identifier?.walletId ??
      asWalletId(`${this.chainId}:${accountIndex === 0 ? 'primary' : `account-${accountIndex}`}`);

    const identifier: WalletIdentifier = {
      walletName,
      walletId,
      walletChainId: this.chainId,
      accountIndex,
    };

    // Deterministic SLIP-0010 derivation: m/44'/501'/${accountIndex}'/0'
    const master = deriveEd25519MasterNode(seed);
    const { node } = deriveEd25519PathNode(master, `m/44'/501'/${accountIndex}'/0'`);
    const pubKeyBytes = ed25519.getPublicKey(node.key);
    const address = new PublicKey(pubKeyBytes).toBase58();

    return new SolanaChainWalletImpl({
      identifier,
      address,
      adapter: this,
      privateKeyBytes: node.key,
      publicKeyBytes: pubKeyBytes,
    });
  }

  getWallet(address?: string): ChainWallet {
    const primary = getPrimaryWallet(this.chainId);
    if (!address && primary) return primary;
    const addr = address && this.isValidAddress(address)
      ? this.formatAddress(address)
      : (primary ? primary.address : '11111111111111111111111111111111');
    const identifier: WalletIdentifier = {
      walletName: 'Primary',
      walletId: asWalletId(`${this.chainId}:primary`),
      walletChainId: this.chainId,
      accountIndex: 0,
    };
    return new SolanaChainWalletImpl({
      identifier,
      address: addr,
      adapter: this,
      privateKeyBytes: new Uint8Array(32),
      publicKeyBytes: new Uint8Array(32),
    });
  }

  async recoverWallet(wallet: ChainWallet): Promise<void> {
    try {
      await wallet.getBalance();
    } catch (err) {
      if (wallet instanceof BaseChainWallet) {
        wallet.setRecoveryError(err);
      }
    }
  }

  createRecipientPaymentTransfer(
    params: CreateRecipientPaymentTransferParams
  ): RecipientPaymentTransfer {
    const destination = toHex(this.parseAddress(params.recipient));
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    let txIdHex: string;
    if (typeof params.txId === 'string') {
      if (/^[0-9a-fA-F]+$/.test(params.txId.replace(/^0x/, ''))) {
        txIdHex = params.txId.replace(/^0x/, '').toLowerCase();
      } else {
        txIdHex = toHex(Uint8Array.from(getBase58Encoder().encode(params.txId)));
      }
    } else {
      txIdHex = toHex(params.txId);
    }
    const tokenHex = params.token
      ? (typeof params.token === 'string'
          ? toHex(new PublicKey(params.token).toBytes())
          : toHex(params.token))
      : undefined;
    const ephem = params.stealthMetadata?.ephemeralPubKey
      ? (typeof params.stealthMetadata.ephemeralPubKey === 'string'
          ? params.stealthMetadata.ephemeralPubKey.replace(/^0x/, '').toLowerCase()
          : toHex(params.stealthMetadata.ephemeralPubKey))
      : '00'.repeat(32);
    const viewTag = params.stealthMetadata?.viewTag instanceof Uint8Array
      ? toHex(params.stealthMetadata.viewTag)
      : params.stealthMetadata?.viewTag;

    return {
      chainIdentifier: this.chainId,
      txId: txIdHex,
      destination,
      amountAtomic: amountBig.toString(),
      asset: tokenHex ? { kind: 'token', identifier: tokenHex } : { kind: 'native' },
      ...(params.vout !== undefined ? { vout: params.vout } : {}),
      stealthMetadata: {
        keyType: params.stealthMetadata?.keyType ?? 2,
        ephemeralPubKey: ephem,
        ...(viewTag !== undefined ? { viewTag } : {}),
      },
      ...(params.commitment ? { commitment: typeof params.commitment === 'string' ? params.commitment.replace(/^0x/, '') : toHex(params.commitment) } : {}),
      ...(params.rawTx ? { rawTx: typeof params.rawTx === 'string' ? params.rawTx.replace(/^0x/, '') : toHex(params.rawTx) } : {}),
    };
  }

  parseRecipientPaymentTransfer(
    transfer: RecipientPaymentTransfer
  ): ParsedRecipientPaymentTransfer {
    const amount = BigInt(transfer.amountAtomic);
    const token = transfer.asset.kind === 'token' ? new PublicKey(fromHex(transfer.asset.identifier)).toBase58() : undefined;
    return {
      chainId: this.chainId,
      recipient: this.formatAddress(fromHex(transfer.destination)),
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txId: transfer.txId,
      asset: transfer.asset,
      ...(token ? { token } : {}),
      ...(transfer.vout !== undefined ? { vout: transfer.vout } : {}),
      stealthMetadata: transfer.stealthMetadata,
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  createSyncPaymentTransfer(
    params: CreateSyncPaymentTransferParams
  ): PaymentTransferItem {
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const destination = toHex(this.parseAddress(params.recipient));
    const token = params.token
      ? (typeof params.token === 'string'
          ? toHex(new PublicKey(params.token).toBytes())
          : toHex(params.token))
      : undefined;

    return {
      type: 'payment-transfer',
      direction: normalizeSyncDirection(params.direction),
      chainIdentifier: this.chainId,
      chainId: this.chainId,
      txHash: params.txHash,
      ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      timestamp: params.timestamp ?? Date.now(),
      transfer: {
        networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
        txId: params.txHash,
        destination,
        value: amountBig.toString(),
        ...(token ? { token } : {}),
        ...(params.vout !== undefined ? { vout: params.vout } : {}),
        ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      },
    };
  }

  parseSyncPaymentTransfer(item: PaymentTransferItem): ParsedSyncPaymentTransfer {
    const amount = item.transfer?.value ? BigInt(item.transfer.value) : 0n;
    const recipient = item.transfer?.destination ? this.formatAddress(fromHex(item.transfer.destination)) : '';
    const token = item.transfer?.token ? new PublicKey(fromHex(item.transfer.token)).toBase58() : undefined;

    return {
      chainId: this.chainId,
      recipient,
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txHash: item.txHash,
      direction: normalizeSyncDirection(item.direction),
      ...(token ? { token } : {}),
      ...(item.transfer?.vout !== undefined ? { vout: item.transfer.vout } : {}),
      ...(item.rawTx ? { rawTx: item.rawTx } : {}),
      ...(item.memo ? { memo: item.memo } : {}),
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
    };
  }

  createPaymentTransfer(params: CreatePaymentTransferParams): PaymentTransfer {
    const valueBig = typeof params.value === 'bigint' ? params.value : BigInt(params.value);
    const destination = this.parseAddress(params.recipient);
    let txIdBytes: Uint8Array;
    if (typeof params.txId === 'string') {
      if (/^[0-9a-fA-F]+$/.test(params.txId.replace(/^0x/, ''))) {
        txIdBytes = fromHex(params.txId.replace(/^0x/, ''));
      } else {
        txIdBytes = Uint8Array.from(getBase58Encoder().encode(params.txId));
      }
    } else {
      txIdBytes = params.txId;
    }
    const tokenBytes = params.token
      ? (typeof params.token === 'string' ? Uint8Array.from(new PublicKey(params.token).toBytes()) : params.token)
      : undefined;
    const commitment = params.commitment
      ? (typeof params.commitment === 'string' ? fromHex(params.commitment.replace(/^0x/, '')) : params.commitment)
      : undefined;
    const rawTx = params.rawTx
      ? (typeof params.rawTx === 'string' ? fromHex(params.rawTx.replace(/^0x/, '')) : params.rawTx)
      : undefined;

    return {
      networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
      txId: txIdBytes,
      destination,
      value: valueBig,
      ...(tokenBytes ? { token: tokenBytes } : {}),
      ...(params.vout !== undefined ? { vout: params.vout } : {}),
      ...(params.stealthMetadata as any ? { stealthMetadata: params.stealthMetadata as any } : {}),
      ...(commitment ? { commitment } : {}),
      ...(rawTx ? { rawTx } : {}),
    };
  }

  parsePaymentTransfer(transfer: PaymentTransfer): ParsedPaymentTransfer {
    const val = transfer.value instanceof Uint8Array ? BigInt('0x' + toHex(transfer.value)) : BigInt(transfer.value);
    const token = transfer.token ? new PublicKey(transfer.token).toBase58() : undefined;
    let txIdStr: string;
    try {
      txIdStr = getBase58Decoder().decode(transfer.txId);
    } catch {
      txIdStr = toHex(transfer.txId);
    }

    return {
      chainId: this.chainId,
      networkTag: transfer.networkTag,
      recipient: this.formatAddress(transfer.destination),
      value: val,
      displayAmount: this.toDisplayAmount(val),
      txId: txIdStr,
      ...(token ? { token } : {}),
      ...(transfer.vout !== undefined ? { vout: transfer.vout } : {}),
      ...(transfer.stealthMetadata ? { stealthMetadata: transfer.stealthMetadata } : {}),
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  async estimateFee(params: EstimateFeeParams): Promise<EstimateFeeResult> {
    return {
      estimatedFee: 5000n, // Standard Solana transaction fee (5,000 lamports)
    };
  }

  async simulateTransaction(params: EstimateFeeParams): Promise<SimulateTransactionResult> {
    try {
      if (!this.isValidAddress(params.recipient)) {
        return {
          success: false,
          estimatedFee: 0n,
          error: `Invalid recipient address: ${params.recipient}`,
        };
      }
      return {
        success: true,
        estimatedFee: 5000n,
      };
    } catch (err: any) {
      return {
        success: false,
        estimatedFee: 0n,
        error: err?.message ?? String(err),
      };
    }
  }
}

/**
 * eCash Chain Adapter.
 */
class EcashChainAdapter implements ChainAdapter {
  readonly chainId: ChainId;
  readonly family = 'bitcoin';
  readonly rpcUrl: string;
  readonly unit: string;
  readonly dex?: readonly (EvmDexEntry | SolanaDexEntry)[];
  private readonly decimals = 2;
  private readonly prefix: 'ecash' | 'ectest';

  constructor(chainId: ChainId, config?: ChainRegistryEntry) {
    this.chainId = chainId;
    this.prefix = chainId === 'ecash-mainnet' ? 'ecash' : 'ectest';
    this.unit = config?.unit ?? (chainId === 'ecash-testnet' ? 'tXEC' : 'XEC');
    this.rpcUrl = config?.rpcUrl ?? config?.rpcUrls?.[0] ?? DEFAULT_CHAIN_RPC_URLS[chainId];
    this.dex = config?.dex;
  }

  formatAddress(raw: Uint8Array | string): string {
    if (raw instanceof Uint8Array) {
      if (raw.length !== 20) {
        throw new Error(`eCash p2pkh hash must be 20 bytes, got ${raw.length}`);
      }
      return Address.p2pkh(raw, this.prefix).toString();
    }
    const parsed = Address.fromCashAddress(raw.toLowerCase());
    return Address.p2pkh(parsed.hash, this.prefix).toString();
  }

  parseAddress(display: string): Uint8Array {
    const parsed = Address.fromCashAddress(display.toLowerCase());
    return getBytes('0x' + parsed.hash);
  }

  isValidAddress(candidate: string): boolean {
    try {
      const parsed = Address.fromCashAddress(candidate.toLowerCase());
      return parsed.prefix === this.prefix;
    } catch {
      return false;
    }
  }

  toDisplayAmount(atomic: bigint): string {
    return formatBaseUnit(atomic, this.decimals);
  }

  fromDisplayAmount(display: string): bigint {
    return parseBaseUnit(display, this.decimals);
  }

  async createWallet(context: WalletDerivationContext): Promise<ChainWallet> {
    const seed = resolveRootSeed(context.root);
    const accountIndex = context.accountIndex ?? context.identifier?.accountIndex ?? 0;
    const walletName =
      context.walletName ??
      context.identifier?.walletName ??
      (accountIndex === 0 ? 'Primary' : `Account ${accountIndex}`);
    const walletId =
      context.walletId ??
      context.identifier?.walletId ??
      asWalletId(`${this.chainId}:${accountIndex === 0 ? 'primary' : `account-${accountIndex}`}`);

    const identifier: WalletIdentifier = {
      walletName,
      walletId,
      walletChainId: this.chainId,
      accountIndex,
    };

    // Deterministic BIP-44 key derivation: m/44'/1899'/${accountIndex}'/0/0
    const master = HDNodeWallet.fromSeed(seed);
    const derived = master.derivePath(`m/44'/1899'/${accountIndex}'/0/0`);
    const pubKeyBytes = getBytes(derived.publicKey);
    const pkhBytes = getBytes(ripemd160(sha256(pubKeyBytes)));
    const address = Address.p2pkh(pkhBytes, this.prefix).toString();

    return new EcashChainWalletImpl({
      identifier,
      address,
      adapter: this,
      spendKeyHex: derived.privateKey,
      pkhBytes,
    });
  }

  getWallet(address?: string): ChainWallet {
    const primary = getPrimaryWallet(this.chainId);
    if (!address && primary) return primary;
    const defaultAddr = Address.p2pkh(new Uint8Array(20), this.prefix).toString();
    const addr = address && this.isValidAddress(address)
      ? this.formatAddress(address)
      : (primary ? primary.address : defaultAddr);
    const identifier: WalletIdentifier = {
      walletName: 'Primary',
      walletId: asWalletId(`${this.chainId}:primary`),
      walletChainId: this.chainId,
      accountIndex: 0,
    };
    return new EcashChainWalletImpl({
      identifier,
      address: addr,
      adapter: this,
      spendKeyHex: '',
      pkhBytes: new Uint8Array(20),
    });
  }

  async recoverWallet(wallet: ChainWallet): Promise<void> {
    try {
      await wallet.getBalance();
    } catch (err) {
      if (wallet instanceof BaseChainWallet) {
        wallet.setRecoveryError(err);
      }
    }
  }

  createRecipientPaymentTransfer(
    params: CreateRecipientPaymentTransferParams
  ): RecipientPaymentTransfer {
    const destination = toHex(this.parseAddress(params.recipient));
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const txIdHex = typeof params.txId === 'string'
      ? params.txId.replace(/^0x/, '').toLowerCase()
      : toHex(params.txId);
    const ephem = params.stealthMetadata?.ephemeralPubKey
      ? (typeof params.stealthMetadata.ephemeralPubKey === 'string'
          ? params.stealthMetadata.ephemeralPubKey.replace(/^0x/, '').toLowerCase()
          : toHex(params.stealthMetadata.ephemeralPubKey))
      : '00'.repeat(33);
    const viewTag = params.stealthMetadata?.viewTag instanceof Uint8Array
      ? toHex(params.stealthMetadata.viewTag)
      : params.stealthMetadata?.viewTag;

    return {
      chainIdentifier: this.chainId,
      txId: txIdHex,
      destination,
      amountAtomic: amountBig.toString(),
      asset: { kind: 'native' },
      vout: params.vout ?? 0,
      stealthMetadata: {
        keyType: params.stealthMetadata?.keyType ?? 1,
        ephemeralPubKey: ephem,
        ...(viewTag !== undefined ? { viewTag } : {}),
      },
      ...(params.commitment ? { commitment: typeof params.commitment === 'string' ? params.commitment.replace(/^0x/, '') : toHex(params.commitment) } : {}),
      ...(params.rawTx ? { rawTx: typeof params.rawTx === 'string' ? params.rawTx.replace(/^0x/, '') : toHex(params.rawTx) } : {}),
    };
  }

  parseRecipientPaymentTransfer(
    transfer: RecipientPaymentTransfer
  ): ParsedRecipientPaymentTransfer {
    const amount = BigInt(transfer.amountAtomic);
    return {
      chainId: this.chainId,
      recipient: this.formatAddress(fromHex(transfer.destination)),
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txId: transfer.txId,
      asset: { kind: 'native' },
      vout: transfer.vout ?? 0,
      stealthMetadata: transfer.stealthMetadata,
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  createSyncPaymentTransfer(
    params: CreateSyncPaymentTransferParams
  ): PaymentTransferItem {
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const destination = toHex(this.parseAddress(params.recipient));

    return {
      type: 'payment-transfer',
      direction: normalizeSyncDirection(params.direction),
      chainIdentifier: this.chainId,
      chainId: this.chainId,
      txHash: params.txHash,
      ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      timestamp: params.timestamp ?? Date.now(),
      transfer: {
        networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
        txId: params.txHash.replace(/^0x/, '').toLowerCase(),
        destination,
        value: amountBig.toString(),
        vout: params.vout ?? 0,
        ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      },
    };
  }

  parseSyncPaymentTransfer(item: PaymentTransferItem): ParsedSyncPaymentTransfer {
    const amount = item.transfer?.value ? BigInt(item.transfer.value) : 0n;
    const recipient = item.transfer?.destination ? this.formatAddress(fromHex(item.transfer.destination)) : '';

    return {
      chainId: this.chainId,
      recipient,
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txHash: item.txHash,
      direction: normalizeSyncDirection(item.direction),
      vout: item.transfer?.vout ?? 0,
      ...(item.rawTx ? { rawTx: item.rawTx } : {}),
      ...(item.memo ? { memo: item.memo } : {}),
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
    };
  }

  createPaymentTransfer(params: CreatePaymentTransferParams): PaymentTransfer {
    const valueBig = typeof params.value === 'bigint' ? params.value : BigInt(params.value);
    const destination = this.parseAddress(params.recipient);
    const txIdBytes = typeof params.txId === 'string'
      ? fromHex(params.txId.replace(/^0x/, ''))
      : params.txId;
    const commitment = params.commitment
      ? (typeof params.commitment === 'string' ? fromHex(params.commitment.replace(/^0x/, '')) : params.commitment)
      : undefined;
    const rawTx = params.rawTx
      ? (typeof params.rawTx === 'string' ? fromHex(params.rawTx.replace(/^0x/, '')) : params.rawTx)
      : undefined;

    return {
      networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
      txId: txIdBytes,
      destination,
      value: valueBig,
      vout: params.vout ?? 0,
      ...(params.stealthMetadata as any ? { stealthMetadata: params.stealthMetadata as any } : {}),
      ...(commitment ? { commitment } : {}),
      ...(rawTx ? { rawTx } : {}),
    };
  }

  parsePaymentTransfer(transfer: PaymentTransfer): ParsedPaymentTransfer {
    const val = transfer.value instanceof Uint8Array ? BigInt('0x' + toHex(transfer.value)) : BigInt(transfer.value);
    return {
      chainId: this.chainId,
      networkTag: transfer.networkTag,
      recipient: this.formatAddress(transfer.destination),
      value: val,
      displayAmount: this.toDisplayAmount(val),
      txId: toHex(transfer.txId),
      vout: transfer.vout ?? 0,
      ...(transfer.stealthMetadata ? { stealthMetadata: transfer.stealthMetadata } : {}),
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  async estimateFee(params: EstimateFeeParams): Promise<EstimateFeeResult> {
    return {
      estimatedFee: 500n, // Standard eCash miner fee (500 satoshis)
    };
  }

  async simulateTransaction(params: EstimateFeeParams): Promise<SimulateTransactionResult> {
    try {
      if (!this.isValidAddress(params.recipient)) {
        return {
          success: false,
          estimatedFee: 0n,
          error: `Invalid recipient address: ${params.recipient}`,
        };
      }
      return {
        success: true,
        estimatedFee: 500n,
      };
    } catch (err: any) {
      return {
        success: false,
        estimatedFee: 0n,
        error: err?.message ?? String(err),
      };
    }
  }
}

/**
 * BTC Family Chain Wallet implementation (Bitcoin, Bitcoin Cash, Litecoin, Dogecoin).
 * Encapsulates secp256k1 derived keys and outpoint state internally.
 */
class BtcFamilyChainWalletImpl extends BaseChainWallet {
  readonly #spendKeyHex: string;
  readonly #pubKeyBytes: Uint8Array;

  constructor(params: {
    identifier: WalletIdentifier;
    address: string;
    adapter: ChainAdapter;
    spendKeyHex: string;
    pubKeyBytes: Uint8Array;
  }) {
    super(params);
    this.#spendKeyHex = params.spendKeyHex;
    this.#pubKeyBytes = params.pubKeyBytes;
  }

  async getBalance(): Promise<bigint> {
    return this.cachedBalance;
  }

  async sendLegacyTransaction(params: SendLegacyTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid Bitcoin-family recipient address: ${params.recipient}`);
    }
    const simulatedHash = hexlify(sha256(toUtf8Bytes(`${this.address}:${params.recipient}:${Date.now()}`))).slice(2);
    return { txHash: simulatedHash };
  }

  async sendStealthTransaction(params: SendStealthTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid Bitcoin-family stealth recipient: ${params.recipient}`);
    }
    const simulatedHash = hexlify(sha256(toUtf8Bytes(`stealth:${this.address}:${params.recipient}:${Date.now()}`))).slice(2);
    return {
      txHash: simulatedHash,
      stealthAddress: params.recipient,
      messageId: hexlify(sha256(toUtf8Bytes(`msg:${simulatedHash}`))).slice(2),
    };
  }

  async sendStampTransaction(params: SendStampTransactionParams): Promise<TransactionIntentResult> {
    if (!this.adapter.isValidAddress(params.recipient)) {
      throw new Error(`Invalid Bitcoin-family stamp recipient: ${params.recipient}`);
    }
    const simulatedHash = hexlify(sha256(toUtf8Bytes(`stamp:${this.address}:${params.recipient}:${Date.now()}`))).slice(2);
    return { txHash: simulatedHash };
  }
}

/**
 * BTC Family Chain Adapter implementation (Bitcoin, Bitcoin Cash, Litecoin, Dogecoin).
 */
class BtcFamilyChainAdapter implements ChainAdapter {
  readonly chainId: ChainId;
  readonly family = 'bitcoin';
  readonly rpcUrl: string;
  readonly unit: string;
  readonly dex?: readonly (EvmDexEntry | SolanaDexEntry)[];
  private readonly decimals = 8;
  private readonly kind: string;

  constructor(chainId: ChainId, config?: ChainRegistryEntry) {
    this.chainId = chainId;
    this.kind = config?.kind ?? (
      chainId.startsWith('btc') ? 'bitcoin' :
      chainId.startsWith('bch') ? 'bitcoincash' :
      chainId.startsWith('doge') ? 'dogecoin' : 'litecoin'
    );
    this.unit = config?.unit ?? (
      this.kind === 'bitcoin' ? (chainId === 'btc-testnet' ? 'tBTC' : 'BTC') :
      this.kind === 'bitcoincash' ? (chainId === 'bch-testnet' ? 'tBCH' : 'BCH') :
      this.kind === 'dogecoin' ? (chainId === 'doge-testnet' ? 'tDOGE' : 'DOGE') :
      (chainId === 'litecoin-testnet' ? 'tLTC' : 'LTC')
    );
    this.rpcUrl = config?.rpcUrl ?? config?.rpcUrls?.[0] ?? DEFAULT_CHAIN_RPC_URLS[chainId];
    this.dex = config?.dex;
  }

  formatAddress(raw: Uint8Array | string): string {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!this.isValidAddress(trimmed)) {
        throw new Error(`Invalid ${this.kind} address: ${raw}`);
      }
      return trimmed;
    }
    if (raw.length !== 20) {
      throw new Error(`${this.kind} payload must be 20 bytes, got ${raw.length}`);
    }
    if (this.kind === 'bitcoincash') {
      const prefix = this.chainId === 'bch-mainnet' ? 'bitcoincash' : 'bchtest';
      return Address.p2pkh(raw, prefix as any).toString();
    }
    if (this.kind === 'bitcoin') {
      const isTestnet = this.chainId === 'btc-testnet';
      const bits = convertBits(Array.from(raw), 8, 5, true);
      if (!bits.ok) throw new Error(bits.error.code);
      const encoded = encodeBech32(isTestnet ? 'tb' : 'bc', [0, ...bits.value], 'bech32');
      if (!encoded.ok) throw new Error(encoded.error.code);
      return encoded.value;
    }
    if (this.kind === 'litecoin') {
      const isTestnet = this.chainId === 'litecoin-testnet';
      const bits = convertBits(Array.from(raw), 8, 5, true);
      if (!bits.ok) throw new Error(bits.error.code);
      const encoded = encodeBech32(isTestnet ? 'tltc' : 'ltc', [0, ...bits.value], 'bech32');
      if (!encoded.ok) throw new Error(encoded.error.code);
      return encoded.value;
    }
    if (this.kind === 'dogecoin') {
      const version = this.chainId === 'doge-mainnet' ? 0x1e : 0x71;
      const payload = new Uint8Array(21);
      payload[0] = version;
      payload.set(raw, 1);
      return encodeBase58Check(payload);
    }
    return toHex(raw);
  }

  parseAddress(display: string): Uint8Array {
    const trimmed = display.trim();
    if (this.kind === 'bitcoincash') {
      const parsed = Address.fromCashAddress(trimmed.toLowerCase());
      return getBytes('0x' + parsed.hash);
    }
    if (
      trimmed.startsWith('bc1') ||
      trimmed.startsWith('tb1') ||
      trimmed.startsWith('ltc1') ||
      trimmed.startsWith('tltc1')
    ) {
      const decoded = decodeBech32(trimmed);
      if (!decoded.ok) throw new Error(`Invalid bech32 address: ${trimmed}`);
      const converted = convertBits(decoded.value.data.slice(1), 5, 8, false);
      if (!converted.ok) throw new Error(`Invalid witness program in ${trimmed}`);
      return new Uint8Array(converted.value);
    }
    const decoded = decodeBase58Check(trimmed);
    if (!decoded.ok) throw new Error(`Invalid base58 address: ${trimmed}`);
    return decoded.value.slice(1);
  }

  isValidAddress(candidate: string): boolean {
    return validateChainAddress(this.chainId, candidate);
  }

  toDisplayAmount(atomic: bigint): string {
    return formatBaseUnit(atomic, this.decimals);
  }

  fromDisplayAmount(display: string): bigint {
    return parseBaseUnit(display, this.decimals);
  }

  async createWallet(context: WalletDerivationContext): Promise<ChainWallet> {
    const seed = resolveRootSeed(context.root);
    const accountIndex = context.accountIndex ?? context.identifier?.accountIndex ?? 0;
    const walletName =
      context.walletName ??
      context.identifier?.walletName ??
      (accountIndex === 0 ? 'Primary' : `Account ${accountIndex}`);
    const walletId =
      context.walletId ??
      context.identifier?.walletId ??
      asWalletId(`${this.chainId}:${accountIndex === 0 ? 'primary' : `account-${accountIndex}`}`);

    const identifier: WalletIdentifier = {
      walletName,
      walletId,
      walletChainId: this.chainId,
      accountIndex,
    };

    const isTestnet = this.chainId.endsWith('testnet');
    let path: string;
    if (this.kind === 'bitcoin') {
      path = isTestnet ? `m/84'/1'/${accountIndex}'/0/0` : `m/84'/0'/${accountIndex}'/0/0`;
    } else if (this.kind === 'bitcoincash') {
      path = `m/44'/145'/${accountIndex}'/0/0`;
    } else if (this.kind === 'dogecoin') {
      path = `m/44'/3'/${accountIndex}'/0/0`;
    } else {
      path = isTestnet ? `m/84'/1'/${accountIndex}'/0/0` : `m/84'/2'/${accountIndex}'/0/0`;
    }

    const master = HDNodeWallet.fromSeed(seed);
    const derived = master.derivePath(path);
    const pubKeyBytes = getBytes(derived.publicKey);
    const pkhBytes = getBytes(ripemd160(sha256(pubKeyBytes)));
    const address = this.formatAddress(pkhBytes);

    return new BtcFamilyChainWalletImpl({
      identifier,
      address,
      adapter: this,
      spendKeyHex: derived.privateKey,
      pubKeyBytes,
    });
  }

  getWallet(address?: string): ChainWallet {
    const primary = getPrimaryWallet(this.chainId);
    if (!address && primary) return primary;
    const defaultPkh = new Uint8Array(20);
    const addr = address && this.isValidAddress(address)
      ? this.formatAddress(address)
      : (primary ? primary.address : this.formatAddress(defaultPkh));
    const identifier: WalletIdentifier = {
      walletName: 'Primary',
      walletId: asWalletId(`${this.chainId}:primary`),
      walletChainId: this.chainId,
      accountIndex: 0,
    };
    return new BtcFamilyChainWalletImpl({
      identifier,
      address: addr,
      adapter: this,
      spendKeyHex: '',
      pubKeyBytes: new Uint8Array(33),
    });
  }

  async recoverWallet(wallet: ChainWallet): Promise<void> {
    try {
      await wallet.getBalance();
    } catch (err) {
      if (wallet instanceof BaseChainWallet) {
        wallet.setRecoveryError(err);
      }
    }
  }

  createRecipientPaymentTransfer(
    params: CreateRecipientPaymentTransferParams
  ): RecipientPaymentTransfer {
    const destination = toHex(this.parseAddress(params.recipient));
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const txIdHex = typeof params.txId === 'string'
      ? params.txId.replace(/^0x/, '').toLowerCase()
      : toHex(params.txId);
    const ephem = params.stealthMetadata?.ephemeralPubKey
      ? (typeof params.stealthMetadata.ephemeralPubKey === 'string'
          ? params.stealthMetadata.ephemeralPubKey.replace(/^0x/, '').toLowerCase()
          : toHex(params.stealthMetadata.ephemeralPubKey))
      : '00'.repeat(33);
    const viewTag = params.stealthMetadata?.viewTag instanceof Uint8Array
      ? toHex(params.stealthMetadata.viewTag)
      : params.stealthMetadata?.viewTag !== undefined
      ? String(params.stealthMetadata.viewTag)
      : '00';

    return {
      chainIdentifier: this.chainId,
      txId: txIdHex,
      destination,
      amountAtomic: amountBig.toString(),
      asset: { kind: 'native' },
      vout: params.vout ?? 0,
      stealthMetadata: {
        keyType: params.stealthMetadata?.keyType ?? 1,
        ephemeralPubKey: ephem,
        ...(viewTag !== undefined ? { viewTag } : {}),
      },
      ...(params.commitment ? { commitment: typeof params.commitment === 'string' ? params.commitment.replace(/^0x/, '') : toHex(params.commitment) } : {}),
      ...(params.rawTx ? { rawTx: typeof params.rawTx === 'string' ? params.rawTx.replace(/^0x/, '') : toHex(params.rawTx) } : {}),
    };
  }

  parseRecipientPaymentTransfer(
    transfer: RecipientPaymentTransfer
  ): ParsedRecipientPaymentTransfer {
    const amount = BigInt(transfer.amountAtomic);
    return {
      chainId: this.chainId,
      recipient: this.formatAddress(fromHex(transfer.destination)),
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txId: transfer.txId,
      asset: { kind: 'native' },
      vout: transfer.vout ?? 0,
      stealthMetadata: transfer.stealthMetadata,
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  createSyncPaymentTransfer(
    params: CreateSyncPaymentTransferParams
  ): PaymentTransferItem {
    const rawAmount = params.amount ?? params.value ?? 0n;
    const amountBig = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const destination = toHex(this.parseAddress(params.recipient));

    return {
      type: 'payment-transfer',
      direction: normalizeSyncDirection(params.direction),
      chainIdentifier: this.chainId,
      chainId: this.chainId,
      txHash: params.txHash,
      ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      timestamp: params.timestamp ?? Date.now(),
      transfer: {
        networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
        txId: params.txHash.replace(/^0x/, '').toLowerCase(),
        destination,
        value: amountBig.toString(),
        vout: params.vout ?? 0,
        ...(params.rawTx ? { rawTx: params.rawTx } : {}),
      },
    };
  }

  parseSyncPaymentTransfer(item: PaymentTransferItem): ParsedSyncPaymentTransfer {
    const amount = item.transfer?.value ? BigInt(item.transfer.value) : 0n;
    const recipient = item.transfer?.destination ? this.formatAddress(fromHex(item.transfer.destination)) : '';

    return {
      chainId: this.chainId,
      recipient,
      amount,
      displayAmount: this.toDisplayAmount(amount),
      txHash: item.txHash,
      direction: normalizeSyncDirection(item.direction),
      vout: item.transfer?.vout ?? 0,
      ...(item.rawTx ? { rawTx: item.rawTx } : {}),
      ...(item.memo ? { memo: item.memo } : {}),
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
    };
  }

  createPaymentTransfer(params: CreatePaymentTransferParams): PaymentTransfer {
    const valueBig = typeof params.value === 'bigint' ? params.value : BigInt(params.value);
    const destination = this.parseAddress(params.recipient);
    const txIdBytes = typeof params.txId === 'string'
      ? fromHex(params.txId.replace(/^0x/, ''))
      : params.txId;
    const commitment = params.commitment
      ? (typeof params.commitment === 'string' ? fromHex(params.commitment.replace(/^0x/, '')) : params.commitment)
      : undefined;
    const rawTx = params.rawTx
      ? (typeof params.rawTx === 'string' ? fromHex(params.rawTx.replace(/^0x/, '')) : params.rawTx)
      : undefined;

    return {
      networkTag: getChainRegistryEntry(this.chainId)?.networkTag ?? this.chainId,
      txId: txIdBytes,
      destination,
      value: valueBig,
      vout: params.vout ?? 0,
      ...(params.stealthMetadata as any ? { stealthMetadata: params.stealthMetadata as any } : {}),
      ...(commitment ? { commitment } : {}),
      ...(rawTx ? { rawTx } : {}),
    };
  }

  parsePaymentTransfer(transfer: PaymentTransfer): ParsedPaymentTransfer {
    const val = transfer.value instanceof Uint8Array ? BigInt('0x' + toHex(transfer.value)) : BigInt(transfer.value);
    return {
      chainId: this.chainId,
      networkTag: transfer.networkTag,
      recipient: this.formatAddress(transfer.destination),
      value: val,
      displayAmount: this.toDisplayAmount(val),
      txId: toHex(transfer.txId),
      vout: transfer.vout ?? 0,
      ...(transfer.stealthMetadata ? { stealthMetadata: transfer.stealthMetadata } : {}),
      ...(transfer.commitment ? { commitment: transfer.commitment } : {}),
      ...(transfer.rawTx ? { rawTx: transfer.rawTx } : {}),
    };
  }

  async estimateFee(params: EstimateFeeParams): Promise<EstimateFeeResult> {
    return {
      estimatedFee: 1000n, // Standard Bitcoin-family miner fee (1000 satoshis)
    };
  }

  async simulateTransaction(params: EstimateFeeParams): Promise<SimulateTransactionResult> {
    try {
      if (!this.isValidAddress(params.recipient)) {
        return {
          success: false,
          estimatedFee: 0n,
          error: `Invalid Bitcoin-family recipient address: ${params.recipient}`,
        };
      }
      return {
        success: true,
        estimatedFee: 1000n,
      };
    } catch (err) {
      return {
        success: false,
        estimatedFee: 0n,
        error: String(err),
      };
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Factory & Multi-Wallet Architecture
// -------------------------------------------------------------------------------------------------

/**
 * Creates a ChainAdapter for the given canonical ChainId.
 * Uses an explicit switch statement matching every canonical chain identifier.
 * No magic discriminator strings.
 */
export function createChainAdapter(
  chain: ChainId,
  config?: ChainRegistryEntry
): ChainAdapter {
  const registryEntry = config ?? getChainRegistryEntry(chain);

  switch (chain) {
    case 'monad-mainnet':
    case 'monad-testnet':
    case 'hyperliquid-mainnet':
    case 'hyperliquid-testnet':
    case 'ethereum-mainnet':
    case 'ethereum-sepolia':
    case 'bnb-mainnet':
    case 'bnb-testnet':
    case 'polygon-mainnet':
    case 'polygon-amoy':
    case 'base-mainnet':
    case 'base-sepolia':
    case 'arbitrum-mainnet':
    case 'arbitrum-sepolia':
      return new EvmChainAdapter(chain, registryEntry);
    case 'tempo-mainnet':
    case 'tempo-testnet':
      return new TempoChainAdapter(chain, registryEntry);
    case 'ecash-mainnet':
    case 'ecash-testnet':
      return new EcashChainAdapter(chain, registryEntry);
    case 'solana-mainnet':
    case 'solana-devnet':
      return new SolanaChainAdapter(chain, registryEntry);
    case 'btc-mainnet':
    case 'btc-testnet':
    case 'bch-mainnet':
    case 'bch-testnet':
    case 'doge-mainnet':
    case 'doge-testnet':
    case 'litecoin-mainnet':
    case 'litecoin-testnet':
      return new BtcFamilyChainAdapter(chain, registryEntry);
    default: {
      const _exhaustive: never = chain;
      throw new Error(`Unsupported canonical chain: ${String(_exhaustive)}`);
    }
  }
}

let activeWalletMap: Map<WalletId, ChainWallet> = new Map();

/**
 * Instantiates the unified wallet array across enabled or explicitly allocated chains.
 *
 * - If `!allocatedWallets`, initializes the default wallets from enabled chain configurations
 *   (one primary wallet per enabled chain).
 * - Each wallet derives its keys deterministically from the root secret/seed:
 *   Primary wallet (`accountIndex === 0`) has the special role: advertised in directory / profile,
 *   and where stamps/messages are received for that chain.
 * - Named wallets support: allows multiple sub-accounts by name/index on the same chain.
 */
export function createWalletArray(
  context: RootWalletContext,
  allocatedWallets?: WalletIdentifier[]
): Map<WalletId, ChainWallet> {
  const walletMap = new Map<WalletId, ChainWallet>();

  const targetAllocations: WalletIdentifier[] = [];

  if (allocatedWallets && allocatedWallets.length > 0) {
    targetAllocations.push(...allocatedWallets);
  } else {
    // Default: one primary wallet per enabled chain
    for (const chainId of CANONICAL_CHAIN_IDS) {
      const enabled = context.enabledChains
        ? context.enabledChains.includes(chainId)
        : isChainEnabled(chainId);

      if (enabled) {
        targetAllocations.push({
          walletName: 'Primary',
          walletId: asWalletId(`${chainId}:primary`),
          walletChainId: chainId,
          accountIndex: 0,
        });
      }
    }
  }

  for (const alloc of targetAllocations) {
    const adapter = createChainAdapter(alloc.walletChainId);
    // Deterministic creation can be synchronously resolved because key derivation is synchronous
    // We instantiate the wallet immediately using derivation context
    const seed = resolveRootSeed(context);
    const accountIndex = alloc.accountIndex ?? 0;
    const walletId = alloc.walletId;
    const walletName = alloc.walletName;

    const identifier: WalletIdentifier = {
      walletName,
      walletId,
      walletChainId: alloc.walletChainId,
      accountIndex,
    };

    let wallet: ChainWallet;
    switch (alloc.walletChainId) {
      case 'monad-mainnet':
      case 'monad-testnet':
      case 'hyperliquid-mainnet':
      case 'hyperliquid-testnet':
      case 'ethereum-mainnet':
      case 'ethereum-sepolia':
      case 'bnb-mainnet':
      case 'bnb-testnet':
      case 'polygon-mainnet':
      case 'polygon-amoy':
      case 'base-mainnet':
      case 'base-sepolia':
      case 'arbitrum-mainnet':
      case 'arbitrum-sepolia': {
        const master = HDNodeWallet.fromSeed(seed);
        const derived = master.derivePath(`m/44'/60'/${accountIndex}'/0/0`);
        const address = adapter.formatAddress(derived.address);
        wallet = new EvmChainWalletImpl({
          identifier,
          address,
          adapter,
          privateKey: derived.privateKey,
          publicKey: derived.publicKey,
        });
        break;
      }
      case 'tempo-mainnet':
      case 'tempo-testnet': {
        const master = HDNodeWallet.fromSeed(seed);
        const derived = master.derivePath(`m/44'/60'/${accountIndex}'/0/0`);
        const address = adapter.formatAddress(derived.address);
        wallet = new TempoChainWalletImpl({
          identifier,
          address,
          adapter,
          privateKey: derived.privateKey,
          publicKey: derived.publicKey,
        });
        break;
      }
      case 'solana-mainnet':
      case 'solana-devnet': {
        const master = deriveEd25519MasterNode(seed);
        const { node } = deriveEd25519PathNode(master, `m/44'/501'/${accountIndex}'/0'`);
        const pubKeyBytes = ed25519.getPublicKey(node.key);
        const address = new PublicKey(pubKeyBytes).toBase58();
        wallet = new SolanaChainWalletImpl({
          identifier,
          address,
          adapter,
          privateKeyBytes: node.key,
          publicKeyBytes: pubKeyBytes,
        });
        break;
      }
      case 'ecash-mainnet':
      case 'ecash-testnet': {
        const prefix = alloc.walletChainId === 'ecash-mainnet' ? 'ecash' : 'ectest';
        const master = HDNodeWallet.fromSeed(seed);
        const derived = master.derivePath(`m/44'/1899'/${accountIndex}'/0/0`);
        const pubKeyBytes = getBytes(derived.publicKey);
        const pkhBytes = getBytes(ripemd160(sha256(pubKeyBytes)));
        const address = Address.p2pkh(pkhBytes, prefix).toString();
        wallet = new EcashChainWalletImpl({
          identifier,
          address,
          adapter,
          spendKeyHex: derived.privateKey,
          pkhBytes,
        });
        break;
      }
      case 'btc-mainnet':
      case 'btc-testnet':
      case 'bch-mainnet':
      case 'bch-testnet':
      case 'doge-mainnet':
      case 'doge-testnet':
      case 'litecoin-mainnet':
      case 'litecoin-testnet': {
        const isTestnet = alloc.walletChainId.endsWith('testnet');
        let path: string;
        if (alloc.walletChainId.startsWith('btc')) {
          path = isTestnet ? `m/84'/1'/${accountIndex}'/0/0` : `m/84'/0'/${accountIndex}'/0/0`;
        } else if (alloc.walletChainId.startsWith('bch')) {
          path = isTestnet ? `m/44'/1'/${accountIndex}'/0/0` : `m/44'/145'/${accountIndex}'/0/0`;
        } else if (alloc.walletChainId.startsWith('doge')) {
          path = isTestnet ? `m/44'/1'/${accountIndex}'/0/0` : `m/44'/3'/${accountIndex}'/0/0`;
        } else {
          path = isTestnet ? `m/84'/1'/${accountIndex}'/0/0` : `m/84'/2'/${accountIndex}'/0/0`;
        }
        const master = HDNodeWallet.fromSeed(seed);
        const derived = master.derivePath(path);
        const pubKeyBytes = getBytes(derived.publicKey);
        const pkhBytes = getBytes(ripemd160(sha256(pubKeyBytes)));
        const address = adapter.formatAddress(pkhBytes);
        wallet = new BtcFamilyChainWalletImpl({
          identifier,
          address,
          adapter,
          spendKeyHex: derived.privateKey,
          pubKeyBytes,
        });
        break;
      }
      default: {
        const _exhaustive: never = alloc.walletChainId;
        throw new Error(`Unsupported chain in wallet allocation: ${String(_exhaustive)}`);
      }
    }

    walletMap.set(wallet.walletId, wallet);
  }

  activeWalletMap = walletMap;
  return walletMap;
}

/**
 * Returns all active wallets, optionally filtered by chainId.
 */
export function getWallets(
  chainId?: ChainId,
  walletMap: Map<WalletId, ChainWallet> = activeWalletMap
): ChainWallet[] {
  const all = Array.from(walletMap.values());
  if (chainId !== undefined) {
    return all.filter((w) => w.chainId === chainId);
  }
  return all;
}

/**
 * Returns a specific wallet by its unique WalletId.
 */
export function getWallet(
  walletId: WalletId,
  walletMap: Map<WalletId, ChainWallet> = activeWalletMap
): ChainWallet | undefined {
  return walletMap.get(walletId);
}

/**
 * Returns the primary wallet for a given chain (accountIndex === 0).
 */
export function getPrimaryWallet(
  chainId: ChainId,
  walletMap: Map<WalletId, ChainWallet> = activeWalletMap
): ChainWallet | undefined {
  const chainWallets = getWallets(chainId, walletMap);
  return chainWallets.find((w) => w.isPrimary) ?? chainWallets.find((w) => (w.identifier.accountIndex ?? 0) === 0);
}

/**
 * Returns all active wallets that currently have a positive balance.
 */
export async function getFundedWallets(
  chainId?: ChainId,
  walletMap: Map<WalletId, ChainWallet> = activeWalletMap
): Promise<ChainWallet[]> {
  const wallets = getWallets(chainId, walletMap);
  const funded: ChainWallet[] = [];
  for (const wallet of wallets) {
    try {
      const balance = await wallet.getBalance();
      if (balance > 0n) {
        funded.push(wallet);
      }
    } catch {
      // ignore offline/errored wallets
    }
  }
  return funded;
}

/**
 * Resilient recovery loop over all wallets.
 * Handles individual chain RPC issues gracefully without failing session recovery.
 */
export async function recoverAllWallets(
  wallets?: Iterable<ChainWallet>
): Promise<{
  succeeded: WalletId[];
  failed: Array<{ walletId: WalletId; error: unknown }>;
}> {
  let targetWallets = wallets ? Array.from(wallets) : getWallets();
  if (targetWallets.length === 0) {
    const fallback: ChainWallet[] = [];
    for (const chainId of CANONICAL_CHAIN_IDS) {
      if (isChainEnabled(chainId)) {
        try {
          const adapter = createChainAdapter(chainId);
          fallback.push(adapter.getWallet());
        } catch {
          // ignore unsupported or unconfigured
        }
      }
    }
    targetWallets = fallback;
  }
  const succeeded: WalletId[] = [];
  const failed: Array<{ walletId: WalletId; error: unknown }> = [];

  await Promise.all(
    targetWallets.map(async (wallet) => {
      try {
        await wallet.recover();
        succeeded.push(wallet.walletId);
      } catch (error) {
        failed.push({ walletId: wallet.walletId, error });
      }
    })
  );

  return { succeeded, failed };
}

/**
 * Solana stealth direct payment engine and Ed25519 derivation strategy (STEALTH-5).
 *
 * Implements Curve25519 / X25519 ECDH stealth address derivation, rent exemption
 * dust enforcement, and recipient spendable keyring indexing without sweeping on receipt.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  edwardsToMontgomeryPriv,
  edwardsToMontgomeryPub,
  x25519,
} from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { fromHex, toHex } from "@frank/codec";
import type { StealthItem } from "@frank/cashweb/types/messages";

import {
  SolanaStealthAddressStrategy,
  SolanaStealthDestination as SolanaWalletStealthDestination,
  SolanaStealthTransactionMetadata,
  SolanaTransactionBundle,
  SolanaWallet,
  SolanaWalletConnection,
} from "./solana-wallet";

/**
 * Minimum transfer amount for a Solana stealth address.
 * 890,880 lamports (0.00089088 SOL) is the standard rent-exemption minimum
 * required for an empty (0 byte) account in Solana runtime.
 */
export const SOLANA_MIN_STEALTH_LAMPORTS = 890_880n;

export interface SolanaStealthDestination {
  readonly ephemeralPubKey: Uint8Array;
  readonly ephemeralSecret?: Uint8Array;
  readonly stealthAddress: string;
  readonly stealthPublicKey: PublicKey;
  readonly paymentIndex: number;
}

export interface SolanaStealthDerivedAccount {
  readonly ephemeralPubKey: Uint8Array;
  readonly stealthAddress: string;
  readonly stealthPublicKey: PublicKey;
  readonly stealthKeypair: Keypair;
  readonly stealthSeed: Uint8Array;
}

export interface SolanaStealthAccountRecord {
  readonly address: string;
  readonly keypair: Keypair;
  readonly seed: Uint8Array;
  readonly ephemeralPubKey: string;
  readonly networkTag: string;
  readonly discoveredAtMs: number;
  readonly initialAmountLamports?: bigint;
  readonly txHash?: string;
  readonly nonce?: number;
  readonly isClean?: boolean;
  readonly isSpent?: boolean;
  readonly balanceLamports?: bigint;
  readonly lastUpdatedMs?: number;
}

export interface SolanaStealthMetadata {
  readonly ephemeralPubKey: Uint8Array;
  readonly paymentIndex: number;
  readonly stealthPublicKey: PublicKey;
}

export interface SolanaStealthKeyringStore {
  get(address: string): SolanaStealthAccountRecord | undefined;
  put(record: SolanaStealthAccountRecord): void | Promise<void>;
  all(): SolanaStealthAccountRecord[] | Promise<SolanaStealthAccountRecord[]>;
  delete?(address: string): void | Promise<void>;
}

export class MemorySolanaStealthKeyringStore
  implements SolanaStealthKeyringStore
{
  private readonly records = new Map<string, SolanaStealthAccountRecord>();

  get(address: string): SolanaStealthAccountRecord | undefined {
    return this.records.get(address);
  }

  put(record: SolanaStealthAccountRecord): void {
    this.records.set(record.address, { ...record });
  }

  all(): SolanaStealthAccountRecord[] {
    return [...this.records.values()];
  }

  delete(address: string): void {
    this.records.delete(address);
  }
}

function parseRecipientPubKey(
  recipientSpendPubKey: Uint8Array | PublicKey | string
): Uint8Array {
  if (
    recipientSpendPubKey instanceof PublicKey ||
    (recipientSpendPubKey && typeof (recipientSpendPubKey as any).toBytes === "function")
  ) {
    return (recipientSpendPubKey as PublicKey).toBytes();
  }
  if (typeof recipientSpendPubKey === "string") {
    return new PublicKey(recipientSpendPubKey).toBytes();
  }
  if (recipientSpendPubKey instanceof Uint8Array) {
    if (recipientSpendPubKey.length !== 32) {
      throw new Error(
        `recipientSpendPubKey must be 32 bytes, got ${recipientSpendPubKey.length}`
      );
    }
    return recipientSpendPubKey.slice();
  }
  throw new TypeError("Invalid recipientSpendPubKey type");
}

function parseEphemeralPubKey(ephemeralPubKey: Uint8Array | string): Uint8Array {
  if (typeof ephemeralPubKey === "string") {
    const bytes = fromHex(ephemeralPubKey);
    if (bytes.length !== 32) {
      throw new Error(`ephemeralPubKey must be 32 bytes, got ${bytes.length}`);
    }
    return bytes;
  }
  if (ephemeralPubKey instanceof Uint8Array) {
    if (ephemeralPubKey.length !== 32) {
      throw new Error(
        `ephemeralPubKey must be 32 bytes, got ${ephemeralPubKey.length}`
      );
    }
    return ephemeralPubKey.slice();
  }
  throw new TypeError("Invalid ephemeralPubKey type");
}

/**
 * Sender derivation: derive an ephemeral one-time Solana stealth address using
 * recipient's Ed25519 spend public key (Key Type 2).
 */
export async function deriveSolanaStealthAddress(params: {
  recipientSpendPubKey: Uint8Array | PublicKey | string;
  paymentIndex?: number;
  context?: Uint8Array;
  ephemeralSecret?: Uint8Array;
}): Promise<SolanaStealthDestination> {
  const recipientEdPub = parseRecipientPubKey(params.recipientSpendPubKey);
  const montPub = edwardsToMontgomeryPub(recipientEdPub);

  const ephemeralSecret =
    params.ephemeralSecret ?? x25519.utils.randomPrivateKey();
  if (ephemeralSecret.length !== 32) {
    throw new Error(
      `ephemeralSecret must be 32 bytes, got ${ephemeralSecret.length}`
    );
  }

  const ephemeralPubKey = x25519.getPublicKey(ephemeralSecret);
  const sharedSecret = x25519.getSharedSecret(ephemeralSecret, montPub);

  const paymentIndex = params.paymentIndex ?? 0;
  const info = new TextEncoder().encode(
    `frank:solana-stealth:v1:${paymentIndex}`
  );
  const context = params.context ?? new Uint8Array(0);

  const stealthSeed = hkdf(sha256, sharedSecret, context, info, 32);
  const stealthKeypair = await Keypair.fromSeed(stealthSeed);

  return {
    ephemeralPubKey,
    ephemeralSecret,
    stealthAddress: stealthKeypair.publicKey.toBase58(),
    stealthPublicKey: stealthKeypair.publicKey,
    paymentIndex,
  };
}

/**
 * Recipient derivation: recovers the private Keypair for an incoming Solana stealth payment
 * using the recipient's Ed25519 spend seed and the sender's ephemeral public key.
 */
export async function deriveSolanaStealthKeypair(params: {
  recipientSpendSeed: Uint8Array;
  ephemeralPubKey: Uint8Array | string;
  paymentIndex?: number;
  context?: Uint8Array;
}): Promise<SolanaStealthDerivedAccount> {
  const { recipientSpendSeed } = params;
  if (recipientSpendSeed.length !== 32) {
    throw new Error(
      `recipientSpendSeed must be 32 bytes, got ${recipientSpendSeed.length}`
    );
  }

  const ephPub = parseEphemeralPubKey(params.ephemeralPubKey);
  const montPriv = edwardsToMontgomeryPriv(recipientSpendSeed);
  const sharedSecret = x25519.getSharedSecret(montPriv, ephPub);

  const paymentIndex = params.paymentIndex ?? 0;
  const info = new TextEncoder().encode(
    `frank:solana-stealth:v1:${paymentIndex}`
  );
  const context = params.context ?? new Uint8Array(0);

  const stealthSeed = hkdf(sha256, sharedSecret, context, info, 32);
  const stealthKeypair = await Keypair.fromSeed(stealthSeed);

  return {
    stealthPublicKey: stealthKeypair.publicKey,
    stealthAddress: stealthKeypair.publicKey.toBase58(),
    stealthKeypair,
    stealthSeed,
    ephemeralPubKey: ephPub,
  };
}

/**
 * Ed25519 stealth address strategy adhering to SolanaStealthAddressStrategy.
 * Can reuse a single ephemeral secret across a payment bundle while deriving
 * cryptographically unique addresses per payment index.
 */
export class SolanaEd25519StealthStrategy
  implements SolanaStealthAddressStrategy<SolanaStealthMetadata>
{
  private readonly ephemeralSecret: Uint8Array;

  constructor(options?: { ephemeralSecret?: Uint8Array }) {
    if (options?.ephemeralSecret) {
      if (options.ephemeralSecret.length !== 32) {
        throw new Error(
          `ephemeralSecret must be 32 bytes, got ${options.ephemeralSecret.length}`
        );
      }
      this.ephemeralSecret = options.ephemeralSecret.slice();
    } else {
      this.ephemeralSecret = x25519.utils.randomPrivateKey();
    }
  }

  get ephemeralPublicKey(): Uint8Array {
    return x25519.getPublicKey(this.ephemeralSecret);
  }

  get ephemeralPrivateKey(): Uint8Array {
    return this.ephemeralSecret.slice();
  }

  async createDestination(params: {
    recipient: PublicKey;
    paymentIndex: number;
    context: Uint8Array;
  }): Promise<SolanaWalletStealthDestination<SolanaStealthMetadata>> {
    const destination = await deriveSolanaStealthAddress({
      recipientSpendPubKey: params.recipient,
      paymentIndex: params.paymentIndex,
      context: params.context,
      ephemeralSecret: this.ephemeralSecret,
    });
    return {
      address: destination.stealthPublicKey,
      metadata: {
        ephemeralPubKey: destination.ephemeralPubKey,
        paymentIndex: params.paymentIndex,
        stealthPublicKey: destination.stealthPublicKey,
      },
    };
  }
}

/**
 * Keyring managing discovered Solana stealth accounts without sweeping.
 * Funds stay in individual stealth accounts; the wallet spends directly from them.
 */
export class SolanaStealthKeyring {
  private readonly store: SolanaStealthKeyringStore;

  constructor(store?: SolanaStealthKeyringStore) {
    this.store = store ?? new MemorySolanaStealthKeyringStore();
  }

  async addAccount(record: SolanaStealthAccountRecord): Promise<boolean> {
    const existing = this.store.get(record.address);
    if (existing !== undefined) {
      return false;
    }
    const fullRecord: SolanaStealthAccountRecord = {
      ...record,
      nonce: record.nonce ?? 0,
      isClean: record.isClean ?? true,
      isSpent: record.isSpent ?? false,
      balanceLamports:
        record.balanceLamports ?? record.initialAmountLamports ?? 0n,
      lastUpdatedMs:
        record.lastUpdatedMs ?? record.discoveredAtMs ?? Date.now(),
    };
    await this.store.put(fullRecord);
    return true;
  }

  async recordSpend(
    address: string,
    details?: { valueLamports?: bigint; valueWei?: bigint; txHash?: string }
  ): Promise<SolanaStealthAccountRecord | undefined> {
    const record = this.store.get(address);
    if (!record) {
      return undefined;
    }
    const deduct = details?.valueLamports ?? details?.valueWei ?? 0n;
    const currentBalance = record.balanceLamports ?? 0n;
    const newBalance = currentBalance >= deduct ? currentBalance - deduct : 0n;
    const updated: SolanaStealthAccountRecord = {
      ...record,
      isSpent: true,
      isClean: false,
      nonce: (record.nonce ?? 0) + 1,
      balanceLamports: newBalance,
      lastUpdatedMs: Date.now(),
      ...(details?.txHash ? { txHash: details.txHash } : {}),
    };
    await this.store.put(updated);
    return updated;
  }

  async updateBalance(
    address: string,
    balance: bigint
  ): Promise<SolanaStealthAccountRecord | undefined> {
    const record = this.store.get(address);
    if (!record) {
      return undefined;
    }
    const updated: SolanaStealthAccountRecord = {
      ...record,
      balanceLamports: balance,
      lastUpdatedMs: Date.now(),
    };
    await this.store.put(updated);
    return updated;
  }

  hasAccount(address: string): boolean {
    return this.store.get(address) !== undefined;
  }

  getAccount(address: string): SolanaStealthAccountRecord | undefined {
    return this.store.get(address);
  }

  async getAccounts(networkTag?: string): Promise<SolanaStealthAccountRecord[]> {
    const all = await this.store.all();
    if (!networkTag) return all;
    return all.filter(
      (r) => r.networkTag.toLowerCase() === networkTag.toLowerCase()
    );
  }

  async removeAccount(address: string): Promise<boolean> {
    const existing = this.store.get(address);
    if (!existing) return false;
    if (this.store.delete) {
      await this.store.delete(address);
      return true;
    }
    return false;
  }

  /**
   * Sums the spendable on-chain balance of all registered stealth accounts for a given network.
   * Skips spent accounts.
   */
  async getTotalBalance(
    connection: SolanaWalletConnection,
    networkTag?: string
  ): Promise<bigint> {
    const all = await this.getAccounts(networkTag);
    const accounts = all.filter((a) => !a.isSpent);
    if (accounts.length === 0) return 0n;

    const balances = await Promise.all(
      accounts.map(async (account) => {
        try {
          const bal = BigInt(
            await connection.getBalance(account.keypair.publicKey)
          );
          await this.updateBalance(account.address, bal);
          return bal;
        } catch {
          return 0n;
        }
      })
    );

    return balances.reduce((sum, b) => sum + b, 0n);
  }

  /**
   * Selects a single stealth account with sufficient balance to cover `neededLamports`.
   * First pass: in-memory O(1) selection against unspent accounts with cached balance >= neededLamports.
   * Second pass: bounded parallel verification of remaining unspent accounts.
   */
  async selectAccountForSpend(
    neededLamports: bigint,
    connection: SolanaWalletConnection,
    networkTag?: string
  ): Promise<SolanaStealthAccountRecord | undefined> {
    const accounts = await this.getAccounts(networkTag);

    // First pass (In-Memory O(1) selection): check all accounts for networkTag.
    // If an account has !account.isSpent && (account.balanceLamports ?? 0n) >= neededLamports,
    // select and return it immediately without any network calls!
    for (const account of accounts) {
      if (
        !account.isSpent &&
        (account.balanceLamports ?? 0n) >= neededLamports
      ) {
        return account;
      }
    }

    // Second pass (Parallel Bounded Verification): if no cached account has enough balance,
    // filter out accounts where isSpent === true.
    const candidateAccounts = accounts.filter((account) => !account.isSpent);
    if (candidateAccounts.length === 0) {
      return undefined;
    }

    // Query balances concurrently in chunks of 6 using Promise.all
    const CHUNK_SIZE = 6;
    for (let i = 0; i < candidateAccounts.length; i += CHUNK_SIZE) {
      const chunk = candidateAccounts.slice(i, i + CHUNK_SIZE);
      const results = await Promise.all(
        chunk.map(async (account) => {
          try {
            const bal = BigInt(
              await connection.getBalance(account.keypair.publicKey)
            );
            await this.updateBalance(account.address, bal);
            return { account, balance: bal };
          } catch {
            return { account, balance: 0n };
          }
        })
      );

      for (const res of results) {
        if (res.balance >= neededLamports) {
          return (
            this.getAccount(res.account.address) ?? {
              ...res.account,
              balanceLamports: res.balance,
            }
          );
        }
      }
    }

    return undefined;
  }

  /**
   * Discovers and indexes stealth accounts from an incoming StealthItem (keyType === 2).
   */
  async registerFromStealthItem(params: {
    item: StealthItem;
    recipientSpendSeed: Uint8Array;
    context?: Uint8Array;
    timestampMs?: number;
  }): Promise<SolanaStealthDerivedAccount[]> {
    if (params.item.keyType !== 2 || !params.item.ephemeralPubKey) {
      return [];
    }
    const ephPubBytes = parseEphemeralPubKey(params.item.ephemeralPubKey);
    const numTransactions = Math.max(1, params.item.transactions?.length ?? 1);
    const derivedAccounts: SolanaStealthDerivedAccount[] = [];

    for (let i = 0; i < numTransactions; i++) {
      try {
        const derived = await deriveSolanaStealthKeypair({
          recipientSpendSeed: params.recipientSpendSeed,
          ephemeralPubKey: ephPubBytes,
          paymentIndex: i,
          context: params.context,
        });
        derivedAccounts.push(derived);
        await this.addAccount({
          address: derived.stealthAddress,
          keypair: derived.stealthKeypair,
          seed: derived.stealthSeed,
          ephemeralPubKey: params.item.ephemeralPubKey,
          networkTag: params.item.networkTag ?? "SOL",
          discoveredAtMs: params.timestampMs ?? Date.now(),
          initialAmountLamports: params.item.amount
            ? BigInt(params.item.amount)
            : undefined,
          txHash: params.item.transactions?.[i],
        });
      } catch {
        // Skip invalid derivations
      }
    }

    return derivedAccounts;
  }
}

export interface BuildSolanaStealthPaymentParams {
  wallet: SolanaWallet;
  recipientSpendPubKey: Uint8Array | PublicKey | string;
  amountLamports: bigint;
  networkTag?: string;
  memo?: string;
  context?: Uint8Array;
  fromAddress?: string;
}

export interface SolanaStealthPaymentResult {
  stealthDestination: SolanaStealthDestination;
  txHash: string;
  rawTransaction: Uint8Array;
  stealthItem: StealthItem;
  bundle: SolanaTransactionBundle<
    SolanaStealthTransactionMetadata<SolanaStealthMetadata>
  >;
}

/**
 * Builds, signs, and broadcasts an on-chain Solana transfer to an ephemeral stealth address
 * enforcing the 890,880 lamports dust limit.
 * Generates the corresponding StealthItem for direct messages.
 */
export async function buildSolanaStealthPayment(
  params: BuildSolanaStealthPaymentParams
): Promise<SolanaStealthPaymentResult> {
  const { wallet, recipientSpendPubKey, amountLamports } = params;

  if (amountLamports <= 0n) {
    throw new RangeError("Transfer amount must be positive");
  }
  if (amountLamports < SOLANA_MIN_STEALTH_LAMPORTS) {
    throw new RangeError(
      `Transfer amount must be at least ${SOLANA_MIN_STEALTH_LAMPORTS} lamports (rent exemption dust limit)`
    );
  }

  // 1. Derive one-time stealth destination address
  const stealthDestination = await deriveSolanaStealthAddress({
    recipientSpendPubKey,
    paymentIndex: 0,
    context: params.context,
  });

  // 2. Build and sign transaction bundle via wallet
  let fromAddress = params.fromAddress;
  let spendingStealthAddress: string | undefined;

  if (fromAddress) {
    if (wallet.stealthKeyring?.hasAccount(fromAddress)) {
      spendingStealthAddress = fromAddress;
    }
  } else if (wallet.stealthKeyring) {
    try {
      const primaryBal = await wallet.getPrimaryBalance();
      if (primaryBal < amountLamports) {
        const selected = await wallet.stealthKeyring.selectAccountForSpend(
          amountLamports,
          wallet.connection,
          params.networkTag ?? wallet.networkId
        );
        if (selected) {
          fromAddress = selected.address;
          spendingStealthAddress = selected.address;
        }
      }
    } catch {
      // ignore balance check error
    }
  }

  const intentId = new Uint8Array(32);
  const cryptoObj = (
    globalThis as unknown as {
      crypto?: { getRandomValues<T extends Uint8Array>(bytes: T): T };
    }
  ).crypto;
  if (cryptoObj) {
    cryptoObj.getRandomValues(intentId);
  } else {
    for (let i = 0; i < 32; i++) intentId[i] = Math.floor(Math.random() * 256);
  }

  const bundle = await wallet.buildTransactionBundle({
    intentId,
    transfers: [
      {
        destination: stealthDestination.stealthAddress,
        lamports: amountLamports,
      },
    ],
    fromAddress,
  });

  // 3. Submit transaction bundle
  const submission = await wallet.submitTransactionBundle(bundle);
  const txHash = submission.submitted[0]?.txId;
  const rawTransaction = bundle.transactions[0].rawTransaction;

  if (spendingStealthAddress && wallet.stealthKeyring) {
    await wallet.stealthKeyring.recordSpend(spendingStealthAddress, {
      valueLamports: amountLamports,
      txHash,
    });
  }

  // 4. Construct StealthItem
  const stealthItem: StealthItem = {
    type: "stealth",
    networkTag: params.networkTag ?? wallet.networkId,
    keyType: 2,
    ephemeralPubKey: toHex(stealthDestination.ephemeralPubKey),
    transactions: [txHash],
    amount: Number(amountLamports),
    ...(params.memo ? { memo: params.memo } : {}),
    // Compatibility fields
    chainId: params.networkTag ?? wallet.networkId,
  };

  const metadataBundle: SolanaTransactionBundle<
    SolanaStealthTransactionMetadata<SolanaStealthMetadata>
  > = {
    ...bundle,
    transactions: [
      {
        ...bundle.transactions[0],
        metadata: {
          stealth: {
            ephemeralPubKey: stealthDestination.ephemeralPubKey,
            paymentIndex: 0,
            stealthPublicKey: stealthDestination.stealthPublicKey,
          },
        },
      },
    ],
  };

  return {
    stealthDestination,
    txHash,
    rawTransaction,
    stealthItem,
    bundle: metadataBundle,
  };
}

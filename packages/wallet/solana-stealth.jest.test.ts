import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";
import { toHex } from "@frank/codec";
import type { StealthItem } from "@frank/cashweb/types/messages";

import {
  SOLANA_MIN_STEALTH_LAMPORTS,
  SolanaEd25519StealthStrategy,
  SolanaStealthKeyring,
  buildSolanaStealthPayment,
  deriveSolanaStealthAddress,
  deriveSolanaStealthKeypair,
} from "./solana-stealth";
import {
  SolanaStealthWallet,
  SolanaWallet,
  SolanaWalletConnection,
} from "./solana-wallet";
import { InMemoryNativeTransactionAttemptStore } from "./chain/chain-wallet";

const base58Decoder = getBase58Decoder();

class MockSolanaConnection implements SolanaWalletConnection {
  balances = new Map<string, bigint>();
  sentTransactions: Uint8Array[] = [];
  genesisHash = "solana-genesis-hash";
  recentBlockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

  async getGenesisHash(): Promise<string> {
    return this.genesisHash;
  }

  async getSignatureStatus(signature: string) {
    return {
      value: {
        err: null,
        confirmationStatus: "confirmed" as const,
      },
    };
  }

  async getBalance(address: PublicKey): Promise<bigint> {
    return this.balances.get(address.toBase58()) ?? 0n;
  }

  async getLatestBlockhash() {
    return {
      blockhash: this.recentBlockhash,
      lastValidBlockHeight: 1000n,
    };
  }

  async sendRawTransaction(rawTransaction: Uint8Array): Promise<string> {
    this.sentTransactions.push(rawTransaction);
    const tx = VersionedTransaction.deserialize(rawTransaction);
    return base58Decoder.decode(tx.signatures[0]);
  }
}

describe("Solana Stealth Engine (STEALTH-5)", () => {
  it("derives identical stealth addresses and recoverable private keys via Ed25519 / Curve25519 ECDH", async () => {
    // Recipient generates Ed25519 spend keypair
    const recipientSeed = new Uint8Array(32).fill(42);
    const recipientKeypair = await Keypair.fromSeed(recipientSeed);
    const recipientSpendPubKey = recipientKeypair.publicKey;

    // Sender derives stealth destination
    const senderDerivation = await deriveSolanaStealthAddress({
      recipientSpendPubKey,
      paymentIndex: 0,
      context: new Uint8Array([1, 2, 3]),
    });

    expect(senderDerivation.stealthAddress).toBeDefined();
    expect(senderDerivation.ephemeralPubKey).toHaveLength(32);

    // Recipient recovers private keypair from sender's ephemeral public key
    const recipientDerivation = await deriveSolanaStealthKeypair({
      recipientSpendSeed: recipientSeed,
      ephemeralPubKey: senderDerivation.ephemeralPubKey,
      paymentIndex: 0,
      context: new Uint8Array([1, 2, 3]),
    });

    expect(recipientDerivation.stealthAddress).toBe(
      senderDerivation.stealthAddress
    );
    expect(
      recipientDerivation.stealthPublicKey.equals(
        senderDerivation.stealthPublicKey
      )
    ).toBe(true);

    // Verify recipient can sign a payload and sender can verify with stealth public key
    const message = new TextEncoder().encode("solana-stealth-message");
    const signature = await recipientDerivation.stealthKeypair.signBytes(
      message
    );
    const verified =
      await senderDerivation.stealthPublicKey.verifySignature(
        signature,
        message
      );
    expect(verified).toBe(true);
  });

  it("derives distinct stealth addresses for distinct payment indices or contexts", async () => {
    const recipientSeed = new Uint8Array(32).fill(7);
    const recipientKeypair = await Keypair.fromSeed(recipientSeed);
    const ephemeralSecret = new Uint8Array(32).fill(9);

    const dest0 = await deriveSolanaStealthAddress({
      recipientSpendPubKey: recipientKeypair.publicKey,
      paymentIndex: 0,
      ephemeralSecret,
    });

    const dest1 = await deriveSolanaStealthAddress({
      recipientSpendPubKey: recipientKeypair.publicKey,
      paymentIndex: 1,
      ephemeralSecret,
    });

    const destContext = await deriveSolanaStealthAddress({
      recipientSpendPubKey: recipientKeypair.publicKey,
      paymentIndex: 0,
      context: new Uint8Array([1]),
      ephemeralSecret,
    });

    expect(dest0.stealthAddress).not.toBe(dest1.stealthAddress);
    expect(dest0.stealthAddress).not.toBe(destContext.stealthAddress);
    expect(dest0.ephemeralPubKey).toEqual(dest1.ephemeralPubKey);
  });

  it("SolanaEd25519StealthStrategy integrates cleanly with SolanaStealthWallet bundle creation", async () => {
    const connection = new MockSolanaConnection();
    const signer = await Keypair.generate();
    const recipient = await Keypair.generate();

    const strategy = new SolanaEd25519StealthStrategy();
    const wallet = new SolanaStealthWallet({
      connection,
      signer,
      networkId: "solana-devnet",
      genesisHash: connection.genesisHash,
      stealthStrategy: strategy,
    });

    const intentId = new Uint8Array(32).fill(1);
    const bundle = await wallet.buildStealthTransactionBundle({
      intentId,
      recipient: recipient.publicKey,
      lamports: [
        SOLANA_MIN_STEALTH_LAMPORTS,
        SOLANA_MIN_STEALTH_LAMPORTS + 5000n,
      ],
      context: new Uint8Array([1, 2, 3]),
    });

    expect(bundle.transactions).toHaveLength(2);
    expect(bundle.transactions[0].destination).not.toBe(
      bundle.transactions[1].destination
    );
    expect(bundle.transactions[0].metadata?.stealth.ephemeralPubKey).toEqual(
      strategy.ephemeralPublicKey
    );
  });

  it("SolanaStealthKeyring manages discovered accounts and aggregates balance", async () => {
    const connection = new MockSolanaConnection();
    const keyring = new SolanaStealthKeyring();

    const kp1 = await Keypair.generate();
    const kp2 = await Keypair.generate();

    connection.balances.set(kp1.publicKey.toBase58(), 1_000_000n);
    connection.balances.set(kp2.publicKey.toBase58(), 2_500_000n);

    await keyring.addAccount({
      address: kp1.publicKey.toBase58(),
      keypair: kp1,
      seed: kp1.secretKey.slice(0, 32),
      ephemeralPubKey: "00".repeat(32),
      networkTag: "solana-devnet",
      discoveredAtMs: Date.now(),
    });

    await keyring.addAccount({
      address: kp2.publicKey.toBase58(),
      keypair: kp2,
      seed: kp2.secretKey.slice(0, 32),
      ephemeralPubKey: "11".repeat(32),
      networkTag: "solana-devnet",
      discoveredAtMs: Date.now(),
    });

    const total = await keyring.getTotalBalance(connection, "solana-devnet");
    expect(total).toBe(3_500_000n);

    const selected = await keyring.selectAccountForSpend(
      2_000_000n,
      connection,
      "solana-devnet"
    );
    expect(selected?.address).toBe(kp2.publicKey.toBase58());
  });

  it("registers accounts from incoming wire StealthItem (keyType === 2)", async () => {
    const recipientSeed = new Uint8Array(32).fill(11);
    const recipientKeypair = await Keypair.fromSeed(recipientSeed);
    const keyring = new SolanaStealthKeyring();

    const dest = await deriveSolanaStealthAddress({
      recipientSpendPubKey: recipientKeypair.publicKey,
      paymentIndex: 0,
    });

    const item: StealthItem = {
      type: "stealth",
      networkTag: "solana-devnet",
      keyType: 2,
      ephemeralPubKey: toHex(dest.ephemeralPubKey),
      transactions: ["tx_hash_123"],
      amount: Number(SOLANA_MIN_STEALTH_LAMPORTS),
    };

    const derived = await keyring.registerFromStealthItem({
      item,
      recipientSpendSeed: recipientSeed,
    });

    expect(derived).toHaveLength(1);
    expect(derived[0].stealthAddress).toBe(dest.stealthAddress);
    expect(keyring.hasAccount(dest.stealthAddress)).toBe(true);
  });

  it("SolanaWallet automatically aggregates primary balance with stealth balance", async () => {
    const connection = new MockSolanaConnection();
    const signer = await Keypair.generate();
    connection.balances.set(signer.publicKey.toBase58(), 5_000_000n);

    const keyring = new SolanaStealthKeyring();
    const stealthKp = await Keypair.generate();
    connection.balances.set(stealthKp.publicKey.toBase58(), 2_000_000n);

    await keyring.addAccount({
      address: stealthKp.publicKey.toBase58(),
      keypair: stealthKp,
      seed: stealthKp.secretKey.slice(0, 32),
      ephemeralPubKey: "aa".repeat(32),
      networkTag: "solana-devnet",
      discoveredAtMs: Date.now(),
    });

    const wallet = new SolanaWallet({
      connection,
      signer,
      networkId: "solana-devnet",
      genesisHash: connection.genesisHash,
      stealthKeyring: keyring,
    });

    const primaryBal = await wallet.getPrimaryBalance();
    expect(primaryBal).toBe(5_000_000n);

    const totalBal = await wallet.getBalance();
    expect(totalBal).toBe(7_000_000n);
  });

  it("SolanaWallet spends from a funded stealth account when primary balance is insufficient (no sweep)", async () => {
    const connection = new MockSolanaConnection();
    const signer = await Keypair.generate();
    // Primary account has only 100 lamports (insufficient)
    connection.balances.set(signer.publicKey.toBase58(), 100n);

    const keyring = new SolanaStealthKeyring();
    const stealthKp = await Keypair.generate();
    // Stealth account has 2,000,000 lamports
    connection.balances.set(stealthKp.publicKey.toBase58(), 2_000_000n);

    await keyring.addAccount({
      address: stealthKp.publicKey.toBase58(),
      keypair: stealthKp,
      seed: stealthKp.secretKey.slice(0, 32),
      ephemeralPubKey: "bb".repeat(32),
      networkTag: "solana-devnet",
      discoveredAtMs: Date.now(),
    });

    const wallet = new SolanaWallet({
      connection,
      signer,
      networkId: "solana-devnet",
      genesisHash: connection.genesisHash,
      stealthKeyring: keyring,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    });

    const recipient = await Keypair.generate();
    const tx = await wallet.sendNative({
      recipient: { raw: recipient.publicKey.toBase58() },
      value: 1_000_000n,
    });

    expect(tx.txHash).toBeDefined();
    expect(connection.sentTransactions).toHaveLength(1);
  });

  it("buildSolanaStealthPayment enforces the dust limit (>= 890,880 lamports)", async () => {
    const connection = new MockSolanaConnection();
    const signer = await Keypair.generate();
    connection.balances.set(signer.publicKey.toBase58(), 10_000_000n);

    const wallet = new SolanaWallet({
      connection,
      signer,
      networkId: "solana-devnet",
      genesisHash: connection.genesisHash,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    });

    const recipient = await Keypair.generate();

    // Below dust limit throws
    await expect(
      buildSolanaStealthPayment({
        wallet,
        recipientSpendPubKey: recipient.publicKey,
        amountLamports: SOLANA_MIN_STEALTH_LAMPORTS - 1n,
      })
    ).rejects.toThrow("rent exemption dust limit");

    // At dust limit succeeds and builds StealthItem
    const result = await buildSolanaStealthPayment({
      wallet,
      recipientSpendPubKey: recipient.publicKey,
      amountLamports: SOLANA_MIN_STEALTH_LAMPORTS,
      memo: "stealth payment",
    });

    expect(result.txHash).toBeDefined();
    expect(result.stealthItem).toEqual({
      type: "stealth",
      networkTag: "solana-devnet",
      keyType: 2,
      ephemeralPubKey: toHex(result.stealthDestination.ephemeralPubKey),
      transactions: [result.txHash],
      amount: Number(SOLANA_MIN_STEALTH_LAMPORTS),
      memo: "stealth payment",
      chainId: "solana-devnet",
    });
  });
});

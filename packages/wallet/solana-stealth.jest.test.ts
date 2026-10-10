import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";
import { toHex } from "@frank/codec";
import type { StealthItem } from "@frank/cashweb/types/messages";
import { edwardsToMontgomeryPub, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

import {
  SOLANA_MIN_STEALTH_LAMPORTS,
  SolanaEd25519StealthStrategy,
  SolanaStealthKeyring,
  SolanaStealthSendRefusedError,
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

  it("refuses a payment to a contact before anything is signed or sent: the sender could take it back", async () => {
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

    await expect(
      buildSolanaStealthPayment({
        wallet,
        recipientSpendPubKey: recipient.publicKey,
        amountLamports: SOLANA_MIN_STEALTH_LAMPORTS,
      })
    ).rejects.toBeInstanceOf(SolanaStealthSendRefusedError);
    expect(connection.balances.get(signer.publicKey.toBase58())).toBe(10_000_000n);

    // Why: the one-time account's whole key comes from the shared secret, which the sender has.
    const asSender = await deriveSolanaStealthAddress({
      recipientSpendPubKey: recipient.publicKey,
    });
    const sharedBySender = x25519.getSharedSecret(
      asSender.ephemeralSecret!,
      edwardsToMontgomeryPub(recipient.publicKey.toBytes())
    );
    const senderMade = await Keypair.fromSeed(
      hkdf(
        sha256,
        sharedBySender,
        new Uint8Array(0),
        new TextEncoder().encode("frank:solana-stealth:v1:0"),
        32
      )
    );
    expect(senderMade.publicKey.toBase58()).toBe(asSender.stealthAddress);
  });

  describe("Solana Stealth UTXO inventory tracking & parallel balance resolution (#1170)", () => {
    it("initializes account with default utxo metadata in addAccount", async () => {
      const keyring = new SolanaStealthKeyring();
      const kp = await Keypair.generate();
      await keyring.addAccount({
        address: kp.publicKey.toBase58(),
        keypair: kp,
        seed: kp.secretKey.slice(0, 32),
        ephemeralPubKey: "ee".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 1234,
        initialAmountLamports: 2_000_000n,
      });

      const record = keyring.getAccount(kp.publicKey.toBase58());
      expect(record).toBeDefined();
      expect(record?.nonce).toBe(0);
      expect(record?.isClean).toBe(true);
      expect(record?.isSpent).toBe(false);
      expect(record?.balanceLamports).toBe(2_000_000n);
      expect(record?.lastUpdatedMs).toBeDefined();
    });

    it("performs instant in-memory selection when cached balance is sufficient without network calls", async () => {
      const connection = new MockSolanaConnection();
      const keyring = new SolanaStealthKeyring();
      const kp = await Keypair.generate();

      await keyring.addAccount({
        address: kp.publicKey.toBase58(),
        keypair: kp,
        seed: kp.secretKey.slice(0, 32),
        ephemeralPubKey: "ff".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 100,
        initialAmountLamports: 2_500_000n,
      });

      const getBalanceSpy = jest.spyOn(connection, "getBalance");

      const selected = await keyring.selectAccountForSpend(
        1_000_000n,
        connection,
        "solana-devnet"
      );

      expect(selected).toBeDefined();
      expect(selected?.address).toBe(kp.publicKey.toBase58());
      // Zero network calls because cached balance was sufficient!
      expect(getBalanceSpy).not.toHaveBeenCalled();
    });

    it("recordSpend properly marks account as spent (isSpent === true, isClean === false, nonce === 1)", async () => {
      const keyring = new SolanaStealthKeyring();
      const kp = await Keypair.generate();
      const addr = kp.publicKey.toBase58();

      await keyring.addAccount({
        address: addr,
        keypair: kp,
        seed: kp.secretKey.slice(0, 32),
        ephemeralPubKey: "aa".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 100,
        initialAmountLamports: 3_000_000n,
      });

      const updated = await keyring.recordSpend(addr, {
        valueLamports: 1_000_000n,
        txHash: "solana_tx_hash_1",
      });

      expect(updated).toBeDefined();
      expect(updated?.isSpent).toBe(true);
      expect(updated?.isClean).toBe(false);
      expect(updated?.nonce).toBe(1);
      expect(updated?.balanceLamports).toBe(2_000_000n);
      expect(updated?.txHash).toBe("solana_tx_hash_1");

      const fetched = keyring.getAccount(addr);
      expect(fetched?.isSpent).toBe(true);
      expect(fetched?.isClean).toBe(false);
      expect(fetched?.nonce).toBe(1);
      expect(fetched?.balanceLamports).toBe(2_000_000n);
    });

    it("skips spent accounts during subsequent selections", async () => {
      const connection = new MockSolanaConnection();
      const keyring = new SolanaStealthKeyring();
      const kp1 = await Keypair.generate();
      const kp2 = await Keypair.generate();

      await keyring.addAccount({
        address: kp1.publicKey.toBase58(),
        keypair: kp1,
        seed: kp1.secretKey.slice(0, 32),
        ephemeralPubKey: "11".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 100,
        initialAmountLamports: 5_000_000n,
      });

      await keyring.addAccount({
        address: kp2.publicKey.toBase58(),
        keypair: kp2,
        seed: kp2.secretKey.slice(0, 32),
        ephemeralPubKey: "22".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 200,
        initialAmountLamports: 2_000_000n,
      });

      // Mark kp1 as spent
      await keyring.recordSpend(kp1.publicKey.toBase58(), {
        valueLamports: 5_000_000n,
      });

      // kp1 has balance, but must be skipped because isSpent === true!
      const selected = await keyring.selectAccountForSpend(
        1_500_000n,
        connection,
        "solana-devnet"
      );
      expect(selected?.address).toBe(kp2.publicKey.toBase58());

      // If kp2 is also spent, none can be selected
      await keyring.recordSpend(kp2.publicKey.toBase58(), {
        valueLamports: 2_000_000n,
      });
      const none = await keyring.selectAccountForSpend(
        500_000n,
        connection,
        "solana-devnet"
      );
      expect(none).toBeUndefined();
    });

    it("queries balances in parallel when cached balance is insufficient", async () => {
      const connection = new MockSolanaConnection();
      const keyring = new SolanaStealthKeyring();

      const kp1 = await Keypair.generate();
      const kp2 = await Keypair.generate();
      const kp3 = await Keypair.generate();

      await keyring.addAccount({
        address: kp1.publicKey.toBase58(),
        keypair: kp1,
        seed: kp1.secretKey.slice(0, 32),
        ephemeralPubKey: "01".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 100,
        initialAmountLamports: 0n,
      });
      await keyring.addAccount({
        address: kp2.publicKey.toBase58(),
        keypair: kp2,
        seed: kp2.secretKey.slice(0, 32),
        ephemeralPubKey: "02".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 200,
        initialAmountLamports: 0n,
      });
      await keyring.addAccount({
        address: kp3.publicKey.toBase58(),
        keypair: kp3,
        seed: kp3.secretKey.slice(0, 32),
        ephemeralPubKey: "03".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 300,
        initialAmountLamports: 0n,
      });

      let activeQueries = 0;
      let maxConcurrentQueries = 0;

      jest
        .spyOn(connection, "getBalance")
        .mockImplementation(async (pubkey: PublicKey) => {
          activeQueries++;
          maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries);
          await new Promise((r) => setTimeout(r, 20));
          activeQueries--;
          if (pubkey.equals(kp2.publicKey)) {
            return 4_000_000n;
          }
          return 500_000n;
        });

      const selected = await keyring.selectAccountForSpend(
        3_000_000n,
        connection,
        "solana-devnet"
      );

      expect(selected?.address).toBe(kp2.publicKey.toBase58());
      expect(selected?.balanceLamports).toBe(4_000_000n);
      expect(maxConcurrentQueries).toBeGreaterThan(1);
      expect(keyring.getAccount(kp2.publicKey.toBase58())?.balanceLamports).toBe(
        4_000_000n
      );
    });

    it("SolanaWallet.sendNative invokes recordSpend on stealthKeyring when spending from stealth account", async () => {
      const connection = new MockSolanaConnection();
      const signer = await Keypair.generate();
      // Primary account has only 50 lamports (insufficient)
      connection.balances.set(signer.publicKey.toBase58(), 50n);

      const keyring = new SolanaStealthKeyring();
      const stealthKp = await Keypair.generate();
      const stealthAddr = stealthKp.publicKey.toBase58();
      connection.balances.set(stealthAddr, 3_000_000n);

      await keyring.addAccount({
        address: stealthAddr,
        keypair: stealthKp,
        seed: stealthKp.secretKey.slice(0, 32),
        ephemeralPubKey: "88".repeat(32),
        networkTag: "solana-devnet",
        discoveredAtMs: 100,
        initialAmountLamports: 3_000_000n,
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

      const record = keyring.getAccount(stealthAddr);
      expect(record?.isSpent).toBe(true);
      expect(record?.isClean).toBe(false);
      expect(record?.nonce).toBe(1);
      expect(record?.balanceLamports).toBe(2_000_000n);
      expect(record?.txHash).toBe(tx.txHash);
    });
  });
});

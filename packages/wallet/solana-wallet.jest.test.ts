import {
  Keypair,
  PublicKey,
  SystemInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";

import {
  SolanaStealthAddressStrategy,
  SolanaStealthWallet,
  SolanaWallet,
  SolanaWalletConnection,
} from "./solana-wallet";
import {
  StealthTransactionBundleCapability,
  TransactionBundleSubmissionError,
} from "./transaction-bundle-wallet";
import {
  InMemoryNativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
} from "./chain/chain-wallet";

const blockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const rotatedBlockhash = new PublicKey(new Uint8Array(32).fill(10)).toBase58();
const base58Decoder = getBase58Decoder();

function transactionId(rawTransaction: Uint8Array): string {
  return base58Decoder.decode(
    VersionedTransaction.deserialize(rawTransaction).signatures[0]
  );
}

class FakeConnection implements SolanaWalletConnection {
  balance = 123n;
  sent: Uint8Array[] = [];
  failAt: number | undefined;
  overrideTxId: string | undefined;
  onSend: ((index: number) => void) | undefined;
  waitBeforeSend: Promise<void> | undefined;
  blockhashes: string[] = [blockhash];
  blockhashRequests = 0;

  async getGenesisHash(): Promise<string> {
    return "solana-genesis";
  }

  async getSignatureStatus(): Promise<{ value: null }> {
    return { value: null };
  }

  async getBalance(): Promise<bigint> {
    return this.balance;
  }

  async getLatestBlockhash() {
    const selected =
      this.blockhashes[
        Math.min(this.blockhashRequests, this.blockhashes.length - 1)
      ];
    this.blockhashRequests += 1;
    return { blockhash: selected, lastValidBlockHeight: 456n };
  }

  async sendRawTransaction(rawTransaction: Uint8Array): Promise<string> {
    const index = this.sent.length;
    this.onSend?.(index);
    await this.waitBeforeSend;
    if (index === this.failAt) throw new Error("rpc refused transaction");
    this.sent.push(rawTransaction);
    return this.overrideTxId ?? transactionId(rawTransaction);
  }
}

async function makeKeypair(byte: number): Promise<Keypair> {
  return Keypair.fromSeed(new Uint8Array(32).fill(byte));
}

function intentId(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function intentMemo(rawTransaction: Uint8Array): string {
  const transaction = VersionedTransaction.deserialize(rawTransaction);
  const message = TransactionMessage.decompile(transaction.message);
  return new TextDecoder().decode(message.instructions[1].data);
}

describe("SolanaWallet", () => {
  it("builds and signs an ordered native-transfer bundle", async () => {
    const connection = new FakeConnection();
    const signer = await makeKeypair(1);
    const destinations = [await makeKeypair(2), await makeKeypair(3)];
    const wallet = new SolanaWallet({
      connection,
      signer,
      networkId: "solana-test",
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    });

    const bundle = await wallet.buildTransactionBundle({
      intentId: intentId(1),
      transfers: destinations.map((destination, index) => ({
        destination: destination.publicKey,
        lamports: BigInt(index + 10),
      })),
    });

    expect(bundle.source).toBe(signer.publicKey.toBase58());
    expect(bundle.transactions).toHaveLength(2);
    for (const [index, bundled] of bundle.transactions.entries()) {
      const transaction = VersionedTransaction.deserialize(
        bundled.rawTransaction
      );
      await expect(
        signer.publicKey.verifySignature(
          transaction.signatures[0],
          transaction.message.serialize()
        )
      ).resolves.toBe(true);
      const message = TransactionMessage.decompile(transaction.message);
      const transfer = SystemInstruction.decodeTransfer(
        message.instructions[0]
      );
      expect(transfer.fromPubkey.equals(signer.publicKey)).toBe(true);
      expect(transfer.toPubkey.equals(destinations[index].publicKey)).toBe(
        true
      );
      expect(BigInt(transfer.lamports)).toBe(BigInt(index + 10));
    }
  });

  it("builds distinct strategy-owned stealth destinations with metadata", async () => {
    const connection = new FakeConnection();
    const derived = [await makeKeypair(4), await makeKeypair(5)];
    const contexts: Uint8Array[] = [];
    const strategy: SolanaStealthAddressStrategy<{ child: number }> = {
      async createDestination({ paymentIndex, context }) {
        contexts.push(context);
        return {
          address: derived[paymentIndex].publicKey,
          metadata: { child: paymentIndex },
        };
      },
    };
    const wallet = new SolanaStealthWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
      stealthStrategy: strategy,
    });
    const context = Uint8Array.from([1, 2, 3]);

    const bundle = await wallet.buildStealthTransactionBundle({
      intentId: intentId(2),
      recipient: (await makeKeypair(8)).publicKey,
      lamports: [20n, 30n],
      context,
    });
    context[0] = 99;

    expect(bundle.transactions.map((tx) => tx.destination)).toEqual(
      derived.map((keypair) => keypair.publicKey.toBase58())
    );
    expect(bundle.transactions.map((tx) => tx.metadata)).toEqual([
      { stealth: { child: 0 } },
      { stealth: { child: 1 } },
    ]);
    expect(contexts.map((value) => [...value])).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
  });

  it("does not advertise stealth support without a reviewed strategy", async () => {
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
    });

    expect("buildStealthTransactionBundle" in wallet).toBe(false);
  });

  it("rejects duplicate destinations returned by a stealth strategy", async () => {
    const destination = (await makeKeypair(7)).publicKey;
    const wallet = new SolanaStealthWallet({
      networkId: "solana-test",
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
      stealthStrategy: {
        async createDestination() {
          return { address: destination, metadata: {} };
        },
      },
    });

    await expect(
      wallet.buildStealthTransactionBundle({
        intentId: intentId(3),
        recipient: (await makeKeypair(2)).publicKey,
        lamports: [1n, 2n],
        context: new Uint8Array(),
      })
    ).rejects.toThrow("duplicate destinations");
  });

  it("reports the submitted prefix when bundle submission fails", async () => {
    const connection = new FakeConnection();
    connection.failAt = 1;
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    });
    const bundle = await wallet.buildTransactionBundle({
      intentId: intentId(4),
      transfers: [2, 3].map((byte) => ({
        destination: new PublicKey(new Uint8Array(32).fill(byte)),
        lamports: 1n,
      })),
    });

    let error: unknown;
    try {
      await wallet.submitTransactionBundle(bundle);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TransactionBundleSubmissionError);
    const submissionError = error as TransactionBundleSubmissionError<string>;
    expect(submissionError.failedIndex).toBe(1);
    expect(submissionError.submitted).toEqual([
      expect.objectContaining({
        index: 0,
        txId: transactionId(bundle.transactions[0].rawTransaction),
      }),
    ]);
    expect(submissionError.attempted).toEqual(
      expect.objectContaining({
        index: 1,
        txId: transactionId(bundle.transactions[1].rawTransaction),
      })
    );
    expect(connection.sent[0]).toEqual(bundle.transactions[0].rawTransaction);
  });

  it("signs equal payments as distinct transactions using their payment indices", async () => {
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
    });
    const destination = (await makeKeypair(2)).publicKey;

    const bundle = await wallet.buildTransactionBundle({
      intentId: intentId(5),
      transfers: [
        { destination, lamports: 10n },
        { destination, lamports: 10n },
      ],
    });

    expect(bundle.transactions[0].rawTransaction).not.toEqual(
      bundle.transactions[1].rawTransaction
    );
    expect(transactionId(bundle.transactions[0].rawTransaction)).not.toBe(
      transactionId(bundle.transactions[1].rawTransaction)
    );
  });

  it("keeps the durable intent marker when a retry gets a new blockhash", async () => {
    const connection = new FakeConnection();
    connection.blockhashes = [blockhash, rotatedBlockhash, rotatedBlockhash];
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const transfer = {
      destination: (await makeKeypair(2)).publicKey,
      lamports: 10n,
    };

    const first = await wallet.buildTransactionBundle({
      intentId: intentId(11),
      transfers: [transfer],
    });
    const retry = await wallet.buildTransactionBundle({
      intentId: intentId(11),
      transfers: [transfer],
    });
    const distinct = await wallet.buildTransactionBundle({
      intentId: intentId(12),
      transfers: [transfer],
    });

    expect(retry.transactions[0].rawTransaction).not.toEqual(
      first.transactions[0].rawTransaction
    );
    expect(intentMemo(retry.transactions[0].rawTransaction)).toBe(
      intentMemo(first.transactions[0].rawTransaction)
    );
    expect(distinct.transactions[0].rawTransaction).not.toEqual(
      first.transactions[0].rawTransaction
    );
  });

  it("rejects transactions spliced from different intents before submission", async () => {
    const connection = new FakeConnection();
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const transfers = [2, 3].map((byte) => ({
      destination: new PublicKey(new Uint8Array(32).fill(byte)),
      lamports: 10n,
    }));
    const first = await wallet.buildTransactionBundle({
      intentId: intentId(15),
      transfers,
    });
    const second = await wallet.buildTransactionBundle({
      intentId: intentId(16),
      transfers,
    });

    await expect(
      wallet.submitTransactionBundle({
        bundleId: first.bundleId,
        source: first.source,
        transactions: [first.transactions[0], second.transactions[1]],
      })
    ).rejects.toThrow("signed payment plan");
    expect(connection.sent).toEqual([]);
  });

  it("rejects same-intent transactions spliced from different payment plans", async () => {
    const connection = new FakeConnection();
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const sharedIntent = intentId(19);
    const first = await wallet.buildTransactionBundle({
      intentId: sharedIntent,
      transfers: [2, 3].map((byte, index) => ({
        destination: new PublicKey(new Uint8Array(32).fill(byte)),
        lamports: BigInt(index + 1),
      })),
    });
    const second = await wallet.buildTransactionBundle({
      intentId: sharedIntent,
      transfers: [2, 4].map((byte, index) => ({
        destination: new PublicKey(new Uint8Array(32).fill(byte)),
        lamports: index === 0 ? 1n : 999n,
      })),
    });

    await expect(
      wallet.submitTransactionBundle({
        bundleId: first.bundleId,
        source: first.source,
        transactions: [first.transactions[0], second.transactions[1]],
      })
    ).rejects.toThrow("signed payment plan");
    expect(connection.sent).toEqual([]);
  });

  it("resumes after a reconciled prefix without resending it", async () => {
    const connection = new FakeConnection();
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const bundle = await wallet.buildTransactionBundle({
      intentId: intentId(17),
      transfers: [2, 3].map((byte) => ({
        destination: new PublicKey(new Uint8Array(32).fill(byte)),
        lamports: 10n,
      })),
    });

    const result = await wallet.submitTransactionBundle(bundle, {
      startIndex: 1,
      expectedBundleId: bundle.bundleId,
    });

    expect(result.submitted.map((transaction) => transaction.index)).toEqual([
      1,
    ]);
    expect(connection.sent).toEqual([bundle.transactions[1].rawTransaction]);
  });

  it("snapshots build inputs before asynchronous signing work", async () => {
    const connection = new FakeConnection();
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const originalDestination = (await makeKeypair(2)).publicKey;
    const transfers = [{ destination: originalDestination, lamports: 10n }];
    const id = intentId(18);

    const building = wallet.buildTransactionBundle({ intentId: id, transfers });
    transfers[0].destination = new PublicKey(new Uint8Array(32).fill(3));
    transfers[0].lamports = 999n;
    id.fill(99);
    const bundle = await building;
    const transaction = VersionedTransaction.deserialize(
      bundle.transactions[0].rawTransaction
    );
    const message = TransactionMessage.decompile(transaction.message);
    const transfer = SystemInstruction.decodeTransfer(message.instructions[0]);

    expect(transfer.toPubkey.equals(originalDestination)).toBe(true);
    expect(BigInt(transfer.lamports)).toBe(10n);
    expect(intentMemo(bundle.transactions[0].rawTransaction)).toContain(
      intentId(18).reduce(
        (hex, byte) => hex + byte.toString(16).padStart(2, "0"),
        ""
      )
    );
  });

  it("does not expose base factories that silently drop stealth capability", async () => {
    await expect(
      SolanaStealthWallet.generate({
        connection: new FakeConnection(),
        networkId: "solana-test",
      })
    ).rejects.toThrow("generateStealth");
    await expect(
      SolanaStealthWallet.fromSeed({
        connection: new FakeConnection(),
        networkId: "solana-test",
        seed: new Uint8Array(32),
      })
    ).rejects.toThrow("fromSeedWithStealth");
  });

  it("snapshots seed material before asynchronous factory setup", async () => {
    const seed = new Uint8Array(32).fill(20);
    const expectedAddress = (await Keypair.fromSeed(seed)).publicKey.toBase58();

    const creating = SolanaWallet.fromSeed({
      networkId: "solana-test",
      connection: new FakeConnection(),
      seed,
    });
    seed.fill(0);

    await expect(creating).resolves.toMatchObject({ address: expectedAddress });
  });

  it("submits the snapshotted bytes even if the caller mutates its bundle", async () => {
    const connection = new FakeConnection();
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const bundle = await wallet.buildTransactionBundle({
      intentId: intentId(13),
      transfers: [2, 3].map((byte) => ({
        destination: new PublicKey(new Uint8Array(32).fill(byte)),
        lamports: 10n,
      })),
    });
    const expectedSecond = bundle.transactions[1].rawTransaction.slice();
    connection.onSend = (index) => {
      if (index === 0) bundle.transactions[1].rawTransaction.fill(0);
    };

    await wallet.submitTransactionBundle(bundle);

    expect(connection.sent[1]).toEqual(expectedSecond);
  });

  it("rejects a bundle description that disagrees with its signed bytes", async () => {
    const connection = new FakeConnection();
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const bundle = await wallet.buildTransactionBundle({
      intentId: intentId(6),
      transfers: [
        { destination: (await makeKeypair(2)).publicKey, lamports: 10n },
      ],
    });
    const forged = {
      ...bundle,
      transactions: [
        {
          ...bundle.transactions[0],
          destination: (await makeKeypair(3)).publicKey.toBase58(),
          value: 999n,
        },
      ],
    };

    await expect(
      wallet.submitTransactionBundle(forged as typeof bundle)
    ).rejects.toThrow("description does not match signed bytes");
    expect(connection.sent).toEqual([]);
  });

  it("rejects an RPC transaction id that differs from the signed transaction", async () => {
    const connection = new FakeConnection();
    connection.overrideTxId = new PublicKey(
      new Uint8Array(32).fill(6)
    ).toBase58();
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
    });
    const bundle = await wallet.buildTransactionBundle({
      intentId: intentId(7),
      transfers: [
        { destination: (await makeKeypair(2)).publicKey, lamports: 10n },
      ],
    });

    await expect(wallet.submitTransactionBundle(bundle)).rejects.toMatchObject({
      failedIndex: 0,
      submitted: [],
    });
  });

  it.each([0n, -1n])(
    "rejects a nonpositive transfer of %s",
    async (lamports) => {
      const connection = new FakeConnection();
      const wallet = new SolanaWallet({
        networkId: "solana-test",
        connection,
        signer: await makeKeypair(1),
      });

      await expect(
        wallet.buildTransactionBundle({
          intentId: intentId(8),
          transfers: [
            { destination: (await makeKeypair(2)).publicKey, lamports },
          ],
        })
      ).rejects.toThrow("positive lamports");
    }
  );

  it.each([0n, -1n])(
    "rejects a nonpositive stealth transfer of %s before deriving destinations",
    async (lamports) => {
      const createDestination = jest.fn();
      const wallet = new SolanaStealthWallet({
        networkId: "solana-test",
        connection: new FakeConnection(),
        signer: await makeKeypair(1),
        stealthStrategy: { createDestination },
      });

      await expect(
        wallet.buildStealthTransactionBundle({
          intentId: intentId(14),
          recipient: (await makeKeypair(2)).publicKey,
          lamports: [1n, lamports],
          context: new Uint8Array(),
        })
      ).rejects.toThrow("positive lamports");
      expect(createDestination).not.toHaveBeenCalled();
    }
  );

  it("rejects oversized stealth transfers before deriving destinations", async () => {
    const createDestination = jest.fn();
    const wallet = new SolanaStealthWallet({
      networkId: "solana-test",
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
      stealthStrategy: { createDestination },
    });

    await expect(
      wallet.buildStealthTransactionBundle({
        intentId: intentId(22),
        recipient: (await makeKeypair(2)).publicKey,
        lamports: [1n << 64n],
        context: new Uint8Array(),
      })
    ).rejects.toThrow("u64 lamport limit");
    expect(createDestination).not.toHaveBeenCalled();
  });

  it("rejects empty ordinary and stealth bundles", async () => {
    const connection = new FakeConnection();
    const signer = await makeKeypair(1);
    const wallet = new SolanaWallet({
      connection,
      signer,
      networkId: "solana-test",
    });
    const stealthWallet = new SolanaStealthWallet({
      networkId: "solana-test",
      connection,
      signer,
      stealthStrategy: {
        async createDestination() {
          throw new Error("must not derive a destination");
        },
      },
    });

    await expect(
      wallet.buildTransactionBundle({ intentId: intentId(9), transfers: [] })
    ).rejects.toThrow("at least one transfer");
    await expect(
      stealthWallet.buildStealthTransactionBundle({
        intentId: intentId(10),
        recipient: (await makeKeypair(2)).publicKey,
        lamports: [],
        context: new Uint8Array(),
      })
    ).rejects.toThrow("at least one payment");
  });

  it("returns balances as bigint", async () => {
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
    });
    await expect(wallet.getBalance()).resolves.toBe(123n);
  });

  it("exposes the common identity and native-transfer API", async () => {
    const connection = new FakeConnection();
    const signer = await makeKeypair(1);
    const recipient = (await makeKeypair(2)).publicKey;
    const wallet = new SolanaWallet({
      connection,
      signer,
      networkId: "solana-test",
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    });

    expect(wallet.identity).toEqual({
      address: { raw: signer.publicKey.toBase58() },
      displayAddress: signer.publicKey.toBase58(),
    });
    await expect(wallet.getReceiveAddress()).resolves.toEqual({
      raw: signer.publicKey.toBase58(),
    });
    await expect(
      wallet.sendNative({
        recipient: { raw: recipient.toBase58() },
        value: 42n,
      })
    ).resolves.toEqual({ txHash: expect.any(String) });
    expect(connection.sent).toHaveLength(1);
  });

  it("preserves the exact signed id when native submission outcome is unknown", async () => {
    const connection = new FakeConnection();
    connection.failAt = 0;
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    });

    const first = wallet.sendNative({
      recipient: { raw: (await makeKeypair(2)).publicKey.toBase58() },
      value: 42n,
    });
    const concurrent = wallet.sendNative({
      recipient: { raw: (await makeKeypair(3)).publicKey.toBase58() },
      value: 99n,
    });
    const [firstResult, concurrentResult] = await Promise.allSettled([
      first,
      concurrent,
    ]);
    const error =
      firstResult.status === "rejected" ? firstResult.reason : undefined;

    expect(error).toBeInstanceOf(NativeTransactionSubmissionError);
    expect(
      (error as NativeTransactionSubmissionError).transaction.txHash
    ).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect((error as NativeTransactionSubmissionError).reason).toBeInstanceOf(
      TransactionBundleSubmissionError
    );
    const attempted = (error as NativeTransactionSubmissionError).transaction;
    expect(wallet.getUnresolvedNativeTransaction()).toEqual(attempted);

    expect(concurrentResult).toEqual({ status: "rejected", reason: error });
    expect(connection.blockhashRequests).toBe(1);

    connection.failAt = undefined;
    await expect(wallet.retryUnresolvedNativeTransaction()).resolves.toEqual(
      attempted
    );
    expect(wallet.getUnresolvedNativeTransaction()).toBeUndefined();
  });

  it("restores the unresolved guard before allowing another transfer", async () => {
    const nativeAttemptStore = new InMemoryNativeTransactionAttemptStore();
    const signer = await makeKeypair(1);
    const failedConnection = new FakeConnection();
    failedConnection.failAt = 0;
    const firstWallet = new SolanaWallet({
      networkId: "solana-test",
      connection: failedConnection,
      signer,
      nativeAttemptStore,
    });
    await expect(
      firstWallet.sendNative({
        recipient: { raw: (await makeKeypair(2)).publicKey.toBase58() },
        value: 42n,
      })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);

    const restoredConnection = new FakeConnection();
    const restoredWallet = new SolanaWallet({
      networkId: "solana-test",
      connection: restoredConnection,
      signer,
      nativeAttemptStore,
    });
    const unresolved = restoredWallet.getUnresolvedNativeTransaction()!;
    await expect(
      restoredWallet.sendNative({
        recipient: { raw: (await makeKeypair(3)).publicKey.toBase58() },
        value: 99n,
      })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
    expect(restoredConnection.blockhashRequests).toBe(0);
    await expect(
      restoredWallet.retryUnresolvedNativeTransaction()
    ).rejects.toThrow("must be reconciled by id");

    await restoredWallet.resolveUnresolvedNativeTransaction({
      transaction: unresolved,
      outcome: "not-submitted",
    });
    await expect(
      restoredWallet.sendNative({
        recipient: { raw: (await makeKeypair(3)).publicKey.toBase58() },
        value: 99n,
      })
    ).resolves.toEqual({ txHash: expect.any(String) });
  });

  it("isolates unresolved attempts by settlement network", async () => {
    const nativeAttemptStore = new InMemoryNativeTransactionAttemptStore();
    const signer = await makeKeypair(1);
    const networkA = new FakeConnection();
    networkA.failAt = 0;
    const walletA = new SolanaWallet({
      connection: networkA,
      signer,
      networkId: "cluster-a",
      nativeAttemptStore,
    });
    await expect(
      walletA.sendNative({
        recipient: { raw: (await makeKeypair(2)).publicKey.toBase58() },
        value: 1n,
      })
    ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);

    const networkB = new FakeConnection();
    const walletB = new SolanaWallet({
      connection: networkB,
      signer,
      networkId: "cluster-b",
      nativeAttemptStore,
    });
    expect(walletB.getUnresolvedNativeTransaction()).toBeUndefined();
    await expect(
      walletB.sendNative({
        recipient: { raw: (await makeKeypair(3)).publicKey.toBase58() },
        value: 2n,
      })
    ).resolves.toEqual({ txHash: expect.any(String) });

    const restoredA = new SolanaWallet({
      connection: new FakeConnection(),
      signer,
      networkId: "cluster-a",
      nativeAttemptStore,
    });
    expect(restoredA.getUnresolvedNativeTransaction()).toEqual(
      walletA.getUnresolvedNativeTransaction()
    );
  });

  it("persists the guard before the network request can finish", async () => {
    const nativeAttemptStore = new InMemoryNativeTransactionAttemptStore();
    const signer = await makeKeypair(1);
    const connection = new FakeConnection();
    let releaseSend: (() => void) | undefined;
    connection.waitBeforeSend = new Promise((resolve) => {
      releaseSend = resolve;
    });
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    connection.onSend = () => requestStarted!();
    const wallet = new SolanaWallet({
      connection,
      signer,
      networkId: "solana-test",
      nativeAttemptStore,
    });

    const sending = wallet.sendNative({
      recipient: { raw: (await makeKeypair(2)).publicKey.toBase58() },
      value: 1n,
    });
    await started;
    const reconstructed = new SolanaWallet({
      connection: new FakeConnection(),
      signer,
      networkId: "solana-test",
      nativeAttemptStore,
      getTransactionStatus: async () => "confirmed",
    });
    expect(reconstructed.getUnresolvedNativeTransaction()).toEqual(
      wallet.getUnresolvedNativeTransaction()
    );

    releaseSend!();
    await expect(sending).resolves.toEqual({ txHash: expect.any(String) });
    await expect(
      reconstructed.sendNative({
        recipient: { raw: (await makeKeypair(3)).publicKey.toBase58() },
        value: 2n,
      })
    ).resolves.toEqual({ txHash: expect.any(String) });
  });

  it("does not submit when the exact attempt cannot be persisted first", async () => {
    const connection = new FakeConnection();
    const persistenceError = new Error("durable store unavailable");
    const wallet = new SolanaWallet({
      networkId: "solana-test",
      connection,
      signer: await makeKeypair(1),
      nativeAttemptStore: {
        coordinationScope: "single-realm",
        get: () => undefined,
        put: () => {
          throw persistenceError;
        },
        delete: jest.fn(),
      },
    });

    await expect(
      wallet.sendNative({
        recipient: { raw: (await makeKeypair(2)).publicKey.toBase58() },
        value: 42n,
      })
    ).rejects.toBe(persistenceError);
    expect(connection.sent).toHaveLength(0);
  });
});

async function submitThroughStealthInterface<TMetadata extends {}>(
  wallet: StealthTransactionBundleCapability<
    string,
    Uint8Array,
    { transfers: readonly never[] },
    Parameters<
      SolanaStealthWallet<TMetadata>["buildStealthTransactionBundle"]
    >[0],
    { stealth: TMetadata }
  >,
  params: Parameters<
    SolanaStealthWallet<TMetadata>["buildStealthTransactionBundle"]
  >[0]
): Promise<void> {
  const bundle = await wallet.buildStealthTransactionBundle(params);
  await wallet.submitTransactionBundle(bundle);
}

// Compile-time proof that the generic stealth capability can submit its own metadata-bearing
// build result. The helper is intentionally not invoked.
void submitThroughStealthInterface;

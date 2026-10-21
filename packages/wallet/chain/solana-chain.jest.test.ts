import {
  Keypair,
  PublicKey,
  SystemInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  ComputeBudgetInstruction,
} from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";
import * as bip39 from "bip39";

import { createSolanaChain, SolanaChainConfig } from "./solana-chain";
import { SolanaWalletConnection, SolanaWallet } from "../solana-wallet";
import { ChainUtxoPool } from "../chain-utxo-pool";
import {
  InMemoryNativeTransactionAttemptStore,
  NativeFeeExceededError,
  NativeTransactionSubmissionError,
  nativeTransactionAttemptKey,
} from "./chain-wallet";

const base58Decoder = getBase58Decoder();
const blockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

class MockSolanaConnection implements SolanaWalletConnection {
  balance = 1_000_000_000n; // 1 SOL
  sentRaw: Uint8Array[] = [];
  genesisHash = "solana-test-genesis";
  getBalanceCalls = 0;

  async getGenesisHash(): Promise<string> {
    return this.genesisHash;
  }

  status: { err: null; confirmationStatus: "confirmed" } | null = {
    err: null,
    confirmationStatus: "confirmed",
  };
  failSend: Error | undefined;
  beforeSend: (() => void) | undefined;
  blockhashRequests = 0;

  async getSignatureStatus(signature: string) {
    return { value: this.status };
  }

  async getBalance(address: PublicKey): Promise<bigint> {
    this.getBalanceCalls++;
    return this.balance;
  }

  async getLatestBlockhash() {
    this.blockhashRequests++;
    return {
      blockhash,
      lastValidBlockHeight: 100n,
    };
  }

  async sendRawTransaction(rawTransaction: Uint8Array): Promise<string> {
    this.beforeSend?.();
    if (this.failSend) throw this.failSend;
    this.sentRaw.push(rawTransaction);
    try {
      return base58Decoder.decode(
        VersionedTransaction.deserialize(rawTransaction).signatures[0]
      );
    } catch {
      if (rawTransaction.length >= 65) {
        return base58Decoder.decode(rawTransaction.subarray(1, 65));
      }
    }
    return "5mockSignature" + Math.random().toString(36).slice(2);
  }
}

describe("solana-chain", () => {
  const testMnemonic = bip39.generateMnemonic();
  let connection: MockSolanaConnection;
  let primaryKeypair: Keypair;
  let config: SolanaChainConfig;
  const attemptKey = () =>
    nativeTransactionAttemptKey({
      family: "solana",
      chainIdentifier: "solana-devnet",
      address: primaryKeypair.publicKey.toBase58(),
    });

  beforeEach(async () => {
    connection = new MockSolanaConnection();
    primaryKeypair = await Keypair.generate();
    config = {
      networkId: "solana-devnet",
      genesisHash: "solana-test-genesis",
      connection,
      deriveSigner: () => primaryKeypair,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    };
  });

  describe("chain properties", () => {
    it.each([
      ["solana-devnet", "Solana Devnet", "dSOL", true],
      ["solana-testnet", "Solana Testnet", "tSOL", true],
      ["solana-mainnet", "Solana", "SOL", false],
    ])(
      "uses configured metadata for %s",
      (networkId, name, unit, isTestnet) => {
        const chain = createSolanaChain({
          ...config,
          networkId: networkId as string,
        });
        expect({
          name: chain.name,
          unit: chain.unit,
          isTestnet: chain.isTestnet,
        }).toEqual({ name, unit, isTestnet });
        expect(chain.chainIdentifier).toBe(networkId);
        expect(chain.networkId).toBe(networkId);
        expect(chain.toDisplayAmount(1n)).toBe("0.000000001");
        expect(chain.fromDisplayAmount("0.000000001")).toBe(1n);
      }
    );

    it.each(["unknown-solana", "monad-testnet"])(
      "rejects unsupported metadata %s before effects",
      (chainIdentifier) => {
        const deriveSigner = jest.fn();
        const getGenesisHash = jest.spyOn(connection, "getGenesisHash");
        expect(() =>
          createSolanaChain({ ...config, chainIdentifier, deriveSigner })
        ).toThrow("Unsupported Solana chain identifier");
        expect(deriveSigner).not.toHaveBeenCalled();
        expect(getGenesisHash).not.toHaveBeenCalled();
        expect(connection.getBalanceCalls).toBe(0);
        expect(connection.sentRaw).toHaveLength(0);
      }
    );

    it("reports correct metadata and unit", () => {
      const chain = createSolanaChain(config);
      expect(chain.family).toBe("solana");
      expect(chain.name).toBe("Solana Devnet");
      expect(chain.unit).toBe("dSOL");
      expect(chain.isTestnet).toBe(true);
      expect(chain.capabilities.legacyConsolidation).toBe("solana-bundle");
    });

    it("parses and formats addresses correctly", () => {
      const chain = createSolanaChain(config);
      const raw = primaryKeypair.publicKey.toBase58();
      const parsed = chain.parseAddress(raw);
      expect(parsed?.raw).toBe(raw);
      expect(chain.parseAddress("invalid-address")).toBeUndefined();
    });
  });

  describe("native send", () => {
    const recipientOf = async () => ({
      raw: (await Keypair.generate()).publicKey.toBase58(),
    });
    /** The compute budget and transfer a sent transaction carries. */
    const decode = (raw: Uint8Array) => {
      const message = TransactionMessage.decompile(
        VersionedTransaction.deserialize(raw).message
      );
      const [limit, price, transfer] = message.instructions;
      return {
        units: ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units,
        microLamports:
          ComputeBudgetInstruction.decodeSetComputeUnitPrice(price)
            .microLamports,
        lamports: SystemInstruction.decodeTransfer(transfer).lamports,
        instructions: message.instructions.length,
      };
    };

    it("offers no separate legacy send: every native send is the wallet's journalled send", () => {
      const chain = createSolanaChain(config);
      expect(chain.nativeTransfers.sendLegacy).toBeUndefined();
    });

    it("sends without a compute budget when no priority fee applies", async () => {
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipient = await recipientOf();
      const estimate = await chain.nativeTransfers.estimateLegacyFee!({
        wallet,
        recipient,
        value: 100_000_000n,
      });
      expect(estimate).toEqual({
        totalFee: 5_000n,
        inputCount: 1,
        deliveryFee: 5_000n,
      });

      const result = await chain.nativeTransfers.send({
        wallet,
        recipient,
        value: 100_000_000n,
        maxFee: estimate.totalFee,
      });
      expect(connection.sentRaw).toHaveLength(1);
      const message = TransactionMessage.decompile(
        VersionedTransaction.deserialize(connection.sentRaw[0]).message
      );
      expect(
        message.instructions.some((ix) =>
          ix.programId.equals(ComputeBudgetProgram.programId)
        )
      ).toBe(false);
      expect(config.nativeAttemptStore!.get(attemptKey())).toEqual(result);
    });

    it("signs the reviewed priority fee into the transfer and journals it before broadcast", async () => {
      config.computeBudget = { priorityFeeMicroLamports: 12_500n };
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipient = await recipientOf();
      const estimate = await chain.nativeTransfers.estimateLegacyFee!({
        wallet,
        recipient,
        value: 100_000_000n,
      });
      // 5,000 signature fee + ceil(70,000 units * 12,500 micro-lamports / 10^6).
      expect(estimate.totalFee).toBe(5_875n);

      let journalledAtBroadcast: unknown;
      connection.beforeSend = () => {
        journalledAtBroadcast = config.nativeAttemptStore!.get(attemptKey());
      };
      const onSigned = jest.fn(async () => {
        expect(config.nativeAttemptStore!.get(attemptKey())).toBeDefined();
      });
      const result = await chain.nativeTransfers.send({
        wallet,
        recipient,
        value: 100_000_000n,
        maxFee: estimate.totalFee,
        onSigned,
      });

      expect(onSigned).toHaveBeenCalledWith(result);
      expect(journalledAtBroadcast).toEqual(result);
      expect(decode(connection.sentRaw[0])).toEqual({
        units: 70_000,
        microLamports: 12_500n,
        lamports: 100_000_000n,
        instructions: 4,
      });
    });

    it("refuses, unsigned, a fee above the reviewed fee", async () => {
      config.computeBudget = { priorityFeeMicroLamports: 12_500n };
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const onSigned = jest.fn();

      const refusal = chain.nativeTransfers.send({
        wallet,
        recipient: await recipientOf(),
        value: 100_000_000n,
        maxFee: 5_874n,
        onSigned,
      });

      await expect(refusal).rejects.toBeInstanceOf(NativeFeeExceededError);
      await expect(refusal).rejects.toMatchObject({ fee: 5_875n });
      expect(onSigned).not.toHaveBeenCalled();
      expect(connection.sentRaw).toHaveLength(0);
      expect(config.nativeAttemptStore!.get(attemptKey())).toBeUndefined();
    });

    it("keeps a priority-fee transfer whose broadcast timed out unresolved after reopening, and refuses a second send", async () => {
      config.computeBudget = { priorityFeeMicroLamports: 12_500n };
      connection.status = null; // the chain has not seen it
      connection.failSend = new Error("RPC request timed out");
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      let signed: { txHash: string } | undefined;

      // Dispatched the way the Send page does: its legacy send when the chain offers one.
      const client = chain.nativeTransfers;
      const params = {
        wallet,
        recipient: await recipientOf(),
        value: 100_000_000n,
        maxFee: 5_875n,
        onSigned: async (transaction: { txHash: string }) => {
          signed = transaction;
        },
      };
      const first = client.sendLegacy
        ? client.sendLegacy(params)
        : client.send(params);
      await expect(first).rejects.toBeInstanceOf(
        NativeTransactionSubmissionError
      );
      expect(signed).toBeDefined();

      // The app reloads: a fresh chain and wallet over the same durable journal.
      connection.failSend = undefined;
      const reopenedChain = createSolanaChain(config);
      const reopened = (await reopenedChain.createWallet({
        mnemonic: testMnemonic,
      })) as SolanaWallet;
      expect(reopened.getUnresolvedNativeTransaction()).toEqual(signed);

      const sentBefore = connection.blockhashRequests;
      await expect(
        reopenedChain.nativeTransfers.send({
          wallet: reopened,
          recipient: await recipientOf(),
          value: 100_000_000n,
          maxFee: 5_875n,
        })
      ).rejects.toBeInstanceOf(NativeTransactionSubmissionError);
      expect(connection.blockhashRequests).toBe(sentBefore);
      expect(connection.sentRaw).toHaveLength(0);
    });

    it("rejects a wallet from another Solana network before signing", async () => {
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const other = createSolanaChain({ ...config, networkId: "solana-mainnet" });
      await expect(
        other.nativeTransfers.send({
          wallet,
          recipient: await recipientOf(),
          value: 1n,
        })
      ).rejects.toThrow("Expected Solana network solana-mainnet");
      expect(connection.sentRaw).toHaveLength(0);
    });
  });

  describe("ChainUtxoPool multi-input builder", () => {
    it("verifies buildMultiInputTransfer dynamically computes units and attaches compute budget instructions", async () => {
      const pool = new ChainUtxoPool();
      const recipient = await Keypair.generate();
      const change = await Keypair.generate();

      // Case A: 1 input with positive priority fee
      const singleKp = await Keypair.generate();
      const singleCoin = pool.solana.registerAccount({
        chain: "solana",
        address: singleKp.publicKey.toBase58(),
        privateKey: Buffer.from(singleKp.secretKey).toString("hex"),
        balanceWei: 1_000_000_000n,
      });

      const singleTransfer = await pool.solana.buildMultiInputTransfer({
        inputs: [singleCoin],
        recipientAddress: recipient.publicKey.toBase58(),
        targetAmountLamports: 100_000_000n,
        changeAddress: change.publicKey.toBase58(),
        recentBlockhash: blockhash,
        priorityFeeMicroLamports: 20_000n,
      });

      expect(
        singleTransfer.transaction.instructions.length
      ).toBeGreaterThanOrEqual(3);
      const singleLimitIx = singleTransfer.transaction.instructions[0];
      const singlePriceIx = singleTransfer.transaction.instructions[1];

      expect(
        singleLimitIx.programId.equals(ComputeBudgetProgram.programId)
      ).toBe(true);
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(singleLimitIx)
      ).toEqual({
        units: 6000, // 1 input: Math.max(2000, 1000 * 1 + 5000) = 6000
      });

      expect(
        singlePriceIx.programId.equals(ComputeBudgetProgram.programId)
      ).toBe(true);
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitPrice(singlePriceIx)
      ).toEqual({
        microLamports: 20_000n,
      });

      // Case B: 3 inputs with 0n priority fee (no SetComputeUnitPrice)
      const kps = await Promise.all([
        Keypair.generate(),
        Keypair.generate(),
        Keypair.generate(),
      ]);
      const coins = kps.map((kp, idx) =>
        pool.solana.registerDerivedAccount({
          chain: "solana",
          address: kp.publicKey.toBase58(),
          privateKey: Buffer.from(kp.secretKey).toString("hex"),
          balanceWei: 200_000_000n,
          index: idx,
        })
      );

      const multiTransfer = await pool.solana.buildMultiInputTransfer({
        inputs: coins,
        recipientAddress: recipient.publicKey.toBase58(),
        targetAmountLamports: 500_000_000n,
        changeAddress: change.publicKey.toBase58(),
        recentBlockhash: blockhash,
        priorityFeeMicroLamports: 0n,
      });

      const multiLimitIx = multiTransfer.transaction.instructions[0];
      expect(
        multiLimitIx.programId.equals(ComputeBudgetProgram.programId)
      ).toBe(true);
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(multiLimitIx)
      ).toEqual({
        units: 8000, // 3 inputs: Math.max(2000, 1000 * 3 + 5000) = 8000
      });

      const hasPriceIx = multiTransfer.transaction.instructions.some(
        (ix) =>
          ix.programId.equals(ComputeBudgetProgram.programId) &&
          ComputeBudgetInstruction.decodeInstructionType(ix) ===
            "SetComputeUnitPrice"
      );
      expect(hasPriceIx).toBe(false);
    });
  });
});

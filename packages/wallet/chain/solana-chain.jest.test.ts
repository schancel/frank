import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  ComputeBudgetInstruction,
} from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";
import * as bip39 from "bip39";

import { createSolanaChain, SolanaChainConfig } from "./solana-chain";
import { SolanaWalletConnection, SolanaWallet } from "../solana-wallet";
import { ChainUtxoPool } from "../chain-utxo-pool";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";

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

  async getSignatureStatus(signature: string) {
    return {
      value: {
        err: null,
        confirmationStatus: "confirmed" as const,
      },
    };
  }

  async getBalance(address: PublicKey): Promise<bigint> {
    this.getBalanceCalls++;
    return this.balance;
  }

  async getLatestBlockhash() {
    return {
      blockhash,
      lastValidBlockHeight: 100n,
    };
  }

  async sendRawTransaction(rawTransaction: Uint8Array): Promise<string> {
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
    it("reports correct metadata and unit", () => {
      const chain = createSolanaChain(config);
      expect(chain.family).toBe("solana");
      expect(chain.name).toBe("Solana Testnet");
      expect(chain.unit).toBe("tSOL");
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

  describe("sendLegacy", () => {
    it("executes single-input legacy transfer when chainUtxoPool is not present", async () => {
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      const onProgress = jest.fn();
      const onSigned = jest.fn().mockResolvedValue(undefined);

      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 100_000_000n, // 0.1 SOL
        onProgress,
        onSigned,
      });

      expect(result.totalValueSent).toBe(100_000_000n);
      expect(result.totalFeePaid).toBe(5000n);
      expect(result.txHash).toBeDefined();
      expect(connection.sentRaw.length).toBe(1);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "broadcasting" } })
      );
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "confirmed", txHash: result.txHash } })
      );
    });

    it("executes atomic multi-input legacy transfer when chainUtxoPool is present and multiple coins are selected", async () => {
      const pool = new ChainUtxoPool();
      const solanaKp1 = await Keypair.generate();
      const solanaKp2 = await Keypair.generate();

      // Register two UTXOs in the pool
      const coin1 = pool.solana.registerDerivedAccount({
        chain: "solana",
        address: solanaKp1.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp1.secretKey).toString("hex"),
        balanceWei: 300_000_000n, // 0.3 SOL
      });
      const coin2 = pool.solana.registerDerivedAccount({
        chain: "solana",
        address: solanaKp2.publicKey.toBase58(),
        privateKey: Buffer.from(solanaKp2.secretKey).toString("hex"),
        balanceWei: 400_000_000n, // 0.4 SOL
      });

      config.chainUtxoPool = pool;
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      // Set primary balance low so it must consolidate from pool
      connection.balance = 50_000n;

      const onProgress = jest.fn();
      const onSigned = jest.fn().mockResolvedValue(undefined);

      // Target 600,000,000 lamports (0.6 SOL) which requires coin1 + coin2
      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 600_000_000n,
        onProgress,
        onSigned,
      });

      expect(result.totalValueSent).toBe(600_000_000n);
      expect(result.totalFeePaid).toBe(5000n);
      expect(result.inputCount).toBe(2);
      expect(result.txHash).toBeDefined();
      expect(connection.sentRaw.length).toBe(1);

      // Verify onSigned received the transaction hash before broadcast
      expect(onSigned).toHaveBeenCalledTimes(1);
      expect(onSigned).toHaveBeenCalledWith({ txHash: result.txHash });

      // Verify progress notifications
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "broadcasting" } })
      );
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ status: { stage: "confirmed", txHash: result.txHash } })
      );

      // Verify input coins are marked spent in the pool
      expect(pool.getCoin(coin1.id)?.status).toBe("spent");
      expect(pool.getCoin(coin2.id)?.status).toBe("spent");
    });

    it("executes multi-input transfer when target amount exceeds primary account balance", async () => {
      const pool = new ChainUtxoPool();
      const subKp = await Keypair.generate();

      const subCoin = pool.solana.registerDerivedAccount({
        chain: "solana",
        address: subKp.publicKey.toBase58(),
        privateKey: Buffer.from(subKp.secretKey).toString("hex"),
        balanceWei: 500_000_000n,
      });

      config.chainUtxoPool = pool;
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      // Primary account has 0 balance, target is 200,000,000 lamports
      connection.balance = 0n;

      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 200_000_000n,
      });

      expect(result.totalValueSent).toBe(200_000_000n);
      expect(result.txHash).toBeDefined();
      expect(pool.getCoin(subCoin.id)?.status).toBe("spent");
    });

    it("estimates legacy fees correctly when chainUtxoPool is attached", async () => {
      const pool = new ChainUtxoPool();
      const kp1 = await Keypair.generate();
      const kp2 = await Keypair.generate();

      pool.solana.registerDerivedAccount({
        chain: "solana",
        address: kp1.publicKey.toBase58(),
        privateKey: Buffer.from(kp1.secretKey).toString("hex"),
        balanceWei: 100_000_000n,
      });
      pool.solana.registerDerivedAccount({
        chain: "solana",
        address: kp2.publicKey.toBase58(),
        privateKey: Buffer.from(kp2.secretKey).toString("hex"),
        balanceWei: 200_000_000n,
      });

      config.chainUtxoPool = pool;
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      const estimate = await chain.nativeTransfers.estimateLegacyFee!({
        wallet,
        recipient,
        value: 250_000_000n,
      });

      expect(estimate.totalFee).toBe(5000n);
      expect(estimate.inputCount).toBe(2);
      expect(estimate.deliveryFee).toBe(5000n);
    });

    it("attaches ComputeBudgetProgram.setComputeUnitLimit and setComputeUnitPrice when priorityFeeMicroLamports is provided (#1220)", async () => {
      const pool = new ChainUtxoPool();
      const kp1 = await Keypair.generate();
      const kp2 = await Keypair.generate();

      const coin1 = pool.solana.registerAccount({
        chain: "solana",
        address: kp1.publicKey.toBase58(),
        privateKey: Buffer.from(kp1.secretKey).toString("hex"),
        balanceWei: 300_000_000n,
      });
      const coin2 = pool.solana.registerDerivedAccount({
        chain: "solana",
        address: kp2.publicKey.toBase58(),
        privateKey: Buffer.from(kp2.secretKey).toString("hex"),
        balanceWei: 400_000_000n,
      });

      config.chainUtxoPool = pool;
      connection.sentRaw = [];
      connection.balance = 10_000n; // low primary balance forces consolidation
      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic: testMnemonic });
      const recipientKp = await Keypair.generate();
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 500_000_000n,
        priorityFeeMicroLamports: 12_500n,
      });

      expect(result.txHash).toBeDefined();
      expect(connection.sentRaw.length).toBe(1);

      const deserialized = await Transaction.from(connection.sentRaw[0]);

      // Verify SetComputeUnitLimit instruction
      const limitIx = deserialized.instructions.find(
        (ix) =>
          ix.programId.equals(ComputeBudgetProgram.programId) &&
          ComputeBudgetInstruction.decodeInstructionType(ix) ===
            "SetComputeUnitLimit"
      );
      expect(limitIx).toBeDefined();
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(limitIx!)
      ).toEqual({
        units: 7000, // 2 inputs: Math.max(2000, 1000 * 2 + 5000) = 7000
      });

      // Verify SetComputeUnitPrice instruction
      const priceIx = deserialized.instructions.find(
        (ix) =>
          ix.programId.equals(ComputeBudgetProgram.programId) &&
          ComputeBudgetInstruction.decodeInstructionType(ix) ===
            "SetComputeUnitPrice"
      );
      expect(priceIx).toBeDefined();
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitPrice(priceIx!)
      ).toEqual({
        microLamports: 12_500n,
      });

      expect(pool.getCoin(coin1.id)?.status).toBe("spent");
      expect(pool.getCoin(coin2.id)?.status).toBe("spent");
    });

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

      expect(singleTransfer.transaction.instructions.length).toBeGreaterThanOrEqual(3);
      const singleLimitIx = singleTransfer.transaction.instructions[0];
      const singlePriceIx = singleTransfer.transaction.instructions[1];

      expect(singleLimitIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(singleLimitIx)).toEqual({
        units: 6000, // 1 input: Math.max(2000, 1000 * 1 + 5000) = 6000
      });

      expect(singlePriceIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(singlePriceIx)).toEqual({
        microLamports: 20_000n,
      });

      // Case B: 3 inputs with 0n priority fee (no SetComputeUnitPrice)
      const kps = await Promise.all([Keypair.generate(), Keypair.generate(), Keypair.generate()]);
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
      expect(multiLimitIx.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(multiLimitIx)).toEqual({
        units: 8000, // 3 inputs: Math.max(2000, 1000 * 3 + 5000) = 8000
      });

      const hasPriceIx = multiTransfer.transaction.instructions.some(
        (ix) =>
          ix.programId.equals(ComputeBudgetProgram.programId) &&
          ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitPrice"
      );
      expect(hasPriceIx).toBe(false);
    });
  });
});

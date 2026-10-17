import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";
import * as bip39 from "bip39";

import {
  buildSolanaComputeBudgetInstructions,
  computeSolanaComputeUnitLimit,
  computeSolanaPriorityFeeLamports,
  computeSweepDecoyDelayMs,
  createSolanaChain,
  DEFAULT_SOLANA_BASE_FEE_LAMPORTS,
  DEFAULT_SOLANA_MAX_COMPUTE_UNITS,
  DEFAULT_SOLANA_MIN_COMPUTE_UNITS,
  prependSolanaComputeBudgetInstructions,
  sampleSolanaPriorityFeeMicroLamports,
  scheduleBackgroundSweepWithJitter,
  SOLANA_SWEEP_DECOY_MAX_DELAY_MS,
  SOLANA_SWEEP_DECOY_MIN_DELAY_MS,
  SolanaChainConfig,
  SolanaChainConnection,
  SolanaPrioritizationFeeSample,
} from "./solana-chain";
import { ChainUtxoPool } from "../chain-utxo-pool";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";

const base58Decoder = getBase58Decoder();
const testBlockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

class MockRpcConnection implements SolanaChainConnection {
  balance = 1_000_000_000n;
  sentRaw: Uint8Array[] = [];
  genesisHash = "solana-compute-budget-genesis";
  prioritizationFees?:
    | ReadonlyArray<SolanaPrioritizationFeeSample>
    | (() => Promise<ReadonlyArray<SolanaPrioritizationFeeSample>>);

  getRecentPrioritizationFees?: SolanaChainConnection["getRecentPrioritizationFees"];

  constructor(options?: {
    withPrioritizationFees?:
      | ReadonlyArray<SolanaPrioritizationFeeSample>
      | (() => Promise<ReadonlyArray<SolanaPrioritizationFeeSample>>);
  }) {
    if (options?.withPrioritizationFees !== undefined) {
      this.prioritizationFees = options.withPrioritizationFees;
      this.getRecentPrioritizationFees = jest.fn(async () => {
        if (typeof this.prioritizationFees === "function") {
          return this.prioritizationFees();
        }
        return this.prioritizationFees ?? [];
      });
    }
  }

  async getGenesisHash(): Promise<string> {
    return this.genesisHash;
  }

  async getSignatureStatus() {
    return {
      value: {
        err: null,
        confirmationStatus: "confirmed" as const,
      },
    };
  }

  async getBalance(): Promise<bigint> {
    return this.balance;
  }

  async getLatestBlockhash() {
    return {
      blockhash: testBlockhash,
      lastValidBlockHeight: 500n,
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
    return "5mockSigComputeBudget";
  }
}

describe("solana-compute-budget (#1220)", () => {
  describe("computeSolanaComputeUnitLimit & computeSolanaPriorityFeeLamports", () => {
    it("computes dynamic compute units for single-input and multi-input transfers", () => {
      expect(computeSolanaComputeUnitLimit({ inputCount: 1 })).toBe(6_000);
      expect(computeSolanaComputeUnitLimit({ inputCount: 2 })).toBe(7_000);
      expect(computeSolanaComputeUnitLimit({ inputCount: 5 })).toBe(10_000);
      expect(
        computeSolanaComputeUnitLimit({
          inputCount: 2,
          extraInstructionCount: 3,
          perInstructionComputeUnits: 600,
        })
      ).toBe(8_800);
    });

    it("clamps compute unit limit between floor and ceiling bounds", () => {
      expect(
        computeSolanaComputeUnitLimit({
          computeUnitLimit: 500,
        })
      ).toBe(DEFAULT_SOLANA_MIN_COMPUTE_UNITS);

      expect(
        computeSolanaComputeUnitLimit({
          computeUnitLimit: 5_000_000,
        })
      ).toBe(DEFAULT_SOLANA_MAX_COMPUTE_UNITS);

      expect(
        computeSolanaComputeUnitLimit({
          computeUnitLimit: 45_000,
          minComputeUnits: 10_000,
          maxComputeUnits: 30_000,
        })
      ).toBe(30_000);
    });

    it("computes priority fee in lamports using ceiling division", () => {
      expect(computeSolanaPriorityFeeLamports(7_000, 0n)).toBe(0n);
      expect(computeSolanaPriorityFeeLamports(0, 25_000n)).toBe(0n);
      // 7,000 * 12,500 = 87,500,000 micro-lamports => ceil(87.5) = 88 lamports
      expect(computeSolanaPriorityFeeLamports(7_000, 12_500n)).toBe(88n);
      // 10,000 * 100,000 = 1,000,000,000 micro-lamports => 1,000 lamports
      expect(computeSolanaPriorityFeeLamports(10_000, 100_000n)).toBe(1_000n);
    });
  });

  describe("ComputeBudgetProgram instruction construction and ordering", () => {
    it("constructs SetComputeUnitLimit followed by SetComputeUnitPrice when priority fee > 0", () => {
      const ixs = buildSolanaComputeBudgetInstructions({
        units: 9_000,
        priorityFeeMicroLamports: 15_000n,
      });

      expect(ixs).toHaveLength(2);
      expect(ixs[0].programId.equals(ComputeBudgetProgram.programId)).toBe(
        true
      );
      expect(ComputeBudgetInstruction.decodeInstructionType(ixs[0])).toBe(
        "SetComputeUnitLimit"
      );
      expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(ixs[0])).toEqual(
        { units: 9_000 }
      );

      expect(ixs[1].programId.equals(ComputeBudgetProgram.programId)).toBe(
        true
      );
      expect(ComputeBudgetInstruction.decodeInstructionType(ixs[1])).toBe(
        "SetComputeUnitPrice"
      );
      expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ixs[1])).toEqual(
        { microLamports: 15_000n }
      );
    });

    it("omits SetComputeUnitPrice when priorityFeeMicroLamports is 0n or undefined", () => {
      const ixs = buildSolanaComputeBudgetInstructions({
        units: 6_000,
        priorityFeeMicroLamports: 0n,
      });

      expect(ixs).toHaveLength(1);
      expect(ComputeBudgetInstruction.decodeInstructionType(ixs[0])).toBe(
        "SetComputeUnitLimit"
      );
      expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(ixs[0])).toEqual(
        { units: 6_000 }
      );
    });

    it("prepends compute budget instructions before transfer instructions and deduplicates existing budget instructions", async () => {
      const sender = await Keypair.generate();
      const recipient = await Keypair.generate();
      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 3_000 }),
        SystemProgram.transfer({
          fromPubkey: sender.publicKey,
          toPubkey: recipient.publicKey,
          lamports: 50_000n,
        })
      );

      prependSolanaComputeBudgetInstructions(tx, {
        units: 12_000,
        priorityFeeMicroLamports: 25_000n,
      });

      expect(tx.instructions).toHaveLength(3);
      expect(
        ComputeBudgetInstruction.decodeInstructionType(tx.instructions[0])
      ).toBe("SetComputeUnitLimit");
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(tx.instructions[0])
      ).toEqual({ units: 12_000 });
      expect(
        ComputeBudgetInstruction.decodeInstructionType(tx.instructions[1])
      ).toBe("SetComputeUnitPrice");
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitPrice(tx.instructions[1])
      ).toEqual({ microLamports: 25_000n });
      expect(tx.instructions[2].programId.equals(SystemProgram.programId)).toBe(
        true
      );
    });
  });

  describe("Priority fee sampling from getRecentPrioritizationFees", () => {
    it("samples median prioritization fee from getRecentPrioritizationFees", async () => {
      const connection = new MockRpcConnection({
        withPrioritizationFees: [
          { slot: 100, prioritizationFee: 5_000 },
          { slot: 101, prioritizationFee: 25_000 },
          { slot: 102, prioritizationFee: 12_000 },
          { slot: 103, prioritizationFee: 18_000 },
          { slot: 104, prioritizationFee: 90_000 },
        ],
      });

      const sampled = await sampleSolanaPriorityFeeMicroLamports({
        connection,
      });

      // Sorted: [5_000, 12_000, 18_000, 25_000, 90_000] -> median is 18_000n
      expect(sampled).toBe(18_000n);
      expect(connection.getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
    });

    it("clamps sampled fee to [minPriorityFeeMicroLamports, maxPriorityFeeMicroLamports]", async () => {
      const highConn = new MockRpcConnection({
        withPrioritizationFees: [
          { slot: 1, prioritizationFee: 500_000 },
          { slot: 2, prioritizationFee: 800_000 },
          { slot: 3, prioritizationFee: 1_200_000 },
        ],
      });

      const clampedHigh = await sampleSolanaPriorityFeeMicroLamports({
        connection: highConn,
        minPriorityFeeMicroLamports: 1_000n,
        maxPriorityFeeMicroLamports: 250_000n,
      });
      expect(clampedHigh).toBe(250_000n);

      const lowConn = new MockRpcConnection({
        withPrioritizationFees: [
          { slot: 1, prioritizationFee: 100 },
          { slot: 2, prioritizationFee: 200 },
          { slot: 3, prioritizationFee: 300 },
        ],
      });

      const clampedLow = await sampleSolanaPriorityFeeMicroLamports({
        connection: lowConn,
        minPriorityFeeMicroLamports: 2_500n,
        maxPriorityFeeMicroLamports: 250_000n,
      });
      expect(clampedLow).toBe(2_500n);
    });

    it("falls back gracefully when getRecentPrioritizationFees is missing, returns empty, or throws", async () => {
      // 1. Missing getRecentPrioritizationFees
      const plainConn = new MockRpcConnection();
      expect(
        await sampleSolanaPriorityFeeMicroLamports({ connection: plainConn })
      ).toBe(0n);
      expect(
        await sampleSolanaPriorityFeeMicroLamports({
          connection: plainConn,
          defaultPriorityFeeMicroLamports: 4_000n,
        })
      ).toBe(4_000n);

      // 2. Empty array response
      const emptyConn = new MockRpcConnection({ withPrioritizationFees: [] });
      expect(
        await sampleSolanaPriorityFeeMicroLamports({
          connection: emptyConn,
          defaultPriorityFeeMicroLamports: 3_500n,
        })
      ).toBe(3_500n);

      // 3. Throwing RPC call
      const failingConn = new MockRpcConnection({
        withPrioritizationFees: async () => {
          throw new Error("RPC method not supported");
        },
      });
      expect(
        await sampleSolanaPriorityFeeMicroLamports({
          connection: failingConn,
          defaultPriorityFeeMicroLamports: 6_000n,
        })
      ).toBe(6_000n);
      expect(
        await sampleSolanaPriorityFeeMicroLamports({
          connection: failingConn,
        })
      ).toBe(0n);
    });

    it("integrates RPC priority fee sampling into createSolanaChain sendLegacy and estimateLegacyFee", async () => {
      const mnemonic = bip39.generateMnemonic();
      const primaryKp = await Keypair.generate();
      const recipientKp = await Keypair.generate();
      const connection = new MockRpcConnection({
        withPrioritizationFees: [
          { slot: 10, prioritizationFee: 10_000 },
          { slot: 11, prioritizationFee: 20_000 },
          { slot: 12, prioritizationFee: 30_000 },
        ],
      });

      const config: SolanaChainConfig = {
        networkId: "solana-devnet",
        genesisHash: connection.genesisHash,
        connection,
        deriveSigner: () => primaryKp,
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        computeBudget: {
          maxPriorityFeeMicroLamports: 50_000n,
        },
      };

      const chain = createSolanaChain(config);
      const wallet = await chain.createWallet({ mnemonic });
      const recipient = { raw: recipientKp.publicKey.toBase58() };

      // 1 input -> 6,000 units; median fee = 20,000 micro-lamports/CU -> ceil(6000 * 20000 / 1e6) = 120 lamports
      const estimate = await chain.nativeTransfers.estimateLegacyFee!({
        wallet,
        recipient,
        value: 50_000_000n,
      });
      expect(estimate.inputCount).toBe(1);
      expect(estimate.totalFee).toBe(DEFAULT_SOLANA_BASE_FEE_LAMPORTS + 120n);

      const sendResult = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient,
        value: 50_000_000n,
      });
      expect(sendResult.totalFeePaid).toBe(
        DEFAULT_SOLANA_BASE_FEE_LAMPORTS + 120n
      );
      expect(connection.sentRaw).toHaveLength(1);

      const deserialized = Transaction.from(connection.sentRaw[0]);
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(
          deserialized.instructions[0]
        )
      ).toEqual({ units: 6_000 });
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitPrice(
          deserialized.instructions[1]
        )
      ).toEqual({ microLamports: 20_000n });
    });

    it("applies custom computeUnitLimit on multi-input sendLegacy transfers", async () => {
      const mnemonic = bip39.generateMnemonic();
      const primaryKp = await Keypair.generate();
      const kp1 = await Keypair.generate();
      const kp2 = await Keypair.generate();
      const recipientKp = await Keypair.generate();

      const pool = new ChainUtxoPool();
      pool.solana.registerDerivedAccount({
        chain: "solana",
        address: kp1.publicKey.toBase58(),
        privateKey: Buffer.from(kp1.secretKey).toString("hex"),
        balanceWei: 300_000_000n,
      });
      pool.solana.registerDerivedAccount({
        chain: "solana",
        address: kp2.publicKey.toBase58(),
        privateKey: Buffer.from(kp2.secretKey).toString("hex"),
        balanceWei: 300_000_000n,
      });

      const connection = new MockRpcConnection({
        withPrioritizationFees: [{ slot: 1, prioritizationFee: 10_000 }],
      });
      connection.balance = 10_000n;

      const chain = createSolanaChain({
        networkId: "solana-devnet",
        genesisHash: connection.genesisHash,
        connection,
        deriveSigner: () => primaryKp,
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        chainUtxoPool: pool,
        computeBudget: {
          computeUnitLimit: 15_000,
        },
      });

      const wallet = await chain.createWallet({ mnemonic });
      const result = await chain.nativeTransfers.sendLegacy!({
        wallet,
        recipient: { raw: recipientKp.publicKey.toBase58() },
        value: 450_000_000n,
      });

      // 15,000 units * 10,000 micro-lamports = 150,000,000 micro-lamports = 150 lamports
      expect(result.totalFeePaid).toBe(5_150n);
      const tx = Transaction.from(connection.sentRaw[0]);
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitLimit(tx.instructions[0])
      ).toEqual({ units: 15_000 });
      expect(
        ComputeBudgetInstruction.decodeSetComputeUnitPrice(tx.instructions[1])
      ).toEqual({ microLamports: 10_000n });
    });
  });

  describe("Poisson-distributed background sweep decoy jitter", () => {
    it("clamps Poisson decoy delay within [10_000, 120_000] ms across all uniform inputs", () => {
      expect(computeSweepDecoyDelayMs(() => 0)).toBe(
        SOLANA_SWEEP_DECOY_MIN_DELAY_MS
      );
      expect(computeSweepDecoyDelayMs(() => 0.001)).toBe(
        SOLANA_SWEEP_DECOY_MIN_DELAY_MS
      );
      expect(computeSweepDecoyDelayMs(() => 0.9999)).toBe(
        SOLANA_SWEEP_DECOY_MAX_DELAY_MS
      );
      expect(computeSweepDecoyDelayMs(() => 1)).toBe(
        SOLANA_SWEEP_DECOY_MAX_DELAY_MS
      );

      // Mid-range sample: u = 0.5 -> -30_000 * ln(0.5) ≈ 20,794 ms
      const midDelay = computeSweepDecoyDelayMs(() => 0.5);
      expect(midDelay).toBe(Math.round(-30_000 * Math.log(0.5)));
      expect(midDelay).toBeGreaterThanOrEqual(SOLANA_SWEEP_DECOY_MIN_DELAY_MS);
      expect(midDelay).toBeLessThanOrEqual(SOLANA_SWEEP_DECOY_MAX_DELAY_MS);

      // Verify monotonic non-decreasing behavior across uniform grid
      let previous = SOLANA_SWEEP_DECOY_MIN_DELAY_MS;
      for (let i = 0; i <= 100; i++) {
        const u = i / 100;
        const d = computeSweepDecoyDelayMs(() => u);
        expect(d).toBeGreaterThanOrEqual(SOLANA_SWEEP_DECOY_MIN_DELAY_MS);
        expect(d).toBeLessThanOrEqual(SOLANA_SWEEP_DECOY_MAX_DELAY_MS);
        expect(d).toBeGreaterThanOrEqual(previous);
        previous = d;
      }
    });

    it("schedules background sweep after Poisson jitter delay and supports cancellation", async () => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
      try {
        const sweepFn = jest.fn().mockResolvedValue("swept-ok");
        const onComplete = jest.fn();

        const handle = scheduleBackgroundSweepWithJitter(sweepFn, {
          randomFn: () => 0.5,
          onComplete,
        });

        expect(handle.delayMs).toBe(Math.round(-30_000 * Math.log(0.5)));
        expect(handle.delayMs).toBeGreaterThanOrEqual(10_000);
        expect(handle.delayMs).toBeLessThanOrEqual(120_000);
        expect(sweepFn).not.toHaveBeenCalled();

        jest.advanceTimersByTime(handle.delayMs - 1);
        expect(sweepFn).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        const outcome = await handle.promise;
        expect(sweepFn).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith("swept-ok");
        expect(outcome).toBe("swept-ok");

        // Test cancellation before timer fires
        const cancelledSweep = jest.fn();
        const cancelHandle = scheduleBackgroundSweepWithJitter(cancelledSweep, {
          randomFn: () => 0.7,
        });
        expect(cancelHandle.cancelled).toBe(false);
        cancelHandle.cancel();
        expect(cancelHandle.cancelled).toBe(true);

        jest.advanceTimersByTime(120_000);
        await expect(cancelHandle.promise).resolves.toBeUndefined();
        expect(cancelledSweep).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it("handles background sweep errors via onError callback without unhandled rejections", async () => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
      try {
        const error = new Error("background sweep RPC timeout");
        const sweepFn = jest.fn().mockRejectedValue(error);
        const onError = jest.fn();

        const handle = scheduleBackgroundSweepWithJitter(sweepFn, {
          randomFn: () => 0.1,
          onError,
        });

        jest.advanceTimersByTime(handle.delayMs);
        await expect(handle.promise).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledWith(error);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

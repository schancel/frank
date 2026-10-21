import {
  ComputeBudgetInstruction,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getBase58Decoder } from "@solana/codecs-strings";
import * as bip39 from "bip39";

import {
  computeSolanaComputeUnitLimit,
  computeSweepDecoyDelayMs,
  createSolanaChain,
  DEFAULT_SOLANA_MAX_COMPUTE_UNITS,
  DEFAULT_SOLANA_MIN_COMPUTE_UNITS,
  sampleSolanaPriorityFeeMicroLamports,
  scheduleBackgroundSweepWithJitter,
  SOLANA_SWEEP_DECOY_MAX_DELAY_MS,
  SOLANA_SWEEP_DECOY_MIN_DELAY_MS,
  SolanaChainConfig,
  SolanaChainConnection,
  SolanaPrioritizationFeeSample,
} from "./solana-chain";
import { InMemoryNativeTransactionAttemptStore } from "./chain-wallet";
import {
  SOLANA_NATIVE_TRANSFER_MIN_COMPUTE_UNITS,
  SOLANA_SIGNATURE_FEE_LAMPORTS,
  solanaNativeTransferFee,
} from "../solana-wallet";

const base58Decoder = getBase58Decoder();
const testBlockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

/** The leading compute-budget instructions of a sent native transfer. */
function budgetOf(raw: Uint8Array) {
  return TransactionMessage.decompile(
    VersionedTransaction.deserialize(raw).message
  ).instructions.slice(0, 2);
}

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
  describe("computeSolanaComputeUnitLimit & solanaNativeTransferFee", () => {
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

    it("computes a native transfer's fee with ceiling division of its priority fee", () => {
      expect(solanaNativeTransferFee()).toBe(SOLANA_SIGNATURE_FEE_LAMPORTS);
      expect(
        solanaNativeTransferFee({ units: 70_000, priorityFeeMicroLamports: 0n })
      ).toBe(5_000n);
      // 70,000 * 12,345 = 864,150,000 micro-lamports => ceil(864.15) = 865 lamports
      expect(
        solanaNativeTransferFee({
          units: 70_000,
          priorityFeeMicroLamports: 12_345n,
        })
      ).toBe(5_865n);
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

    it("integrates RPC priority fee sampling into createSolanaChain send and estimateLegacyFee", async () => {
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

      // 70,000 units (the memo-bearing transfer's floor); median 20,000 micro-lamports/CU
      // -> ceil(70,000 * 20,000 / 1e6) = 1,400 lamports.
      const estimate = await chain.nativeTransfers.estimateLegacyFee!({
        wallet,
        recipient,
        value: 50_000_000n,
      });
      expect(estimate.inputCount).toBe(1);
      expect(estimate.totalFee).toBe(SOLANA_SIGNATURE_FEE_LAMPORTS + 1_400n);

      await chain.nativeTransfers.send({
        wallet,
        recipient,
        value: 50_000_000n,
        maxFee: estimate.totalFee,
      });
      expect(connection.sentRaw).toHaveLength(1);

      const [limit, price] = budgetOf(connection.sentRaw[0]);
      expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit)).toEqual(
        { units: SOLANA_NATIVE_TRANSFER_MIN_COMPUTE_UNITS }
      );
      expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(price)).toEqual(
        { microLamports: 20_000n }
      );
    });

    it("applies a configured computeUnitLimit, never below what the transfer's memo needs", async () => {
      const send = async (computeUnitLimit: number) => {
        const primaryKp = await Keypair.generate();
        const connection = new MockRpcConnection({
          withPrioritizationFees: [{ slot: 1, prioritizationFee: 10_000 }],
        });
        const chain = createSolanaChain({
          networkId: "solana-devnet",
          genesisHash: connection.genesisHash,
          connection,
          deriveSigner: () => primaryKp,
          nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
          computeBudget: { computeUnitLimit },
        });
        const wallet = await chain.createWallet({
          mnemonic: bip39.generateMnemonic(),
        });
        const recipient = {
          raw: (await Keypair.generate()).publicKey.toBase58(),
        };
        const { totalFee } = await chain.nativeTransfers.estimateLegacyFee!({
          wallet,
          recipient,
          value: 1_000_000n,
        });
        await chain.nativeTransfers.send({
          wallet,
          recipient,
          value: 1_000_000n,
          maxFee: totalFee,
        });
        const [limit] = budgetOf(connection.sentRaw[0]);
        return {
          totalFee,
          units: ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units,
        };
      };

      // 150,000 units * 10,000 micro-lamports = 1,500 lamports
      await expect(send(150_000)).resolves.toEqual({
        totalFee: 6_500n,
        units: 150_000,
      });
      // A 15,000-unit limit would fail on chain and still be charged: the floor applies.
      await expect(send(15_000)).resolves.toEqual({
        totalFee: 5_700n,
        units: SOLANA_NATIVE_TRANSFER_MIN_COMPUTE_UNITS,
      });
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

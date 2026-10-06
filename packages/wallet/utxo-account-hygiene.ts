/**
 * UTXO (Bitcoin / BCH / eCash) account hygiene engine (Ticket #925).
 *
 * Implements `AccountHygieneEngine` for UTXO chains:
 * - Detects / tracks spent addresses (strict no-address-reuse policy).
 * - Routes change outputs to fresh BIP-44 internal change addresses (m/44'/c'/0'/1/k).
 * - Identifies leftover dust UTXOs on dirty addresses and lazily consolidates them.
 * - Entirely encapsulated beneath the UTXO wallet backend.
 */

import {
  AccountHygieneEngine,
  AccountHygieneOptions,
  ChainDirtyReason,
  DirtyAccountRecord,
  HygieneStats,
  SweepResult,
} from './account-hygiene';

export interface UtxoDustDescriptor {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: bigint;
  readonly address: string;
}

export interface UtxoWalletBackendBridge {
  getUtxosForAddress(address: string): Promise<ReadonlyArray<UtxoDustDescriptor>>;
  broadcastConsolidationTx(params: {
    inputs: ReadonlyArray<UtxoDustDescriptor>;
    destinationAddress: string;
    totalAmountSatoshis: bigint;
  }): Promise<string>;
  getFeeRateSatPerByte(): Promise<number>;
}

export interface UtxoAccountHygieneParams {
  readonly backend: UtxoWalletBackendBridge;
  readonly changeDestinationSupplier: (index: number) => Promise<string> | string;
  readonly options?: AccountHygieneOptions;
  readonly initialChangeIndex?: number;
  readonly maxFeeRateSatPerByte?: number;
}

const DEFAULT_UTXO_DUST_THRESHOLD = 546n; // Standard Bitcoin/BCH dust threshold
const ESTIMATED_SWEEP_TX_BYTES = 148;

export class UtxoAccountHygieneEngine implements AccountHygieneEngine<string> {
  private readonly backend: UtxoWalletBackendBridge;
  private readonly changeDestinationSupplier: (index: number) => Promise<string> | string;

  private readonly dirtyAddresses = new Map<string, DirtyAccountRecord<string>>();
  private readonly sweepIntervalMs: number;
  private readonly jitterMaxMs: number;
  private readonly maxSweepsPerRun: number;
  private readonly minSweepBalance: bigint;
  private readonly maxFeeRateSatPerByte: number;

  private nextChangeIndex: number;
  private workerTimeout: NodeJS.Timeout | null = null;
  private isSweeping = false;

  private totalSweptSatoshis = 0n;
  private totalSweptCount = 0;
  private lastSweepTimestamp?: number;

  constructor(params: UtxoAccountHygieneParams) {
    this.backend = params.backend;
    this.changeDestinationSupplier = params.changeDestinationSupplier;
    this.nextChangeIndex = params.initialChangeIndex ?? 0;

    const opts = params.options ?? {};
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 45_000;
    this.jitterMaxMs = opts.jitterMaxMs ?? 15_000;
    this.maxSweepsPerRun = opts.maxSweepsPerRun ?? 10;
    this.minSweepBalance = opts.minSweepBalance ?? DEFAULT_UTXO_DUST_THRESHOLD;
    this.maxFeeRateSatPerByte = params.maxFeeRateSatPerByte ?? 5;

    if (opts.autoStartWorker) {
      this.startBackgroundWorker();
    }
  }

  markDirty(
    address: string,
    reason: ChainDirtyReason = 'output-spent',
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.dirtyAddresses.has(address)) {
      this.dirtyAddresses.set(address, {
        address,
        dirtySinceTimestamp: Date.now(),
        reason,
        metadata,
      });
    }
  }

  isDirty(address: string): boolean {
    return this.dirtyAddresses.has(address);
  }

  unmarkDirty(address: string): void {
    this.dirtyAddresses.delete(address);
  }

  async getDirtyAccounts(): Promise<ReadonlyArray<DirtyAccountRecord<string>>> {
    return Array.from(this.dirtyAddresses.values());
  }

  getNextChangeIndex(): number {
    return this.nextChangeIndex;
  }

  async sweepDirtyAccounts(options?: {
    maxSweeps?: number;
    force?: boolean;
  }): Promise<ReadonlyArray<SweepResult<string>>> {
    if (this.isSweeping) return [];
    this.isSweeping = true;

    const results: SweepResult<string>[] = [];
    const limit = options?.maxSweeps ?? this.maxSweepsPerRun;

    try {
      const currentFeeRate = await this.backend.getFeeRateSatPerByte();
      if (!options?.force && currentFeeRate > this.maxFeeRateSatPerByte) {
        // High fee period: defer sweeping to prevent wasting funds
        return [];
      }

      const records = Array.from(this.dirtyAddresses.values()).slice(0, limit);

      for (const record of records) {
        const { address } = record;
        try {
          const utxos = await this.backend.getUtxosForAddress(address);
          if (utxos.length === 0) {
            this.unmarkDirty(address);
            results.push({
              sourceAddress: address,
              amountSwept: 0n,
              outcome: 'below-dust',
            });
            continue;
          }

          const totalBalance = utxos.reduce((acc, u) => acc + u.satoshis, 0n);
          const estimatedFee = BigInt(ESTIMATED_SWEEP_TX_BYTES * currentFeeRate);

          if (totalBalance <= estimatedFee + this.minSweepBalance) {
            results.push({
              sourceAddress: address,
              amountSwept: 0n,
              outcome: 'below-dust',
            });
            continue;
          }

          const netSweptSatoshis = totalBalance - estimatedFee;
          const destinationAddress = await this.changeDestinationSupplier(this.nextChangeIndex);

          const txId = await this.backend.broadcastConsolidationTx({
            inputs: utxos,
            destinationAddress,
            totalAmountSatoshis: netSweptSatoshis,
          });

          this.nextChangeIndex++;
          this.totalSweptSatoshis += netSweptSatoshis;
          this.totalSweptCount++;
          this.lastSweepTimestamp = Date.now();
          this.unmarkDirty(address);

          results.push({
            sourceAddress: address,
            destinationAddress,
            amountSwept: netSweptSatoshis,
            txId,
            outcome: 'swept',
          });
        } catch (err) {
          results.push({
            sourceAddress: address,
            amountSwept: 0n,
            outcome: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    } finally {
      this.isSweeping = false;
    }

    return results;
  }

  startBackgroundWorker(): void {
    if (this.workerTimeout !== null) return;

    const scheduleNext = () => {
      const jitter = Math.floor(Math.random() * this.jitterMaxMs);
      const delay = this.sweepIntervalMs + jitter;

      this.workerTimeout = setTimeout(async () => {
        try {
          await this.sweepDirtyAccounts();
        } catch {
          // Autonomous background sweep errors are absorbed silently
        }
        if (this.workerTimeout !== null) {
          scheduleNext();
        }
      }, delay);
    };

    scheduleNext();
  }

  stopBackgroundWorker(): void {
    if (this.workerTimeout !== null) {
      clearTimeout(this.workerTimeout);
      this.workerTimeout = null;
    }
  }

  isBackgroundWorkerActive(): boolean {
    return this.workerTimeout !== null;
  }

  async getHygieneStats(): Promise<HygieneStats> {
    return {
      trackedDirtyCount: this.dirtyAddresses.size,
      totalSweptWei: this.totalSweptSatoshis,
      totalSweptCount: this.totalSweptCount,
      lastSweepTimestamp: this.lastSweepTimestamp,
    };
  }
}

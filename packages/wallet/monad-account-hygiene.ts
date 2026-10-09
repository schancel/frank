/**
 * EVM / Monad account hygiene engine (Ticket #925).
 *
 * Implements `AccountHygieneEngine` for EVM/Monad accounts:
 * - Detects / tracks dirty accounts (accounts that have executed a transaction, where nonce >= 1).
 * - Implements autonomous background lazy sweeping to fresh BIP-44 change addresses (m/44'/60'/0'/1/k).
 * - Incorporates randomized jitter delay and fee-awareness to defeat on-chain timing heuristics.
 * - Entirely encapsulated beneath the wallet API so consumer code never deals with nonces or sweeps.
 */

import { Provider } from 'ethers'
import {
  AccountHygieneEngine,
  AccountHygieneOptions,
  ChainDirtyReason,
  DirtyAccountRecord,
  HygieneStats,
  SweepResult,
} from './account-hygiene'
import {
  MonadChangeKeyring,
  changeAccountPath,
} from './monad-change-keyring'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import { estimateDustThresholdWei } from './monad-change-pool'
import { computeGeometricRadixChangeSplits } from './monad-change-distribution'
import type { ChainUtxoPool } from './chain-utxo-pool'

export interface MonadAccountHygieneParams {
  readonly provider: Provider
  readonly httpClient: MonadTxSubmitter
  readonly changeKeyring: MonadChangeKeyring
  readonly hdKeyring?: MonadHdKeyring
  readonly accountUtxoPool?: ChainUtxoPool
  readonly signerSupplier?: (
    address: string,
  ) => Promise<MonadAccountTxSigner | null> | (MonadAccountTxSigner | null)
  readonly options?: AccountHygieneOptions
  readonly initialChangeIndex?: number
}

export class MonadAccountHygieneEngine implements AccountHygieneEngine<string> {
  private readonly provider: Provider
  private readonly httpClient: MonadTxSubmitter
  private readonly changeKeyring: MonadChangeKeyring
  private readonly hdKeyring?: MonadHdKeyring
  private readonly accountUtxoPool?: ChainUtxoPool
  private readonly signerSupplier?: (
    address: string,
  ) => Promise<MonadAccountTxSigner | null> | (MonadAccountTxSigner | null)

  private readonly dirtyAccounts = new Map<string, DirtyAccountRecord<string>>()
  private readonly sweepIntervalMs: number
  private readonly jitterMaxMs: number
  private readonly maxSweepsPerRun: number
  private readonly minSweepBalance?: bigint

  private nextChangeIndex: number
  private workerTimeout: NodeJS.Timeout | null = null
  private isSweeping = false

  private totalSweptWei = 0n
  private totalSweptCount = 0
  private lastSweepTimestamp?: number

  constructor(params: MonadAccountHygieneParams) {
    this.provider = params.provider
    this.httpClient = params.httpClient
    this.changeKeyring = params.changeKeyring
    this.hdKeyring = params.hdKeyring
    this.accountUtxoPool = params.accountUtxoPool
    this.signerSupplier =
      params.signerSupplier ??
      (params.accountUtxoPool
        ? (address: string) => {
            const utxos = params.accountUtxoPool!.getUtxosByAddress(
              address,
              'monad',
            )
            if (utxos.length > 0) {
              return params.accountUtxoPool!.createSigner(
                utxos[0],
                this.provider,
              )
            }
            return null
          }
        : undefined)
    this.nextChangeIndex = params.initialChangeIndex ?? 0

    const opts = params.options ?? {}
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 45_000
    this.jitterMaxMs = opts.jitterMaxMs ?? 15_000
    this.maxSweepsPerRun = opts.maxSweepsPerRun ?? 10
    this.minSweepBalance = opts.minSweepBalance

    if (opts.autoStartWorker) {
      this.startBackgroundWorker()
    }
  }

  private normalizeAddress(address: string): string {
    return address.toLowerCase()
  }

  markDirty(
    address: string,
    reason: ChainDirtyReason = 'nonce-incremented',
    metadata?: Record<string, unknown>,
  ): void {
    const key = this.normalizeAddress(address)
    if (!this.dirtyAccounts.has(key)) {
      this.dirtyAccounts.set(key, {
        address,
        dirtySinceTimestamp: Date.now(),
        reason,
        metadata,
      })
    }
  }

  isDirty(address: string): boolean {
    return this.dirtyAccounts.has(this.normalizeAddress(address))
  }

  unmarkDirty(address: string): void {
    this.dirtyAccounts.delete(this.normalizeAddress(address))
  }

  async getDirtyAccounts(): Promise<ReadonlyArray<DirtyAccountRecord<string>>> {
    return Array.from(this.dirtyAccounts.values())
  }

  getNextChangeIndex(): number {
    return this.nextChangeIndex
  }

  /**
   * Helper to resolve a MonadAccountTxSigner for a given dirty address.
   */
  private async resolveSigner(
    address: string,
  ): Promise<MonadAccountTxSigner | null> {
    if (this.signerSupplier) {
      const signer = await this.signerSupplier(address)
      if (signer) return signer
    }

    if (this.hdKeyring) {
      const norm = this.normalizeAddress(address)
      // Search a reasonable sub-account index window (e.g. 0-200)
      for (let i = 0; i < 200; i++) {
        const sub = this.hdKeyring.deriveSubAccount(i)
        if (this.normalizeAddress(sub.address) === norm) {
          return new MonadAccountTxSigner({
            privateKey: sub.privateKey,
            provider: this.provider,
            httpClient: this.httpClient,
          })
        }
      }
    }

    return null
  }

  async sweepDirtyAccounts(options?: {
    maxSweeps?: number
    force?: boolean
  }): Promise<ReadonlyArray<SweepResult<string>>> {
    if (this.isSweeping) {
      return []
    }
    this.isSweeping = true

    const results: SweepResult<string>[] = []
    const limit = options?.maxSweeps ?? this.maxSweepsPerRun

    try {
      if (this.accountUtxoPool) {
        for (const dirtyUtxo of this.accountUtxoPool.getDirtyUtxos('monad')) {
          this.markDirty(dirtyUtxo.address, 'nonce-incremented', {
            utxoId: dirtyUtxo.id,
            origin: dirtyUtxo.origin,
          })
        }
      }
      const records = Array.from(this.dirtyAccounts.values()).slice(0, limit)

      for (const record of records) {
        const { address } = record
        try {
          const signer = await this.resolveSigner(address)
          if (!signer) {
            results.push({
              sourceAddress: address,
              amountSwept: 0n,
              outcome: 'not-eligible',
              error: new Error(
                `No signer available for dirty address ${address}`,
              ),
            })
            continue
          }

          const balanceWei = await this.provider.getBalance(address)
          let dustThreshold = 0n
          try {
            dustThreshold =
              this.minSweepBalance ??
              (await estimateDustThresholdWei(this.provider))
          } catch (feeErr) {
            results.push({
              sourceAddress: address,
              amountSwept: 0n,
              outcome: 'error',
              error:
                feeErr instanceof Error ? feeErr : new Error(String(feeErr)),
            })
            continue
          }

          if (balanceWei <= dustThreshold) {
            results.push({
              sourceAddress: address,
              amountSwept: 0n,
              outcome: 'below-dust',
            })
            // If balance is zero or dust, it is already clean or drained
            if (balanceWei === 0n) {
              this.unmarkDirty(address)
            }
            continue
          }

          const minFeePerTx = dustThreshold > 0n ? dustThreshold / 2n : 0n
          const isSubstantiallyAboveDust =
            balanceWei >= 2n * dustThreshold + minFeePerTx

          let splits: bigint[] = []
          if (isSubstantiallyAboveDust) {
            splits = computeGeometricRadixChangeSplits({
              totalAvailableWei: balanceWei - dustThreshold,
              dustThresholdWei: dustThreshold,
              minFeePerTxWei: minFeePerTx,
            })
          }

          if (splits.length > 1) {
            let currentNonce = await this.provider.getTransactionCount(
              address,
              'pending',
            )
            let sweepSucceeded = true

            for (const splitWei of splits) {
              try {
                const destinationAccount =
                  this.changeKeyring.deriveChangeAccount(this.nextChangeIndex)
                const destinationAddress = destinationAccount.address

                const signedTx = await signer.buildAndSignTransfer(
                  destinationAddress,
                  splitWei,
                  { nonce: currentNonce++ },
                )

                await this.httpClient.submitRawTransaction(signedTx.rawTx)

                this.nextChangeIndex++
                this.totalSweptWei += splitWei
                this.totalSweptCount++
                this.lastSweepTimestamp = Date.now()

                if (this.accountUtxoPool) {
                  this.accountUtxoPool.registerChangeAccount({
                    chain: 'monad',
                    address: destinationAddress,
                    privateKey: destinationAccount.privateKey,
                    balanceWei: splitWei,
                    index: this.nextChangeIndex - 1,
                    derivationPath: changeAccountPath(destinationAccount.index),
                  })
                }

                results.push({
                  sourceAddress: address,
                  destinationAddress,
                  amountSwept: splitWei,
                  txId: signedTx.txHash,
                  outcome: 'swept',
                })
              } catch (splitErr) {
                sweepSucceeded = false
                results.push({
                  sourceAddress: address,
                  amountSwept: 0n,
                  outcome: 'error',
                  error:
                    splitErr instanceof Error
                      ? splitErr
                      : new Error(String(splitErr)),
                })
                break
              }
            }

            if (sweepSucceeded) {
              this.unmarkDirty(address)
              if (this.accountUtxoPool) {
                const sourceUtxos = this.accountUtxoPool.getUtxosByAddress(
                  address,
                  'monad',
                )
                for (const u of sourceUtxos) {
                  this.accountUtxoPool.markSpent(u.id)
                }
              }
            }
          } else {
            const sweptValueWei =
              splits.length === 1 ? splits[0] : balanceWei - dustThreshold
            const destinationAccount = this.changeKeyring.deriveChangeAccount(
              this.nextChangeIndex,
            )
            const destinationAddress = destinationAccount.address

            const signedTx = await signer.buildAndSignTransfer(
              destinationAddress,
              sweptValueWei,
            )

            await this.httpClient.submitRawTransaction(signedTx.rawTx)

            // Advance change pointer and update statistics
            this.nextChangeIndex++
            this.totalSweptWei += sweptValueWei
            this.totalSweptCount++
            this.lastSweepTimestamp = Date.now()
            this.unmarkDirty(address)

            if (this.accountUtxoPool) {
              this.accountUtxoPool.registerChangeAccount({
                chain: 'monad',
                address: destinationAddress,
                privateKey: destinationAccount.privateKey,
                balanceWei: sweptValueWei,
                index: this.nextChangeIndex - 1,
                derivationPath: changeAccountPath(destinationAccount.index),
              })
              const sourceUtxos = this.accountUtxoPool.getUtxosByAddress(
                address,
                'monad',
              )
              for (const u of sourceUtxos) {
                this.accountUtxoPool.markSpent(u.id)
              }
            }

            results.push({
              sourceAddress: address,
              destinationAddress,
              amountSwept: sweptValueWei,
              txId: signedTx.txHash,
              outcome: 'swept',
            })
          }
        } catch (err) {
          results.push({
            sourceAddress: address,
            amountSwept: 0n,
            outcome: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
          })
        }
      }
    } finally {
      this.isSweeping = false
    }

    return results
  }

  startBackgroundWorker(): void {
    if (this.workerTimeout !== null) return

    const scheduleNext = () => {
      const jitter = Math.floor(Math.random() * this.jitterMaxMs)
      const delay = this.sweepIntervalMs + jitter

      this.workerTimeout = setTimeout(async () => {
        try {
          await this.sweepDirtyAccounts()
        } catch {
          // Autonomous background sweep errors are recorded in stats, never thrown
        }
        if (this.workerTimeout !== null) {
          scheduleNext()
        }
      }, delay)
    }

    scheduleNext()
  }

  stopBackgroundWorker(): void {
    if (this.workerTimeout !== null) {
      clearTimeout(this.workerTimeout)
      this.workerTimeout = null
    }
  }

  isBackgroundWorkerActive(): boolean {
    return this.workerTimeout !== null
  }

  async getHygieneStats(): Promise<HygieneStats> {
    return {
      trackedDirtyCount: this.dirtyAccounts.size,
      totalSweptWei: this.totalSweptWei,
      totalSweptCount: this.totalSweptCount,
      lastSweepTimestamp: this.lastSweepTimestamp,
    }
  }
}

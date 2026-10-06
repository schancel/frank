/**
 * Solana account hygiene engine (Ticket #925).
 *
 * Implements `AccountHygieneEngine` for Solana accounts:
 * - Detects / tracks dirty ephemeral keypairs or used signers.
 * - Lazily sweeps residual lamports above transaction/rent fees to fresh derived change accounts.
 * - Entirely encapsulated beneath the Solana wallet backend.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  AccountHygieneEngine,
  AccountHygieneOptions,
  ChainDirtyReason,
  DirtyAccountRecord,
  HygieneStats,
  SweepResult,
} from './account-hygiene'
import { SolanaWalletConnection } from './solana-wallet'
import {
  Ed25519HdKeyring,
  SolanaHdKeyring,
  SolanaChangeKeyring,
} from './ed25519-hd-keyring'

export interface SolanaAccountHygieneParams {
  readonly connection: SolanaWalletConnection
  readonly signerSupplier?: (
    address: string,
  ) => Promise<Keypair | null> | (Keypair | null)
  readonly changeDestinationSupplier?: (
    index: number,
  ) => Promise<PublicKey> | PublicKey
  readonly hdKeyring?: SolanaHdKeyring | Ed25519HdKeyring
  readonly changeKeyring?: SolanaChangeKeyring | Ed25519HdKeyring
  readonly options?: AccountHygieneOptions
  readonly initialChangeIndex?: number
}

const DEFAULT_SOLANA_FEE_LAMPORTS = 5_000n

export class SolanaAccountHygieneEngine
  implements AccountHygieneEngine<string>
{
  readonly hdKeyring?: SolanaHdKeyring | Ed25519HdKeyring
  readonly changeKeyring?: SolanaChangeKeyring | Ed25519HdKeyring

  private readonly connection: SolanaWalletConnection
  private readonly signerSupplier: (
    address: string,
  ) => Promise<Keypair | null> | (Keypair | null)
  private readonly changeDestinationSupplier: (
    index: number,
  ) => Promise<PublicKey> | PublicKey
  private readonly knownSigners = new Map<string, Keypair>()

  private readonly dirtyAccounts = new Map<string, DirtyAccountRecord<string>>()
  private readonly sweepIntervalMs: number
  private readonly jitterMaxMs: number
  private readonly maxSweepsPerRun: number
  private readonly minSweepBalance: bigint

  private nextChangeIndex: number
  private workerTimeout: NodeJS.Timeout | null = null
  private isSweeping = false

  private totalSweptLamports = 0n
  private totalSweptCount = 0
  private lastSweepTimestamp?: number

  constructor(params: SolanaAccountHygieneParams) {
    this.connection = params.connection
    this.hdKeyring = params.hdKeyring
    this.changeKeyring = params.changeKeyring
    this.nextChangeIndex = params.initialChangeIndex ?? 0

    if (params.changeDestinationSupplier) {
      this.changeDestinationSupplier = params.changeDestinationSupplier
    } else if (params.changeKeyring) {
      const ck = params.changeKeyring
      this.changeDestinationSupplier = async (index: number) => {
        const derived = await ck.deriveChangeAccount(index)
        this.knownSigners.set(derived.address, derived.keypair)
        return derived.publicKey
      }
    } else {
      throw new Error(
        'SolanaAccountHygieneEngine requires either changeDestinationSupplier or changeKeyring',
      )
    }

    const explicitSupplier = params.signerSupplier
    this.signerSupplier = async (address: string) => {
      const cached = this.knownSigners.get(address)
      if (cached) return cached

      if (explicitSupplier) {
        const supplied = await explicitSupplier(address)
        if (supplied) {
          this.knownSigners.set(address, supplied)
          return supplied
        }
      }

      if (this.changeKeyring) {
        for (let i = 0; i <= this.nextChangeIndex + 10; i++) {
          const acc = await this.changeKeyring.deriveChangeAccount(i)
          this.knownSigners.set(acc.address, acc.keypair)
          if (acc.address === address) return acc.keypair
        }
      }

      if (this.hdKeyring) {
        for (let i = 0; i <= 10; i++) {
          const acc = await this.hdKeyring.deriveSubAccount(i)
          this.knownSigners.set(acc.address, acc.keypair)
          if (acc.address === address) return acc.keypair
        }
      }

      return null
    }

    const opts = params.options ?? {}
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 45_000
    this.jitterMaxMs = opts.jitterMaxMs ?? 15_000
    this.maxSweepsPerRun = opts.maxSweepsPerRun ?? 10
    this.minSweepBalance = opts.minSweepBalance ?? DEFAULT_SOLANA_FEE_LAMPORTS

    if (opts.autoStartWorker) {
      this.startBackgroundWorker()
    }
  }

  markDirty(
    address: string,
    reason: ChainDirtyReason = 'transaction-signed',
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.dirtyAccounts.has(address)) {
      this.dirtyAccounts.set(address, {
        address,
        dirtySinceTimestamp: Date.now(),
        reason,
        metadata,
      })
    }
  }

  isDirty(address: string): boolean {
    return this.dirtyAccounts.has(address)
  }

  unmarkDirty(address: string): void {
    this.dirtyAccounts.delete(address)
  }

  async getDirtyAccounts(): Promise<ReadonlyArray<DirtyAccountRecord<string>>> {
    return Array.from(this.dirtyAccounts.values())
  }

  getNextChangeIndex(): number {
    return this.nextChangeIndex
  }

  async sweepDirtyAccounts(options?: {
    maxSweeps?: number
    force?: boolean
  }): Promise<ReadonlyArray<SweepResult<string>>> {
    if (this.isSweeping) return []
    this.isSweeping = true

    const results: SweepResult<string>[] = []
    const limit = options?.maxSweeps ?? this.maxSweepsPerRun

    try {
      const records = Array.from(this.dirtyAccounts.values()).slice(0, limit)

      for (const record of records) {
        const { address } = record
        try {
          const signer = await this.signerSupplier(address)
          if (!signer) {
            results.push({
              sourceAddress: address,
              amountSwept: 0n,
              outcome: 'not-eligible',
              error: new Error(
                `No signer keypair available for Solana address ${address}`,
              ),
            })
            continue
          }

          const pubkey = new PublicKey(address)
          const rawBalance = await this.connection.getBalance(pubkey)
          const balance = BigInt(rawBalance)

          if (balance <= this.minSweepBalance) {
            results.push({
              sourceAddress: address,
              amountSwept: 0n,
              outcome: 'below-dust',
            })
            if (balance === 0n) {
              this.unmarkDirty(address)
            }
            continue
          }

          const sweptLamports = balance - DEFAULT_SOLANA_FEE_LAMPORTS
          const destination = await this.changeDestinationSupplier(
            this.nextChangeIndex,
          )
          const destinationAddress = destination.toBase58()

          const { blockhash } = await this.connection.getLatestBlockhash()
          const message = new TransactionMessage({
            payerKey: signer.publicKey,
            recentBlockhash: blockhash as ConstructorParameters<
              typeof TransactionMessage
            >[0]['recentBlockhash'],
            instructions: [
              SystemProgram.transfer({
                fromPubkey: signer.publicKey,
                toPubkey: destination,
                lamports: sweptLamports,
              }),
            ],
          }).compileToV0Message()
          const transaction = new VersionedTransaction(message)
          await transaction.sign([signer])

          const txId = await this.connection.sendRawTransaction(
            transaction.serialize(),
          )

          this.nextChangeIndex++
          this.totalSweptLamports += sweptLamports
          this.totalSweptCount++
          this.lastSweepTimestamp = Date.now()
          this.unmarkDirty(address)

          results.push({
            sourceAddress: address,
            destinationAddress,
            amountSwept: sweptLamports,
            txId,
            outcome: 'swept',
          })
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
          // Autonomous background sweep errors are absorbed silently
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
      totalSweptWei: this.totalSweptLamports,
      totalSweptCount: this.totalSweptCount,
      lastSweepTimestamp: this.lastSweepTimestamp,
    }
  }
}

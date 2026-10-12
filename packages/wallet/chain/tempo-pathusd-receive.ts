import { getAddress } from 'ethers'
import type { RecordStore } from '../storage/evm-coin-store'
import type { TempoPathUsdJsonRpc } from './tempo-pathusd-rpc'

type TempoNetwork = 'tempo-testnet' | 'tempo-mainnet'
type Transfer = Awaited<ReturnType<TempoPathUsdJsonRpc['receivedTransfers']>>[number]

export interface TempoReceiveItem extends Omit<Transfer, 'amountAtomic'> {
  /** Six-decimal PathUSD base units, decimal-encoded for durable JSON storage. */
  readonly amountAtomic: string
  /** Stable across replay and devices. The inventory applier must deduplicate this ID. */
  readonly id: string
  readonly applied: boolean
}

/** A single durable batch is both the scan cursor advancement and its receivable facts. */
export interface TempoReceiveBatch {
  readonly version: 1
  readonly id: string
  readonly chainIdentifier: TempoNetwork
  readonly recipient: string
  readonly fromBlock: string
  readonly toBlock: string
  readonly endBlockHash: string
  readonly items: readonly TempoReceiveItem[]
}

export interface TempoReceiveRpc {
  finalizedHead(): Promise<{ number: bigint; hash: string }>
  blockHash(number: bigint): Promise<string>
  receivedTransfers(recipient: string, fromBlock: bigint, toBlock: bigint): Promise<Transfer[]>
}

const HASH = /^0x[0-9a-f]{64}$/

function canonical(address: string): string { return getAddress(address).toLowerCase() }
function quantity(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid Tempo receive block number')
  return BigInt(value)
}

function batchId(chain: TempoNetwork, recipient: string, from: bigint): string {
  return `${chain}:${recipient}:${from}`
}

function transferId(chain: TempoNetwork, item: Pick<Transfer, 'transactionHash' | 'logIndex'>): string {
  return `${chain}:${item.transactionHash}:${item.logIndex}`
}

function validate(row: TempoReceiveBatch): TempoReceiveBatch {
  if (row.version !== 1 || !['tempo-testnet', 'tempo-mainnet'].includes(row.chainIdentifier))
    throw new Error('Invalid Tempo receive batch version or chain')
  if (canonical(row.recipient) !== row.recipient) throw new Error('Invalid Tempo receive recipient')
  const from = quantity(row.fromBlock)
  const to = quantity(row.toBlock)
  if (to < from || to - from >= 2_000n || row.id !== batchId(row.chainIdentifier, row.recipient, from) || !HASH.test(row.endBlockHash))
    throw new Error('Invalid Tempo receive batch range')
  const ids = new Set<string>()
  for (const item of row.items) {
    if (
      item.id !== transferId(row.chainIdentifier, item) ||
      ids.has(item.id) ||
      canonical(item.sender) !== item.sender ||
      item.recipient !== row.recipient ||
      !HASH.test(item.transactionHash) ||
      !HASH.test(item.blockHash) ||
      !Number.isSafeInteger(item.blockNumber) ||
      BigInt(item.blockNumber) < from || BigInt(item.blockNumber) > to ||
      !Number.isSafeInteger(item.logIndex) || item.logIndex < 0 ||
      quantity(item.amountAtomic) === 0n || typeof item.applied !== 'boolean'
    ) throw new Error('Invalid Tempo receive transfer')
    ids.add(item.id)
  }
  return structuredClone(row)
}

/**
 * The receive store owns finalized scan batches and delivery acknowledgements. The injected
 * inventory applier owns balance facts and MUST be idempotent by item.id: a crash can happen
 * after it applies a credit but before the acknowledgement is durably written here.
 */
export class TempoPathUsdReceiveScanner {
  private uncertain = false

  constructor(
    readonly chainIdentifier: TempoNetwork,
    private readonly store: RecordStore<TempoReceiveBatch> & { refresh?: () => Promise<void> },
    private readonly rpc: TempoReceiveRpc,
    private readonly withRecipientLock: <T>(recipient: string, operation: () => Promise<T>) => Promise<T>,
  ) {
    for (const row of store.all()) validate(row)
  }

  private rows(recipient: string): TempoReceiveBatch[] {
    if (this.uncertain) throw new Error('Tempo receive write outcome is uncertain')
    return this.store.all()
      .filter(row => row.chainIdentifier === this.chainIdentifier && row.recipient === recipient)
      .map(validate)
      .sort((a, b) => quantity(a.fromBlock) < quantity(b.fromBlock) ? -1 : 1)
  }

  /** The batch store is authoritative; this is a rebuildable, deduplicated inventory view. */
  receivedItems(recipientAddress: string, startBlock: bigint): TempoReceiveItem[] {
    const recipient = canonical(recipientAddress)
    const rows = this.rows(recipient)
    let next = startBlock
    const seen = new Set<string>()
    const items: TempoReceiveItem[] = []
    for (const row of rows) {
      if (quantity(row.fromBlock) !== next) throw new Error('Tempo receive cursor has a gap or changed start block')
      next = quantity(row.toBlock) + 1n
      for (const item of row.items) {
        if (seen.has(item.id)) throw new Error('Duplicate Tempo receive transfer across batches')
        seen.add(item.id)
        items.push(structuredClone(item))
      }
    }
    return items
  }

  private async write(row: TempoReceiveBatch): Promise<void> {
    const valid = validate(row)
    try {
      await this.store.put(valid.id, valid)
    } catch (error) {
      this.uncertain = true
      throw error
    }
  }

  /** Scans at most 2,000 finalized blocks, then delivers all unapplied items. */
  syncOnce(recipientAddress: string, startBlock: bigint, apply: (item: TempoReceiveItem) => Promise<void>): Promise<{
    nextBlock: bigint
    delivered: number
  }> {
    const recipient = canonical(recipientAddress)
    if (startBlock < 0n) return Promise.reject(new RangeError('Invalid Tempo receive start block'))
    return this.withRecipientLock(recipient, async () => {
      await this.store.refresh?.()
      const rows = this.rows(recipient)
      let next = startBlock
      const seen = new Set<string>()
      for (const row of rows) {
        if (quantity(row.fromBlock) !== next) throw new Error('Tempo receive cursor has a gap or changed start block')
        next = quantity(row.toBlock) + 1n
        for (const item of row.items) {
          if (seen.has(item.id)) throw new Error('Duplicate Tempo receive transfer across batches')
          seen.add(item.id)
        }
      }
      const finalized = await this.rpc.finalizedHead()
      if (!HASH.test(finalized.hash)) throw new Error('Invalid Tempo finalized head')
      const hashes = new Map<bigint, string>()
      const blockHash = async (height: bigint): Promise<string> => {
        if (!hashes.has(height)) hashes.set(height, await this.rpc.blockHash(height))
        return hashes.get(height)!
      }
      for (const row of rows) {
        if (quantity(row.toBlock) > finalized.number || await blockHash(quantity(row.toBlock)) !== row.endBlockHash)
          throw new Error('Finalized Tempo receive batch was reorganized')
        for (const item of row.items) {
          if (await blockHash(BigInt(item.blockNumber)) !== item.blockHash)
            throw new Error('Finalized Tempo receive transfer was reorganized')
        }
      }
      let delivered = 0
      const deliver = async (row: TempoReceiveBatch): Promise<void> => {
        let current = row
        for (let index = 0; index < current.items.length; index++) {
          const item = current.items[index]!
          if (item.applied) continue
          await apply(item)
          current = {
            ...current,
            items: current.items.map((entry, position) => position === index ? { ...entry, applied: true } : entry),
          }
          await this.write(current)
          delivered++
        }
      }
      for (const row of rows) await deliver(row)
      if (next > finalized.number) return { nextBlock: next, delivered }
      const end = next + 1_999n < finalized.number ? next + 1_999n : finalized.number
      const transfers = await this.rpc.receivedTransfers(recipient, next, end)
      const items: TempoReceiveItem[] = []
      for (const transfer of transfers) {
        if (transfer.recipient !== recipient || BigInt(transfer.blockNumber) < next || BigInt(transfer.blockNumber) > end ||
          await blockHash(BigInt(transfer.blockNumber)) !== transfer.blockHash)
          throw new Error('Tempo receive RPC returned a noncanonical transfer')
        items.push({ ...transfer, amountAtomic: transfer.amountAtomic.toString(), id: transferId(this.chainIdentifier, transfer), applied: false })
      }
      const row: TempoReceiveBatch = {
        version: 1,
        id: batchId(this.chainIdentifier, recipient, next),
        chainIdentifier: this.chainIdentifier,
        recipient,
        fromBlock: next.toString(),
        toBlock: end.toString(),
        endBlockHash: await blockHash(end),
        items,
      }
      await this.write(row)
      await deliver(row)
      return { nextBlock: end + 1n, delivered }
    })
  }
}

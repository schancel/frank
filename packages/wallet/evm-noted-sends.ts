/**
 * What this account sent, as its notes to itself report it: the wallet's record of its own
 * outgoing transactions that every device of the account has.
 *
 * Every device writes a note to itself for each transaction it sends (a sealed message's note
 * carries the message and every signed transaction of its bundle; a native transfer's note is
 * written once the transfer is in a block). Every device reads the account's mailbox, so every
 * device, and a device restored from the seed that replays the mailbox, reads the same notes.
 * The native operation journal stays this device's recovery authority for what it signed itself;
 * this record is a derived view for History only. It holds nothing secret, never signs, and can
 * be rebuilt by reading the mailbox from the start.
 *
 * A row is keyed by transaction hash. Recording the same transaction again changes nothing but
 * an earlier note time. What the chain did with it is read with the transaction's receipt and
 * kept once the chain shows it in a block.
 */
import { Transaction, type Provider } from 'ethers'
import type { RecordStore } from './storage/evm-coin-store'

export const EVM_NOTED_SENDS_NAMESPACE = 'evm-noted-sends'

/** What a sent transaction was for, as far as the note shows it.
 * - `stamp`: a message's stamp (a transaction of a sealed message's bundle that pays no item);
 * - `contact-payment`: a payment item of a message (a stealth payment to a contact);
 * - `forum`: a burn to the network's forum/stamp burn address;
 * - `transfer`: anything else (Send to Address, a contract call's value). */
export type NotedSendPurpose = 'stamp' | 'contact-payment' | 'forum' | 'transfer'

export interface NotedSend {
  /** Lower-case 0x transaction hash. The key. */
  readonly txHash: string
  /** Lower-case 0x sending account. */
  readonly from: string
  readonly nonce: number
  /** Lower-case 0x destination; absent for a contract creation. */
  readonly to?: string
  /** Value the transaction carries, wei as a decimal string. */
  readonly valueWei: string
  /** True when the transaction carries call data (a contract call). */
  readonly call: boolean
  readonly purpose: NotedSendPurpose
  /** The note that reported it (its payload digest); transactions of one message share it. */
  readonly noteDigest?: string
  /** Its place among the note's transactions (the order the sending device built them in). */
  readonly noteIndex: number
  /** When the note says it was sent (or when it was read), epoch ms. */
  readonly notedAtMs: number
  /** What the chain showed, once it showed the transaction in a block. */
  readonly inclusion?: {
    readonly status: 'success' | 'revert'
    readonly blockNumber: number
    readonly blockHash: string
    /** Time of that block, epoch ms, when it was read. */
    readonly blockTimeMs?: number
    readonly feeWei: string
  }
}

/** What History shows of one noted transaction now. */
export interface NotedSendStatus extends NotedSend {
  /** `included` / `reverted` from the receipt; `pending` while the node shows none yet;
   * `unknown` while the chain could not be read. */
  readonly state: 'included' | 'reverted' | 'pending' | 'unknown'
}

/** The most receipts one read asks the node for. */
const RECEIPT_READS_PER_PASS = 32

export class EvmNotedSends {
  /** Read failures of this session, by hash: shown as `unknown`, never stored. */
  private readonly unreadable = new Set<string>()

  constructor(
    private readonly store: RecordStore<NotedSend>,
    private readonly config: {
      readonly chainId: bigint
      /** The network's forum/stamp burn address. */
      readonly burnAddress?: string
    },
  ) {}

  /**
   * Records the signed transactions one note to self reports. Only transactions signed for this
   * chain whose bytes decode are taken; anything else is passed (the note's spend application
   * decides about it on its own). Returns the hashes recorded or already known.
   */
  async recordNote(note: {
    readonly transactions: readonly { rawTx: string; txHash?: string }[]
    /** Hashes of the transactions the note's message pays as items (stealth payments). */
    readonly itemTransactions: ReadonlySet<string>
    /** Whether the note carries a sent message (then its other transactions are its stamp). */
    readonly carriesMessage: boolean
    readonly noteDigest?: string
    readonly notedAtMs: number
  }): Promise<string[]> {
    const recorded: string[] = []
    const burn = this.config.burnAddress?.toLowerCase()
    for (const [noteIndex, { rawTx, txHash }] of note.transactions.entries()) {
      let tx: Transaction
      try {
        tx = Transaction.from(rawTx)
      } catch {
        continue
      }
      if (
        tx.hash === null ||
        tx.from === null ||
        tx.chainId !== this.config.chainId ||
        (txHash !== undefined && txHash.toLowerCase() !== tx.hash.toLowerCase())
      )
        continue
      const hash = tx.hash.toLowerCase()
      const to = tx.to?.toLowerCase()
      const purpose: NotedSendPurpose =
        to !== undefined && to === burn
          ? 'forum'
          : note.itemTransactions.has(hash)
          ? 'contact-payment'
          : note.carriesMessage
          ? 'stamp'
          : 'transfer'
      const existing = this.store.get(hash)
      if (existing !== undefined) {
        recorded.push(hash)
        // A message's own note says more than a bare transfer note about the same bytes.
        const better =
          existing.purpose === 'transfer' && purpose !== 'transfer'
            ? purpose
            : existing.purpose
        if (note.notedAtMs >= existing.notedAtMs && better === existing.purpose)
          continue
        await this.store.put(hash, {
          ...existing,
          purpose: better,
          notedAtMs: Math.min(existing.notedAtMs, note.notedAtMs),
          ...(existing.noteDigest === undefined && note.noteDigest !== undefined
            ? { noteDigest: note.noteDigest, noteIndex }
            : {}),
        })
        continue
      }
      await this.store.put(hash, {
        txHash: hash,
        from: tx.from.toLowerCase(),
        nonce: tx.nonce,
        ...(to === undefined ? {} : { to }),
        valueWei: tx.value.toString(),
        call: tx.data !== '0x',
        purpose,
        ...(note.noteDigest === undefined ? {} : { noteDigest: note.noteDigest }),
        noteIndex,
        notedAtMs: note.notedAtMs,
      })
      recorded.push(hash)
    }
    return recorded
  }

  all(): NotedSend[] {
    return this.store.all()
  }

  /**
   * Every noted transaction with what the chain shows of it. Transactions not yet seen in a
   * block are asked about (at most `RECEIPT_READS_PER_PASS` per call, newest first); what the
   * chain showed in a block is kept. Read only on the chain: nothing is signed or sent.
   */
  async read(provider: Pick<Provider, 'getTransactionReceipt' | 'getBlock'>): Promise<NotedSendStatus[]> {
    const open = this.store
      .all()
      .filter(row => row.inclusion?.blockTimeMs === undefined)
      .sort((a, b) => b.notedAtMs - a.notedAtMs)
      .slice(0, RECEIPT_READS_PER_PASS)
    const blockTimes = new Map<number, Promise<number | undefined>>()
    const blockTime = (number: number, hash: string) => {
      let time = blockTimes.get(number)
      if (time === undefined) {
        // By number: the relay's RPC gateway serves blocks by number, not by hash. The hash is
        // checked, so a reorganised block is never taken for the transaction's block.
        time = provider
          .getBlock(number)
          .then(block =>
            block?.hash?.toLowerCase() === hash.toLowerCase()
              ? block.timestamp * 1000
              : undefined,
          )
          .catch(() => undefined)
        blockTimes.set(number, time)
      }
      return time
    }
    await Promise.all(
      open.map(async row => {
        try {
          if (row.inclusion !== undefined) {
            const blockTimeMs = await blockTime(
              row.inclusion.blockNumber,
              row.inclusion.blockHash,
            )
            if (blockTimeMs !== undefined)
              await this.store.put(row.txHash, {
                ...row,
                inclusion: { ...row.inclusion, blockTimeMs },
              })
            return
          }
          const receipt = await provider.getTransactionReceipt(row.txHash)
          this.unreadable.delete(row.txHash)
          if (receipt === null || !receipt.blockHash) return
          const blockTimeMs = await blockTime(
            receipt.blockNumber,
            receipt.blockHash,
          )
          const price = receipt.gasPrice ?? 0n
          await this.store.put(row.txHash, {
            ...row,
            inclusion: {
              status: receipt.status === 1 ? 'success' : 'revert',
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash.toLowerCase(),
              ...(blockTimeMs === undefined ? {} : { blockTimeMs }),
              feeWei: (receipt.gasUsed * price).toString(),
            },
          })
        } catch {
          this.unreadable.add(row.txHash)
        }
      }),
    )
    return this.store.all().map(row => ({
      ...row,
      state:
        row.inclusion !== undefined
          ? row.inclusion.status === 'success'
            ? 'included'
            : 'reverted'
          : this.unreadable.has(row.txHash)
          ? 'unknown'
          : 'pending',
    }))
  }
}

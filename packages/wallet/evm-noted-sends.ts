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
 * A row is keyed by transaction hash. Each note adds what it says of the transaction: the
 * operation its own journal member named (`WalletSyncItem.operation`), the message whose note
 * carries it, an earlier note time. History groups and names the account's sends from those
 * facts (`notedSendGroupKeys`, `notedSendPurpose`), as the sending device groups and names its
 * journal's operations (`classifyEvmOperation`). What the chain did with it is read with the
 * transaction's receipt and kept once the chain shows it in a block.
 */
import { Transaction, type Provider } from 'ethers'
import type { RecordStore } from './storage/evm-coin-store'
import {
  classifyEvmOperation,
  type EvmSendPurpose,
} from './chain/evm-native-operation-status'

export const EVM_NOTED_SENDS_NAMESPACE = 'evm-noted-sends'

/** What a sent transaction was for (`EvmSendPurpose`), named from what its notes say of it. */
export type NotedSendPurpose = EvmSendPurpose

/** The calldata a group write's payment starts with: "GRPW" and version 1
 * (`@frank/cashweb/groups/group-write-payment`). */
const GROUP_WRITE_CALLDATA = '0x4752505701'

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
  /** What the transaction's own bytes show it was for: a group write's payment (its calldata),
   * or a burn to the network's forum address. */
  readonly shown?: 'group-write' | 'forum'
  /** The sending wallet's operation, as the transaction's own note names it. */
  readonly operation?: { readonly id: string; readonly stage?: string }
  /** The sent message whose note carries the transaction: its payload digest, its message ID
   * (32 hex digits) and whether the message pays it as an item (a payment) or as its stamp. */
  readonly message?: {
    readonly digest: string
    readonly messageId?: string
    readonly item: boolean
  }
  /** What it was for, from the facts above (`notedSendPurpose`). */
  readonly purpose: NotedSendPurpose
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

/** What a noted transaction was for: what its operation's identity says, else its own bytes,
 * else its message. The sending device names its journal's operations the same way. */
export function notedSendPurpose(
  row: Pick<NotedSend, 'operation' | 'message' | 'shown'>,
): NotedSendPurpose {
  const named = row.operation
    ? classifyEvmOperation(row.operation.id, row.operation.stage).purpose
    : 'transfer'
  if (named !== 'transfer') return named
  if (row.shown) return row.shown
  if (row.message) return row.message.item ? 'contact-payment' : 'stamp'
  return 'transfer'
}

/**
 * The names of the one user action a noted transaction belongs to; transactions sharing any
 * name are one action, one row of History. An action is the sending wallet's operation, with
 * every stage appended to it (a message's stamp paid in the same transaction set as the
 * message's payment), and the message it was for: a message's payment and its stamp are one
 * action, whatever operations paid them. The sending device groups its journal the same way.
 * A transaction no note relates to anything else is an action of its own.
 */
export function notedSendGroupKeys(
  row: Pick<NotedSend, 'txHash' | 'operation' | 'message'>,
): string[] {
  const keys: string[] = []
  if (row.operation) {
    keys.push(`operation:${row.operation.id}`)
    const named = classifyEvmOperation(row.operation.id, row.operation.stage)
    if (named.messageId !== undefined) keys.push(`message:${named.messageId}`)
  }
  if (row.message)
    keys.push(
      row.message.messageId !== undefined
        ? `message:${row.message.messageId}`
        : `digest:${row.message.digest}`,
    )
  if (keys.length === 0) keys.push(`tx:${row.txHash}`)
  return keys
}

/** What History shows of one noted transaction now. */
export interface NotedSendStatus extends NotedSend {
  /** `included` / `reverted` from the receipt; `pending` while the node shows none yet;
   * `unknown` while the chain could not be read. */
  readonly state: 'included' | 'reverted' | 'pending' | 'unknown'
  /** Its destination is one of the wallet's own accounts (change, funding, its own receive
   * address): not a send, but a part of one whose fee the account paid. Set by the wallet. */
  readonly toOwnAccount?: boolean
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
   * decides about it on its own). What one note says of a transaction is added to what others
   * said, in whatever order the notes are read, so every device ends with the same record.
   * Returns the hashes recorded or already known.
   */
  async recordNote(note: {
    readonly transactions: readonly {
      rawTx: string
      txHash?: string
      /** The sending wallet's operation, as the transaction's own note names it. */
      operation?: { id: string; stage?: string }
    }[]
    /** Hashes of the transactions the note's message pays as items (stealth payments). */
    readonly itemTransactions: ReadonlySet<string>
    /** The sent message the note carries, if it carries one (then its other transactions are
     * its stamp): its payload digest and message ID. */
    readonly message?: { readonly digest: string; readonly messageId?: string }
    readonly notedAtMs: number
  }): Promise<string[]> {
    const recorded: string[] = []
    const burn = this.config.burnAddress?.toLowerCase()
    for (const [noteIndex, { rawTx, txHash, operation }] of note.transactions.entries()) {
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
      const shown = tx.data.toLowerCase().startsWith(GROUP_WRITE_CALLDATA)
        ? ('group-write' as const)
        : to !== undefined && to === burn
        ? ('forum' as const)
        : undefined
      const message =
        note.message === undefined
          ? undefined
          : {
              digest: note.message.digest,
              ...(note.message.messageId === undefined
                ? {}
                : { messageId: note.message.messageId }),
              item: note.itemTransactions.has(hash),
            }
      const existing = this.store.get(hash)
      recorded.push(hash)
      const facts = {
        ...(shown === undefined ? {} : { shown }),
        ...(existing?.operation ?? operation
          ? { operation: existing?.operation ?? operation }
          : {}),
        ...(existing?.message ?? message
          ? { message: existing?.message ?? message }
          : {}),
      }
      const next: NotedSend = {
        ...(existing ?? {
          txHash: hash,
          from: tx.from.toLowerCase(),
          nonce: tx.nonce,
          ...(to === undefined ? {} : { to }),
          valueWei: tx.value.toString(),
          call: tx.data !== '0x',
          noteIndex,
        }),
        ...facts,
        purpose: notedSendPurpose(facts),
        notedAtMs: Math.min(existing?.notedAtMs ?? Infinity, note.notedAtMs),
      }
      const said = (row: NotedSend) =>
        JSON.stringify([
          row.shown,
          row.operation?.id,
          row.operation?.stage,
          row.message?.digest,
          row.message?.messageId,
          row.message?.item,
          row.purpose,
          row.notedAtMs,
        ])
      if (existing !== undefined && said(existing) === said(next)) continue
      await this.store.put(hash, next)
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

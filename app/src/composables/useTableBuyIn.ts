/**
 * One table's buy-in, as a poker or liar's dice card shows it: this account's lock at the table
 * (read from the chain), joining (lock, wait, then the structured join), and the refund after
 * the deadline. The decisions are the headless escrow's (`@frank/wallet/table-escrow`, bound by
 * `src/games/table-buy-in-session`); this only keeps what the card shows honest:
 *
 * - a lock that was sent and is not in a block yet is `pending`, never "joined";
 * - a lock that landed while its join message failed is `join-failed`: still locked, still the
 *   player's to refund after the deadline, and joining again reuses it (nothing locked twice);
 * - the refund is offered only for an open lock of this account, from its deadline on, whether
 *   or not the bot ever seated the player.
 */
import { computed, reactive, readonly } from 'vue'
import type {
  TableBuyInLockItem,
  TableEscrowItemTerms,
} from '@frank/cashweb/types/messages'
import {
  TableEscrowError,
  type TableEscrowProgress,
  type TableEscrowTerms,
} from '@frank/wallet/table-escrow'
import {
  openTableBuyInSession,
  type TableBuyInSession,
  type TableGame,
} from 'src/games/table-buy-in-session'
import { useTableLockStore } from 'src/stores/table-locks'

export type TableBuyInPhase =
  /** Nothing in progress. */
  | 'idle'
  /** A join or a refund is running; `progress` says where. */
  | 'working'
  /** The lock (or the move funding it) was sent and is not in a block yet. */
  | 'pending'
  /** The lock is on chain and the join message was not sent. */
  | 'join-failed'
  /** The join message was sent; the bot's reply says whether it seated the player. */
  | 'join-sent'
  /** The last action failed; `error` says why. */
  | 'failed'

export interface TableBuyInLockView {
  lockId: string
  state: 'open' | 'withdrawn' | 'refunded'
  /** Seconds. */
  expiresAt: number
}

export interface TableBuyInState {
  phase: TableBuyInPhase
  progress?: TableEscrowProgress
  /** This account's lock at the table, as the chain last showed it; null when there is none;
   * undefined until read. */
  lock: TableBuyInLockView | null | undefined
  /** The newest block's time when last read, seconds. */
  headTime?: number
  /** A failure code the card words (`TableEscrowError` reasons, or `unavailable`). */
  error?: string
  /** The transaction a pending or failed step names. */
  txHash?: string
}

export function termsOfItem(
  escrow: TableEscrowItemTerms,
  buyInWei: string,
): TableEscrowTerms {
  return {
    arbiter: escrow.arbiter,
    hashLock: escrow.hashLock,
    buyInWei: BigInt(buyInWei),
    expiresAt: BigInt(escrow.expiresAt),
  }
}

export function useTableBuyIn(table: {
  game: () => TableGame
  tableId: () => string
  buyInWei: () => string | undefined
  escrow: () => TableEscrowItemTerms | undefined
  /** Opens the wallet binding; tests pass their own. */
  open?: () => Promise<TableBuyInSession>
}) {
  const state = reactive<TableBuyInState>({ phase: 'idle', lock: undefined })
  let session: Promise<TableBuyInSession> | undefined
  const sessionOf = async () => {
    if (session) {
      const current = await session.catch(() => undefined)
      if (current?.isCurrent()) return current
    }
    session = (table.open ?? (() => openTableBuyInSession()))()
    return session
  }
  const terms = () => {
    const escrow = table.escrow()
    const buyIn = table.buyInWei()
    return escrow && buyIn ? termsOfItem(escrow, buyIn) : undefined
  }

  /** Reads this account's lock at the table from the chain: the id its terms give, and any the
   * account's notes to itself name for the table. Only a lock refunding to this account counts. */
  async function refresh(): Promise<void> {
    const t = terms()
    if (!t) return
    try {
      const s = await sessionOf()
      const ids = new Set([s.lockIdFor(t)])
      for (const record of useTableLockStore().locksAt(
        s.chainIdentifier,
        table.game(),
        table.tableId(),
      ))
        ids.add(record.lockId)
      let found: TableBuyInLockView | null = null
      for (const lockId of ids) {
        const lock = await s.readLock(lockId)
        if (
          !lock ||
          lock.refundAddress.toLowerCase() !== s.account.toLowerCase()
        )
          continue
        found = {
          lockId: lock.lockId.toLowerCase(),
          state: lock.state,
          expiresAt: Number(lock.expiresAt),
        }
        // An open lock is the one that matters; a closed one is shown only if no other is open.
        if (lock.state === 'open') break
      }
      state.lock = found
      state.headTime = (await s.headTime()) ?? state.headTime
    } catch {
      // Not readable now (no wallet yet, node down): what was shown stays; the actions say why.
    }
  }

  function failed(error: unknown) {
    if (error instanceof TableEscrowError) {
      state.phase =
        error.reason === 'lock-pending' || error.reason === 'refund-pending'
          ? 'pending'
          : 'failed'
      state.error = error.reason
      state.txHash = error.txHash
    } else {
      state.phase = 'failed'
      state.error =
        (error as { name?: string })?.name === 'TableBuyInUnavailableError'
          ? 'unavailable'
          : 'other'
      state.txHash = undefined
    }
  }

  /**
   * Locks the buy-in (or reuses or continues this account's lock) and then sends the join via
   * `sendJoin`, which resolves whether the message was sent.
   */
  async function join(
    sendJoin: (lock: TableBuyInLockItem) => Promise<boolean>,
  ): Promise<void> {
    const t = terms()
    if (!t || state.phase === 'working') return
    state.phase = 'working'
    state.error = undefined
    state.txHash = undefined
    let lock: TableBuyInLockItem & { txHash?: string }
    try {
      const s = await sessionOf()
      lock = await s.join({
        game: table.game(),
        tableId: table.tableId(),
        table: t,
        onProgress: progress => {
          state.progress = progress
          if ('txHash' in progress && progress.txHash)
            state.txHash = progress.txHash
        },
      })
    } catch (error) {
      failed(error)
      await refresh()
      return
    }
    await refresh()
    let sent = false
    try {
      sent = await sendJoin({
        lockId: lock.lockId,
        account: lock.account,
        signature: lock.signature,
      })
    } catch {
      sent = false
    }
    state.phase = sent ? 'join-sent' : 'join-failed'
    state.progress = undefined
  }

  async function refund(): Promise<void> {
    const lock = state.lock
    if (!lock || state.phase === 'working') return
    state.phase = 'working'
    state.error = undefined
    state.txHash = undefined
    try {
      const s = await sessionOf()
      const done = await s.refund({
        game: table.game(),
        tableId: table.tableId(),
        lockId: lock.lockId,
        onProgress: progress => {
          state.progress = progress
          if ('txHash' in progress && progress.txHash)
            state.txHash = progress.txHash
        },
      })
      state.txHash = done.txHash
      state.phase = 'idle'
    } catch (error) {
      failed(error)
    }
    state.progress = undefined
    await refresh()
  }

  /** The lock is open and its deadline has passed by the chain's newest block (or, before a
   * block was read, by this device's clock). The contract decides; this only offers. */
  const refundable = computed(() => {
    const lock = state.lock
    if (!lock || lock.state !== 'open') return false
    const now = state.headTime ?? Math.floor(Date.now() / 1000)
    return now >= lock.expiresAt
  })

  return { state: readonly(state), refresh, join, refund, refundable }
}

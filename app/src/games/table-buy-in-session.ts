/**
 * Composition for a poker or liar's dice table's buy-in escrow (`@frank/wallet/table-escrow`):
 * binds the account's EVM wallet for the network the table's bot plays on (the conversation's
 * network, which is the account's directory network) to the headless join and refund, and hands
 * the cards nothing else. What is decided (reuse an open lock, continue a handed-out one, fund
 * the main account first, wait for inclusion, refuse a refund before the deadline) is decided
 * there, not in a component.
 *
 * The table item names no network: the bot is the conversation's peer, so its table is on
 * `activeChain`. The join's signature binds that network, so a lock on another network would be
 * refused by the bot anyway.
 */
import type { TableBuyInLockItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'
import { tableJoinSignerOf } from '@frank/wallet/chain/evm-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import { readHtlcLock, type EvmHtlcLock } from '@frank/wallet/swap-escrow'
import {
  joinTableWithBuyIn,
  refundTableBuyInAndWait,
  tableBuyInLockId,
  type TableEscrowProgress,
  type TableEscrowReader,
  type TableEscrowTerms,
  type TableEscrowTiming,
  type TableJoinWallet,
} from '@frank/wallet/table-escrow'
import { openEvmWallet, peekOpenedEvmWallets } from 'src/accounts/evm-wallets'
import { accountSession } from 'src/accounts/session'

export type TableGame = 'poker' | 'liars-dice'

export class TableBuyInUnavailableError extends Error {
  constructor(readonly reason: 'no-wallet' | 'no-contract' | 'no-signer') {
    super(`Table buy-ins unavailable: ${reason}`)
    this.name = 'TableBuyInUnavailableError'
  }
}

export interface TableBuyInSession {
  readonly chainIdentifier: string
  /** This network's GenericHTLC. */
  readonly contract: string
  /** The main account: every buy-in lock's sender and refund address. */
  readonly account: string
  /** The id of this account's lock at a table with these terms: the same on every device. */
  lockIdFor(table: TableEscrowTerms): string
  readLock(lockId: string): Promise<EvmHtlcLock | null>
  /** The newest block's time, seconds; undefined when the node does not say. */
  headTime(): Promise<number | undefined>
  /** Locks (or reuses, or continues) the buy-in and returns what the join item names. */
  join(params: {
    game: TableGame
    tableId: string
    table: TableEscrowTerms
    onProgress?: (progress: TableEscrowProgress) => void
  }): Promise<TableBuyInLockItem & { txHash?: string }>
  refund(params: {
    game: TableGame
    tableId: string
    lockId: string
    onProgress?: (progress: TableEscrowProgress) => void
  }): Promise<{ txHash: string }>
  /** False once the signed-in account has changed: a card must not act for another. */
  isCurrent(): boolean
}

export async function openTableBuyInSession(
  timing?: TableEscrowTiming,
): Promise<TableBuyInSession> {
  await accountSession.getWallet()
  const { account: signedIn, revision } = accountSession.state
  const chainIdentifier = activeChain.chainIdentifier
  const open = await openEvmWallet(chainIdentifier)
  const wallet = open.wallet
  if (wallet.family !== 'evm' || wallet.chainIdentifier !== chainIdentifier)
    throw new TableBuyInUnavailableError('no-wallet')
  const evm = wallet as unknown as EvmChainWalletHandle
  // The wallet's own read-only node access. It is an ethers provider; the escrow asks only for
  // the reads it names (`TableEscrowReader`), and takes no head without a time as past a deadline.
  const reader = evm.evmReader as unknown as TableEscrowReader | undefined
  if (!reader || !wallet.sendContractCall || !wallet.getContractCallFunds)
    throw new TableBuyInUnavailableError('no-wallet')
  if (!activeChain.getHtlcAddress)
    throw new TableBuyInUnavailableError('no-contract')
  let contract: string
  try {
    contract = activeChain.getHtlcAddress()
  } catch {
    throw new TableBuyInUnavailableError('no-contract')
  }
  const signer = tableJoinSignerOf(evm)
  if (!signer) throw new TableBuyInUnavailableError('no-signer')
  const account = signer.account()
  const joiner = wallet.identity.address.raw
  const calls = wallet as unknown as TableJoinWallet
  return {
    chainIdentifier,
    contract,
    account,
    lockIdFor: table => tableBuyInLockId(table, account),
    readLock: lockId => readHtlcLock(reader, contract, lockId),
    headTime: async () => {
      const head = await reader.getBlock('latest')
      return head?.timestamp === undefined ? undefined : Number(head.timestamp)
    },
    join: async params => {
      const locked = await joinTableWithBuyIn({
        wallet: calls,
        reader,
        signer,
        joiner,
        contract,
        game: params.game,
        tableId: params.tableId,
        table: params.table,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
        ...(timing ? { timing } : {}),
      })
      return locked
    },
    refund: params =>
      refundTableBuyInAndWait({
        wallet: calls,
        reader,
        contract,
        game: params.game,
        tableId: params.tableId,
        lockId: params.lockId,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
        ...(timing ? { timing } : {}),
      }),
    isCurrent: () =>
      accountSession.state.status === 'ready' &&
      accountSession.state.account === signedIn &&
      accountSession.state.revision === revision &&
      peekOpenedEvmWallets().includes(open),
  }
}

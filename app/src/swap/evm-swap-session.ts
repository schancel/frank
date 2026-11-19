/**
 * Composition for an EVM swap: binds the account's EVM wallet for one canonical chain to one
 * of that chain's enabled dex entries, and builds the entry's adapter class, handing it the
 * wallet as a narrow interface. The adapter key in configuration is mapped to its class here,
 * explicitly; nothing registers itself.
 *
 * The wallet's contract send takes the swap's record as an argument: the wallet journals it
 * with the call and its note to self carries it. Nothing is recorded here.
 */
import {
  getEvmDexDeployment,
  listEnabledEvmDexEntries,
  listEvmSwapVenues,
  type EvmDexEntry,
} from '@frank/wallet/chain/dex-deployments'
import type { EvmDex, EvmDexWallet } from '@frank/wallet/swap/evm-dex'
import type { SwapExecutionReader } from '@frank/wallet/swap/swap-execution'
import { UniswapV4Dex } from '@frank/wallet/swap/uniswap-v4-dex'
import { HyperSwapV2Dex } from '@frank/wallet/swap/hyperswap-v2'
import type { EvmSwapCallRecord } from '@frank/wallet/storage/evm-native-operation-journal'
import { swapRecordItemOf } from '@frank/wallet/chain/evm-legacy-consolidator'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import { Transaction } from 'ethers'
import { accountSession } from 'src/accounts/session'
import { openEvmWallet, peekOpenedEvmWallets } from 'src/accounts/evm-wallets'

/** Adapter key (a dex entry's `adapter`) to the class that speaks to that exchange. */
function evmDexFor(
  chainIdentifier: string,
  entry: EvmDexEntry,
  wallet: EvmDexWallet,
): EvmDex {
  switch (entry.adapter) {
    case 'uniswap-v4':
      return new UniswapV4Dex(chainIdentifier, entry, wallet)
    case 'hyperswap-v2':
      return new HyperSwapV2Dex(chainIdentifier, entry, wallet)
  }
}

export interface EvmSwapSession {
  readonly chainIdentifier: string
  /** The exchange this session swaps on, behind the EVM dex interface. */
  readonly dex: EvmDex
  /** The main account: it swaps, and the tokens it receives stay on it. */
  readonly account: string
  readonly reader: SwapExecutionReader
  /** Contract calls of this wallet that were signed and are not yet in a block. */
  unresolvedContractCalls(): { operationId: string; txHash: string }[]
  /** Every swap this wallet broadcast, as the records its journal holds. */
  ownSwapRecords(): SwapRecordItem[]
  /** This wallet's swaps that are signed and not yet seen in a block, from its journal. */
  pendingSwaps(): PendingSwap[]
  /** Re-submits a recorded operation's same signed bytes. */
  resumeOperation(operationId: string): Promise<unknown>
  /** What the wallet's other accounts hold. Walks every account: not for a timer. */
  otherAccountsBalance(): Promise<bigint>
  /** False once the signed-in account has changed: an open form must not sign for another. */
  isCurrent(): boolean
}

/** A swap the wallet journaled and broadcast whose outcome it has not seen yet. */
export interface PendingSwap {
  readonly operationId: string
  readonly transactionId: string
  readonly record: EvmSwapCallRecord
  readonly call: { to: string; data: string; value: string }
}

export type EvmSwapUnavailable = 'no-deployment' | 'wrong-network' | 'no-wallet'

export class EvmSwapUnavailableError extends Error {
  constructor(readonly reason: EvmSwapUnavailable) {
    super(`Swap unavailable: ${reason}`)
    this.name = 'EvmSwapUnavailableError'
  }
}

/**
 * The venues a new swap may be quoted on, in order; empty when the chain has none. A venue that
 * cannot carry a configured interface fee is not among them.
 */
export function evmSwapVenues(
  chainIdentifier: string | undefined,
): readonly EvmDexEntry[] {
  return chainIdentifier ? listEvmSwapVenues(chainIdentifier) : []
}

/**
 * Every enabled venue of a chain, whatever fee is configured: what the account's existing swaps
 * were made on and what its token balances are of. Each one as offered (with any fee) when it
 * is offered; otherwise as configured.
 */
export function evmRecordedSwapVenues(
  chainIdentifier: string | undefined,
): readonly EvmDexEntry[] {
  if (!chainIdentifier) return []
  const offered = listEvmSwapVenues(chainIdentifier)
  return listEnabledEvmDexEntries(chainIdentifier).map(
    entry => offered.find(venue => venue.id === entry.id) ?? entry,
  )
}

/** A session to quote and make a new swap on one of the chain's offered venues. */
export function openEvmSwapSession(
  chainIdentifier: string,
  venueId?: string,
): Promise<EvmSwapSession> {
  return openSession(
    chainIdentifier,
    getEvmDexDeployment(chainIdentifier, venueId),
  )
}

/**
 * A session to read, observe or reconcile what the account already did on a venue (and read
 * its token balances), offered for new swaps or not. Never used to quote a new swap.
 */
export function openRecordedEvmSwapSession(
  chainIdentifier: string,
  venueId?: string,
): Promise<EvmSwapSession> {
  const venues = evmRecordedSwapVenues(chainIdentifier)
  return openSession(
    chainIdentifier,
    venueId === undefined
      ? venues[0]
      : venues.find(venue => venue.id === venueId),
  )
}

async function openSession(
  chainIdentifier: string,
  entry: EvmDexEntry | undefined,
): Promise<EvmSwapSession> {
  if (!entry) throw new EvmSwapUnavailableError('no-deployment')
  // Opens the account (if it is not yet) before its state is read.
  await accountSession.getWallet()
  const { account: signedIn, revision } = accountSession.state
  // The account's configured EVM owner for exactly this network: the account's own wallet when
  // that is the network, otherwise the wallet `openEvmWallet` opens for it. Never another one.
  const open = await openEvmWallet(chainIdentifier)
  const { wallet } = open
  if (wallet.family !== 'evm' || wallet.chainIdentifier !== chainIdentifier)
    throw new EvmSwapUnavailableError('wrong-network')
  const reader = wallet.evmReader
  const { sendContractCall, getContractCallFunds } = wallet
  if (!reader || !sendContractCall || !getContractCallFunds)
    throw new EvmSwapUnavailableError('no-wallet')
  const optional = <A extends unknown[], R>(
    method: ((...args: A) => R) | undefined,
  ) => (method ? (...args: A) => method.apply(wallet, args) : undefined)
  const calls: EvmDexWallet = {
    reader,
    // "Send a legacy transaction to a contract", with its record. The wallet journals the record
    // with the call and its own note to self carries it; nothing is recorded here.
    sendContractCall: params => sendContractCall.call(wallet, params),
    getContractCallFunds: () => getContractCallFunds.call(wallet),
    estimateLegacyFee: optional(wallet.estimateLegacyFee),
    fundMainAccount: optional(wallet.fundMainAccount),
    resumeLegacySend: optional(wallet.resumeLegacySend),
    resumeNativeOperation: optional(wallet.resumeNativeOperation),
    getUnresolvedContractCalls: optional(wallet.getUnresolvedContractCalls),
    cancelContractCall: optional(wallet.cancelContractCall),
    reobserveNativeOperations: optional(wallet.reobserveNativeOperations),
  }
  return {
    chainIdentifier,
    dex: evmDexFor(chainIdentifier, entry, calls),
    // The EVM handle's receive address is its main account; execution checks it again against
    // the account the wallet actually signs from.
    account: (await wallet.getReceiveAddress()).raw,
    reader,
    unresolvedContractCalls: () => calls.getUnresolvedContractCalls?.() ?? [],
    ownSwapRecords: () =>
      (wallet.getNativeOperations?.() ?? []).flatMap(row => {
        const item = row.members[0]?.exposed ? swapRecordItemOf(row) : undefined
        return item && !row.cancelled ? [item] : []
      }),
    pendingSwaps: () =>
      (wallet.getNativeOperations?.() ?? []).flatMap(row => {
        const member = row.members[0]
        if (
          row.kind !== 'contract' ||
          row.cancelled ||
          row.record?.kind !== 'swap' ||
          !member?.signed ||
          !member.exposed ||
          'transactionHash' in member.observation ||
          row.record.venueId !== entry.id
        )
          return []
        const tx = Transaction.from(member.unsignedTransaction)
        return [
          {
            operationId: row.operationId,
            transactionId: member.signed.transactionHash,
            record: row.record,
            call: {
              to: tx.to ?? '',
              data: tx.data,
              value: tx.value.toString(),
            },
          },
        ]
      }),
    resumeOperation: async id => calls.resumeNativeOperation?.(id),
    otherAccountsBalance: async () =>
      (await calls.getContractCallFunds()).otherBalance,
    isCurrent: () =>
      accountSession.state.status === 'ready' &&
      accountSession.state.account === signedIn &&
      accountSession.state.revision === revision &&
      // The wallet it was opened with is still this account's open wallet for the chain.
      peekOpenedEvmWallets().includes(open),
  }
}

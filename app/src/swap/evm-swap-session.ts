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
  listEvmSwapVenues,
  type EvmDexEntry,
} from '@frank/wallet/chain/dex-deployments'
import type { EvmDex, EvmDexWallet } from '@frank/wallet/swap/evm-dex'
import type { SwapExecutionReader } from '@frank/wallet/swap/swap-execution'
import { UniswapV4Dex } from '@frank/wallet/swap/uniswap-v4-dex'
import type { EvmContractCallRecord } from '@frank/wallet/storage/evm-native-operation-journal'
import { swapRecordItemOf } from '@frank/wallet/chain/evm-legacy-consolidator'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import { Transaction } from 'ethers'
import { accountSession } from 'src/accounts/session'

/** Adapter key (a dex entry's `adapter`) to the class that speaks to that exchange. */
const EVM_DEX_ADAPTERS: {
  readonly [K in EvmDexEntry['adapter']]: new (
    chainIdentifier: string,
    entry: Extract<EvmDexEntry, { adapter: K }>,
    wallet: EvmDexWallet,
  ) => EvmDex
} = {
  'uniswap-v4': UniswapV4Dex,
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
  readonly record: EvmContractCallRecord
  readonly call: { to: string; data: string; value: string }
}

export type EvmSwapUnavailable = 'no-deployment' | 'wrong-network' | 'no-wallet'

export class EvmSwapUnavailableError extends Error {
  constructor(readonly reason: EvmSwapUnavailable) {
    super(`Swap unavailable: ${reason}`)
    this.name = 'EvmSwapUnavailableError'
  }
}

/** The enabled dex entries of a chain's EVM wallet, in order; empty when it has none. */
export function evmSwapVenues(
  chainIdentifier: string | undefined,
): readonly EvmDexEntry[] {
  return chainIdentifier ? listEvmSwapVenues(chainIdentifier) : []
}

export async function openEvmSwapSession(
  chainIdentifier: string,
  venueId?: string,
): Promise<EvmSwapSession> {
  const entry = getEvmDexDeployment(chainIdentifier, venueId)
  if (!entry) throw new EvmSwapUnavailableError('no-deployment')
  const wallet = await accountSession.getWallet()
  const { account: signedIn, revision } = accountSession.state
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
    reobserveNativeOperations: optional(wallet.reobserveNativeOperations),
  }
  const Adapter = EVM_DEX_ADAPTERS[entry.adapter]
  return {
    chainIdentifier,
    dex: new Adapter(chainIdentifier, entry, calls),
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
          !row.record ||
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
      accountSession.state.revision === revision,
  }
}

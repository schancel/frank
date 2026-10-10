/**
 * Composition for an EVM swap: binds the account's EVM wallet for one canonical chain to one
 * of that chain's enabled dex entries, and builds the entry's adapter class, handing it the
 * wallet as a narrow interface. The adapter key in configuration is mapped to its class here,
 * explicitly; nothing registers itself.
 *
 * The wallet's contract send takes the swap's record as an argument. The wallet handle must not
 * depend on messaging (custody does not acquire transport), so the part of that send that keeps
 * the record and writes the note to self is wired here, around the handle's journaled send: the
 * adapter sees one wallet operation.
 */
import {
  getEvmDexDeployment,
  listEvmSwapVenues,
  type EvmDexEntry,
} from '@frank/wallet/chain/dex-deployments'
import type { EvmDex, EvmDexWallet } from '@frank/wallet/swap/evm-dex'
import type {
  ContractCallRecord,
  SwapExecutionReader,
} from '@frank/wallet/swap/swap-execution'
import { UniswapV4Dex } from '@frank/wallet/swap/uniswap-v4-dex'
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
  /** Re-submits a recorded operation's same signed bytes. */
  resumeOperation(operationId: string): Promise<unknown>
  /** What the wallet's other accounts hold. Walks every account: not for a timer. */
  otherAccountsBalance(): Promise<bigint>
  /** False once the signed-in account has changed: an open form must not sign for another. */
  isCurrent(): boolean
}

/** A contract call's record with what the wallet knows once it has signed. */
export interface SignedContractCallRecord {
  readonly record: ContractCallRecord
  readonly transactionId: string
  readonly operationId: string
  readonly call: { to: string; data: string; value: string }
  readonly signedAtMs: number
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
  /**
   * Keeps a signed contract call's record, called before the call is broadcast. If it throws,
   * nothing is broadcast. Writing the note to self is its own to retry and never fails it.
   */
  keepRecord?: (signed: SignedContractCallRecord) => Promise<void>,
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
    // "Send a legacy transaction to a contract", with its record: signed and journaled by the
    // handle, the record kept before the handle broadcasts.
    sendContractCall: ({ record, onSigned, ...call }) =>
      sendContractCall.call(wallet, {
        ...call,
        onSigned: async signed => {
          if (record && keepRecord)
            await keepRecord({
              record,
              transactionId: signed.txHash,
              operationId: signed.operationId,
              call: {
                to: call.to.raw,
                data: call.data,
                value: call.value.toString(),
              },
              signedAtMs: Date.now(),
            })
          await onSigned?.(signed)
        },
      }),
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
    resumeOperation: async id => calls.resumeNativeOperation?.(id),
    otherAccountsBalance: async () =>
      (await calls.getContractCallFunds()).otherBalance,
    isCurrent: () =>
      accountSession.state.status === 'ready' &&
      accountSession.state.account === signedIn &&
      accountSession.state.revision === revision,
  }
}

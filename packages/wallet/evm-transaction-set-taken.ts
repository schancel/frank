/**
 * What becomes of a transaction set when another transaction used one of its nonces: another
 * device of the same account spent the same coin at the same moment, or anyone else holding that
 * coin's key did. Read from the chain alone; the preparer stays the state owner.
 *
 * A member is *taken* when its nonce was used by a different transaction (`findNonceConsumer`
 * says `another`) at least `EVM_FAILURE_CONFIRMATIONS` blocks deep. A taken member can never
 * land. What stands on it (the set's later transactions from the same account, which were signed
 * against a balance that no longer exists, and transactions from an account a taken move was to
 * fund) can land only if its account still covers it. Such a member is *abandoned*
 * (`state: 'abandoned'`, `nativeMemberAbandoned`): never handed out again, no longer holding its
 * account or counting as money on its way back (`FundsInPendingSendError`), and its account is
 * listed again at what the chain shows. Only when:
 *
 * - it never left this wallet (so nobody can send its bytes), or
 * - it is the wallet's own move (change or funding: those are never given to a relay, only this
 *   wallet broadcasts them) and its account, read at the head and three blocks back, does not
 *   hold what it and the set's earlier members of that account still to land would cost, or
 * - (`withdrawPayments`) it is a payment of a message the relay refused before storing anything
 *   (the message's `unstored`): the relay held no copy and this wallet never broadcasts a
 *   payment before the relay stores its message, so nobody else has its bytes. The message is
 *   paid again from other coins.
 *
 * What stands on a member given up is given up too (its nonce comes after one the wallet lists
 * again, or its account is funded by a move that never happens).
 *
 * A payment the relay may hold (the message was stored) is never abandoned on its balance alone,
 * nor because a member it stands on was given up: a later deposit to its account would let it
 * land, and the recipient would be paid twice. Only its own nonce being taken ends it.
 *
 * A read that fails, or a node that no longer keeps the blocks it would need, changes nothing:
 * the set stays as it is and is looked at again later. Never a timeout.
 */
import { Transaction, type Provider } from 'ethers'
import { findNonceConsumer } from './evm-nonce-consumer'
import { EVM_FAILURE_CONFIRMATIONS } from './chain/evm-settlement'
import {
  nativeMemberAbandoned,
  nativeMemberEnded,
  nativeMemberSuperseded,
  type EvmNativeAccountObservation,
  type EvmNativeMember,
  type EvmNativeObservation,
  type EvmNativeOperation,
} from './storage/evm-native-operation-journal'

export interface TakenSetAuthority {
  readOperation(id: string): Promise<EvmNativeOperation | undefined>
  recordObservation(
    id: string,
    memberIndex: number,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
    expectedMember?: EvmNativeMember,
  ): Promise<boolean>
}

export type TakenSetProvider = Pick<
  Provider,
  'getBlockNumber' | 'getTransactionCount' | 'getBlock' | 'getBalance'
>

/** What the chain showed about who used each superseded member's nonce, per provider. Process
 * memory: a decided answer (deep enough) does not change, so each is searched for once. */
const consumersOf = new WeakMap<object, Map<string, { by: 'this' | 'another'; blockNumber: number }>>()

/**
 * The members of `operation` whose nonce a different transaction used, at least
 * `EVM_FAILURE_CONFIRMATIONS` deep, with the block of that transaction. Empty when none is, or
 * when the chain cannot say.
 */
export async function takenMembers(
  provider: TakenSetProvider,
  operation: EvmNativeOperation,
  head: number,
): Promise<Map<number, number>> {
  const taken = new Map<number, number>()
  let consumers = consumersOf.get(provider)
  if (!consumers) consumersOf.set(provider, (consumers = new Map()))
  for (const [index, member] of operation.members.entries()) {
    if (!nativeMemberSuperseded(member) || !member.signed) continue
    const key = `${operation.operationId}:${index}:${member.signed.transactionHash}`
    let found = consumers.get(key)
    if (!found) {
      found = await findNonceConsumer(
        provider,
        {
          account: member.source.address,
          nonce: Transaction.from(member.signed.rawTransaction).nonce,
          transactionHash: member.signed.transactionHash,
        },
        member.account!.blockNumber,
      )
      if (!found) continue
      if (head - found.blockNumber + 1 >= EVM_FAILURE_CONFIRMATIONS) consumers.set(key, found)
    }
    if (found.by === 'another' && head - found.blockNumber + 1 >= EVM_FAILURE_CONFIRMATIONS)
      taken.set(index, found.blockNumber)
  }
  return taken
}

function landed(member: EvmNativeMember): boolean {
  return (
    member.observation.state === 'included-success' ||
    member.observation.state === 'included-revert'
  )
}

/** The most a member can take from its account: its value and its whole gas allowance. */
function cost(member: EvmNativeMember): bigint {
  const tx = Transaction.from(member.unsignedTransaction)
  return tx.value + tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n)
}

/**
 * Gives up, on chain evidence, every member of `operationId` that can never land because another
 * transaction took a nonce it stands on (see the file comment). Returns the members taken and
 * the members abandoned now. Nothing changes when no member is taken.
 */
export async function abandonTakenMembers(params: {
  authority: TakenSetAuthority
  provider: TakenSetProvider
  operationId: string
  /** The message these payments carry was refused by the relay before it stored anything, and
   * is paid again from other coins: every payment of the set that has not landed is given up,
   * with what stands on it. */
  withdrawPayments?: boolean
}): Promise<{ taken: number[]; abandoned: number[] }> {
  const { authority, provider, operationId } = params
  const none = { taken: [], abandoned: [] }
  try {
    const operation = await authority.readOperation(operationId)
    if (!operation || operation.cancelled || operation.kind !== 'transaction-set') return none
    if (!operation.members.some(nativeMemberSuperseded)) return none
    const head = await provider.getBlockNumber()
    const taken = await takenMembers(provider, operation, head)
    if (taken.size === 0) return none
    const takenAt = Math.min(...taken.values())
    const block = await provider.getBlock(head)
    if (!block?.hash || block.number !== head) return none
    // What each account holds, at the head and a few blocks back (a deposit shows at the head,
    // so the larger counts): read once per account.
    // `balance` decides whether the account covers a member; the account observation recorded
    // is the head's alone (`nonce`, `atHead`), consistent with one block.
    const accounts = new Map<string, { nonce: number; balance: bigint; atHead: bigint }>()
    const read = async (address: string) => {
      let known = accounts.get(address)
      if (!known) {
        const back = Math.max(0, head - (EVM_FAILURE_CONFIRMATIONS - 1))
        const [nonce, now, before] = await Promise.all([
          provider.getTransactionCount(address, head),
          provider.getBalance(address, head),
          provider.getBalance(address, back),
        ])
        known = { nonce, balance: now > before ? now : before, atHead: now }
        accounts.set(address, known)
      }
      return known
    }
    // What each account's members still to land would take, in nonce order (the set's order).
    const owed = new Map<string, bigint>()
    const given = new Set<number>()
    const abandon: number[] = []
    for (const [index, member] of operation.members.entries()) {
      if (landed(member) || nativeMemberSuperseded(member)) continue
      if (nativeMemberAbandoned(member)) {
        given.add(index)
        continue
      }
      const address = member.source.address
      const withdrawn =
        params.withdrawPayments === true && member.transactionSet?.role === 'payment'
      const standsOnTaken = member.dependencies.some(dependency => taken.has(dependency))
      // What stands on a member given up can never land: its nonce comes after one the wallet
      // lists again for its next coin, or its account is funded by a move that never happens.
      const standsOnGiven = member.dependencies.some(dependency => given.has(dependency))
      // A payment the relay may hold is the exception (see the file comment): it stays.
      const payment = member.transactionSet?.role === 'payment'
      let give =
        withdrawn ||
        (standsOnGiven && (!payment || !member.exposed)) ||
        (standsOnTaken && !member.exposed)
      if (!give && standsOnTaken && !payment) {
        const { balance } = await read(address)
        give = (owed.get(address) ?? 0n) + cost(member) > balance
      }
      if (!give) {
        owed.set(address, (owed.get(address) ?? 0n) + cost(member))
        continue
      }
      given.add(index)
      abandon.push(index)
    }
    const committed: number[] = []
    for (const index of abandon) {
      const address = operation.members[index]!.source.address
      const { nonce, atHead } = await read(address)
      const recorded = await authority.recordObservation(
        operationId,
        index,
        { state: 'abandoned', blockNumber: takenAt },
        { blockHash: block.hash, blockNumber: head, nonce, balanceWei: atHead.toString() },
        operation.members[index]!,
      )
      // A newer exposure/observation invalidates this plan and everything downstream of it.
      // Leave those members to a fresh chain pass; never report a rejected write as released.
      if (!recorded) break
      committed.push(index)
    }
    if (committed.length > 0)
      console.warn(
        `[evm-transaction-set] ${operationId}: another transaction used the nonce of ${[...taken.keys()]
          .map(index => operation.members[index]!.signed!.transactionHash)
          .join(', ')}; ${committed.length} transaction(s) of the set that stood on it can never land and are given up: their accounts are listed again at what the chain shows.`,
      )
    return { taken: [...taken.keys()], abandoned: committed }
  } catch (error) {
    console.warn(`[evm-transaction-set] ${operationId}: could not read whether its transactions were taken; looked at again later:`, error)
    return none
  }
}

/** Every payment of the set (of `stageId`, when given) has ended without landing. */
export function paymentsEnded(operation: EvmNativeOperation, stageId?: string): boolean {
  const payments = operation.members.filter(member =>
    member.transactionSet?.role === 'payment' &&
    (stageId === undefined || member.transactionSet.stageId === stageId))
  return payments.length > 0 && payments.every(nativeMemberEnded)
}

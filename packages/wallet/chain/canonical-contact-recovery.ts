/** Original contact value stays in its financial journal; this workflow recovers only delivery. */
import { Transaction } from 'ethers'
import { canonicalNetworkDescriptor } from '@frank/cashweb/relay/canonical-dm-transport'
import type { StoredMessage } from '../storage/outgoing-message-store'
import { nativeMaximumFee, nativeMemberEnded, nativeMemberSuperseded, type EvmNativeOperation } from '../storage/evm-native-operation-journal'
import { takenMembers } from '../evm-transaction-set-taken'
import type { CanonicalMessagingOwner } from './canonical-dm'

type ContactRecoveryOwner = Pick<CanonicalMessagingOwner, 'installedNetworkTag' | 'chainId' | 'transactionSets'>

export async function originalContactOperation(owner: ContactRecoveryOwner, row: StoredMessage): Promise<EvmNativeOperation> {
  const shared = owner.transactionSets
  const id = row.originalCombinedOperationId ?? row.transactionSetOperationId
  if (!shared?.resolvePaymentOperation || !row.paymentOperationId || !row.construction || !id ||
      await shared.resolvePaymentOperation(row.paymentOperationId, BigInt(row.construction.amountWei)) !== id)
    throw new Error('Original contact recovery binding differs from payment authority')
  const operation = await shared.preparer.readOperation(id)
  if (!operation || operation.cancelled || operation.kind !== 'transaction-set' ||
      operation.binding.chainIdentifier !== canonicalNetworkDescriptor(owner.installedNetworkTag).network ||
      operation.binding.nativeChainId !== owner.chainId.toString())
    throw new Error('Original contact operation unavailable on this wallet chain')
  if (row.originalCombinedOperationId) {
    const stage = `stamp-${row.consumerId.slice('frank-dm:'.length)}`
    const contacts = operation.members.filter(member => member.transactionSet?.role === 'payment' && member.transactionSet.stageId === undefined)
    const stamps = operation.members.filter(member => member.transactionSet?.role === 'payment' && member.transactionSet.stageId === stage)
    if (!contacts.length || contacts.some(member => member.observation.state !== 'included-success') ||
        !stamps.length || stamps.some(member => !nativeMemberSuperseded(member)))
      throw new Error('Original paid contact or taken stamp evidence changed')
  }
  return operation
}

/** Captured whole-operation authorization. Recovery never silently increases it. */
export function originalFeeCeiling(operation: EvmNativeOperation): bigint {
  const ceilings = operation.transactionSetStages?.flatMap(stage => stage.maxFeeWei === undefined ? [] : [BigInt(stage.maxFeeWei)]) ?? []
  if (ceilings.length === 0) throw new Error('Original contact fee authorization unavailable')
  return ceilings.reduce((lowest, value) => value < lowest ? value : lowest)
}

/** Included fees are paid; other exposed/unfinished bytes retain their complete fee allowance. */
function encumberedFee(operation: EvmNativeOperation): bigint {
  return operation.members.reduce((total, member) => {
    if (member.observation.state === 'included-success' || member.observation.state === 'included-revert')
      return total + BigInt(member.observation.feeWei)
    // An exposed owned move labelled abandoned can still be held by another broadcaster.
    // Its fee stays reserved until actual chain evidence decides it (C2 recovery policy).
    if (nativeMemberEnded(member) && (!member.exposed || nativeMemberSuperseded(member))) return total
    if (!member.signed) throw new Error('Original contact operation is not signed')
    return total + nativeMaximumFee(Transaction.from(member.signed.rawTransaction))
  }, 0n)
}

/** All preceding attempts count against one approved operation budget, including owned moves. */
export async function contactRecoveryBudget(owner: ContactRecoveryOwner, row: StoredMessage) {
  const original = await originalContactOperation(owner, row)
  let committed = encumberedFee(original)
  let paidFees = original.members.reduce((sum, member) => sum +
    (member.observation.state === 'included-success' || member.observation.state === 'included-revert' ? BigInt(member.observation.feeWei) : 0n), 0n)
  for (const id of new Set(row.replacedOperationIds ?? [])) {
    const operation = await owner.transactionSets!.preparer.readOperation(id)
    if (!operation) throw new Error('Previous recovery stamp operation unavailable')
    committed += encumberedFee(operation)
    paidFees += operation.members.reduce((sum, member) => sum +
      (member.observation.state === 'included-success' || member.observation.state === 'included-revert' ? BigInt(member.observation.feeWei) : 0n), 0n)
  }
  const ceiling = row.stampRecoveryFeeCeiling === undefined ? originalFeeCeiling(original) : BigInt(row.stampRecoveryFeeCeiling)
  return { original, ceiling, committed, paidFees, remaining: ceiling > committed ? ceiling - committed : 0n }
}

/** Recover a paid contact only when every original stamp is conclusively unable to land. */
export async function detachPaidContactStamp(owner: ContactRecoveryOwner, row: StoredMessage): Promise<StoredMessage | undefined> {
  if (!row.transactionSetStageId || !row.transactionSetOperationId || !row.paymentOperationId ||
      row.unstored !== true || row.outcome !== undefined) return undefined
  const original = await originalContactOperation(owner, row)
  const contacts = original.members.filter(member => member.transactionSet?.role === 'payment' && member.transactionSet.stageId === undefined)
  if (!contacts.length || contacts.some(member => member.observation.state !== 'included-success')) return undefined
  const stamps = original.members.flatMap((member, index) => member.transactionSet?.role === 'payment' &&
    member.transactionSet.stageId === row.transactionSetStageId ? [index] : [])
  if (!stamps.length) return undefined
  const shared = owner.transactionSets!
  const taken = await takenMembers(shared.provider, original, await shared.provider.getBlockNumber())
  // A depleted account or abandoned funding is not proof that exposed stamp bytes cannot land.
  if (!stamps.every(index => taken.has(index))) return undefined
  const { ceiling, remaining } = await contactRecoveryBudget(owner, row)
  const { request: _request, reason: _reason, transactionSetStageId: _stage, ...kept } = row
  return {
    ...kept,
    originalCombinedOperationId: row.transactionSetOperationId,
    transactionSetOperationId: `stamp-${row.consumerId.slice('frank-dm:'.length)}`,
    stampRecoveryFeeCeiling: ceiling.toString(),
    construction: { ...row.construction!, maxFeeWei: remaining.toString() },
    payments: [],
    otherTransactions: [],
  }
}

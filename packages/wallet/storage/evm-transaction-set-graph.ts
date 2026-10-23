/** Validation of the signed transaction graph; no inventory, signing or node effects. */
import { Transaction } from 'ethers'
import type { EvmNativeMember, EvmTransactionSetStage } from './evm-native-operation-journal'

export function validateTransactionSetGraph(
  members: EvmNativeMember[], intended: bigint, value: unknown, fail: () => never,
): void {
  const uint = (value: unknown): bigint => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return fail()
    return BigInt(value)
  }
  const integer = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return fail()
    return value as number
  }
  const fee = (tx: Transaction) => tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n)
  const stages = value === undefined ? undefined : value as EvmTransactionSetStage[]
  if (stages && (!Array.isArray(stages) || !stages.length)) fail()
  let offset = 0
  const stageNames = new Set<string>()
  for (const [index, stage] of (stages ?? []).entries()) {
    if (!stage || Object.keys(stage).some(key => !['stageId','startIndex','memberCount','intendedValueWei','calldata','destinations','maxFeeWei','reserveForContinuationWei','legacy'].includes(key))) fail()
    const key = stage.stageId ?? ''
    if ((index === 0 ? stage.stageId !== undefined : !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) || stageNames.has(key) ||
        integer(stage.startIndex) !== offset || integer(stage.memberCount) === 0 ||
        typeof stage.calldata !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(stage.calldata) ||
        !Array.isArray(stage.destinations) || !stage.destinations.length ||
        stage.destinations.some(destination => !/^0x[0-9a-f]{40}$/.test(destination)) ||
        (stage.legacy !== undefined && stage.legacy !== true)) fail()
    stageNames.add(key)
    if (index === 0 && uint(stage.intendedValueWei) !== intended) fail()
    offset += stage.memberCount
    const totalFee = members.reduce((sum, member) => sum + fee(Transaction.from(member.unsignedTransaction)), 0n)
    if (stage.maxFeeWei !== undefined && totalFee > uint(stage.maxFeeWei)) fail()
  }
  if (stages && offset !== members.length) fail()
  const incoming = new Map<string, { indexes: number[]; value: bigint; changeIndex: number; role: string }>()
  for (const [index, member] of members.entries()) {
    const tx = Transaction.from(member.unsignedTransaction), meta = member.transactionSet
    if (!meta) fail()
    if (meta.role === 'change' || meta.role === 'funding') {
      const changeIndex = integer(meta.changeIndex), destination = tx.to!.toLowerCase(), prior = incoming.get(destination)
      if (changeIndex >= 0x80000000 || tx.value <= 0n || tx.data !== '0x' ||
          (prior && (meta.role !== 'funding' || prior.role !== 'funding' || prior.changeIndex !== changeIndex)) ||
          [...incoming.entries()].some(([account, entry]) => account !== destination && entry.changeIndex === changeIndex)) fail()
      incoming.set(destination, { indexes: [...(prior?.indexes ?? []), index], value: (prior?.value ?? 0n) + tx.value, changeIndex, role: meta.role })
    }
  }
  const latest = new Map<string, { index: number; nonce: number; balance: bigint }>()
  const intendedPaid = new Map<string, bigint>()
  const paid = new Map<string, bigint>(), paymentIndexes = new Map<string, Set<number>>()
  for (const [index, member] of members.entries()) {
    const meta = member.transactionSet!, tx = Transaction.from(member.unsignedTransaction)
    if (Object.keys(meta).some(key => !['role','intendedValueWei','stageId','fundingWaitBlocks','logicalIndex','changeIndex','balanceBeforeWei','balanceAfterWei','inventoryApplied','predecessorWaitBlocks','remainderSpendableFromBlock','refundPending'].includes(key))) fail()
    integer(meta.logicalIndex)
    if (meta.stageId !== undefined && !stageNames.has(meta.stageId)) fail()
    if (meta.inventoryApplied !== undefined && (meta.inventoryApplied !== true || !member.signed || !member.account || member.account.nonce <= tx.nonce || !['included-success','included-revert','missing'].includes(member.observation.state))) fail()
    if (meta.refundPending !== undefined && meta.refundPending !== true) fail()
    if (meta.remainderSpendableFromBlock !== undefined) integer(meta.remainderSpendableFromBlock)
    const before = uint(meta.balanceBeforeWei), after = uint(meta.balanceAfterWei)
    if (before !== tx.value + fee(tx) + after) fail()
    const previous = latest.get(member.source.address), funding = incoming.get(member.source.address)
    if (previous) {
      if (tx.nonce !== previous.nonce + 1 || before !== previous.balance || JSON.stringify(member.dependencies) !== JSON.stringify([previous.index]) || meta.fundingWaitBlocks !== undefined) fail()
    } else if (funding) {
      if (tx.nonce !== 0 || before !== funding.value || funding.indexes.some(creator => creator >= index) || JSON.stringify(member.dependencies) !== JSON.stringify(funding.indexes)) fail()
      if (meta.fundingWaitBlocks !== undefined) integer(meta.fundingWaitBlocks)
    } else if (member.dependencies.length || meta.fundingWaitBlocks !== undefined) fail()
    if (meta.predecessorWaitBlocks !== undefined && (integer(meta.predecessorWaitBlocks) === 0 || !previous || meta.role !== 'change' || member.dependencies.length !== 1)) fail()
    latest.set(member.source.address, { index, nonce: tx.nonce, balance: after })
    const stage = stages?.find(item => index >= item.startIndex && index < item.startIndex + item.memberCount)
    if (stages && (!stage || stage.stageId !== meta.stageId)) fail()
    const key = meta.stageId ?? ''
    if (meta.role === 'payment') {
      const indexes = paymentIndexes.get(key) ?? new Set<number>()
      if (meta.changeIndex !== undefined || indexes.has(meta.logicalIndex) ||
          (stage && (stage.destinations[meta.logicalIndex] !== tx.to!.toLowerCase() || tx.data !== stage.calldata))) fail()
      indexes.add(meta.logicalIndex); paymentIndexes.set(key, indexes)
      paid.set(key, (paid.get(key) ?? 0n) + tx.value)
      if (meta.intendedValueWei !== undefined) {
        const amount = uint(meta.intendedValueWei)
        if (amount > tx.value) fail()
        intendedPaid.set(key, (intendedPaid.get(key) ?? 0n) + amount)
      } else if (stages) fail()
    } else if ((meta.role !== 'change' && meta.role !== 'funding') || meta.intendedValueWei !== undefined) fail()
  }
  for (const stage of stages ?? [{ intendedValueWei: intended.toString(), stageId: undefined }]) {
    const key = stage.stageId ?? '', indexes = paymentIndexes.get(key)
    if (!indexes?.size || (paid.get(key) ?? 0n) < uint(stage.intendedValueWei) || [...indexes].sort((a,b) => a-b).some((item,index) => item !== index)) fail()
    if ('destinations' in stage && (stage.destinations.length !== indexes.size || intendedPaid.get(key) !== uint(stage.intendedValueWei))) fail()
    if ('legacy' in stage && stage.legacy && indexes.size !== 1) fail()
    if ('reserveForContinuationWei' in stage && stage.reserveForContinuationWei !== undefined) {
      const change = members.filter(member => member.transactionSet?.stageId === stage.stageId && member.transactionSet!.role === 'change').reduce((sum, member) => sum + Transaction.from(member.unsignedTransaction).value, 0n)
      if (change < uint(stage.reserveForContinuationWei)) fail()
    }
  }
  const signed = members.filter(member => member.signed !== null).length
  if (signed !== 0 && signed !== members.length) fail()
}

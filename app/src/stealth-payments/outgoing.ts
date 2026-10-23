import type { WalletHandle } from '@frank/wallet/chain'
import type { OutgoingFinancialOperation } from '@frank/cashweb/types/messages'
import { accountSession } from '../accounts/session'
import {
  createNativeTransferContext,
  type NativeTransferBinding,
} from '../accounts/native-transfer'
import type { StealthPaymentCapability } from '@frank/wallet/stealth-payment'

/** Capture existing financial owners, never prepare or release a payment during delivery. */
export async function captureOutgoingFinancialOperations(
  wallet: WalletHandle,
  references: readonly OutgoingFinancialOperation[],
) {
  const capturedReferences = references.map(reference => ({ ...reference }))
  const checkOwner = async () => {
    if ((await accountSession.getWallet()) !== wallet)
      throw new Error('Outgoing financial account changed')
  }
  await checkOwner()
  const keys = new Set<string>()
  let paymentOperationId: string | undefined
  const operations: {
    reference: OutgoingFinancialOperation
    binding: NativeTransferBinding
    capability: StealthPaymentCapability
  }[] = []
  for (const reference of capturedReferences) {
    const key = JSON.stringify([
      reference.chainIdentifier,
      reference.operationId,
    ])
    if (!reference.operationId || keys.has(key))
      throw new Error('Invalid outgoing financial operation reference')
    keys.add(key)
    const context = await createNativeTransferContext(reference.chainIdentifier)
    const binding = await context.captureWallet()
    await checkOwner()
    const capability = binding.wallet.stealthPayments
    if (!capability) throw new Error('Outgoing stealth payment is unsupported')
    const prepared = await capability.get(reference.operationId)
    if (
      !prepared ||
      prepared.chainIdentifier !== reference.chainIdentifier ||
      prepared.operationId !== reference.operationId
    )
      throw new Error('Outgoing financial operation is unavailable')
    if (
      binding.wallet === wallet &&
      reference.chainIdentifier === wallet.chainIdentifier &&
      capability.supportsCombinedStamp === true &&
      prepared.asset.kind === 'native' &&
      prepared.messageStamp !== undefined
    ) {
      if (paymentOperationId !== undefined)
        throw new Error(
          'A message cannot combine multiple native payment operations into one stamp',
        )
      paymentOperationId = reference.operationId
    }
    operations.push({ reference: { ...reference }, binding, capability })
  }
  const assertCurrent = async () => {
    await checkOwner()
    for (const operation of operations) await operation.binding.assertCurrent()
    await checkOwner()
  }
  return {
    ...(paymentOperationId === undefined ? {} : { paymentOperationId }),
    async expose(payloadDigest: string) {
      await assertCurrent()
      for (const operation of operations) {
        await assertCurrent()
        await operation.capability.expose({
          operationId: operation.reference.operationId,
          payloadDigest,
        })
      }
    },
    async submit() {
      // One failed submission cannot prevent the other original operations being attempted.
      const failures: unknown[] = []
      for (const operation of operations) {
        try {
          await assertCurrent()
          await operation.capability.submit(operation.reference.operationId)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new Error('Outgoing financial submission remains pending')
    },
  }
}

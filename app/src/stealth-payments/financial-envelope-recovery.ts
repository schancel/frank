import type {
  FinancialEnvelopeBinding,
  MessageStore,
} from '@frank/cashweb/relay/storage/storage'
import type { OutgoingFinancialOperation } from '@frank/cashweb/types/messages'
import type { DirectMessageAttemptStatus } from '@frank/wallet/chain'

/** Host recovery owns only the durable binding. Messaging owns originals and its handoff
 * barrier; financial owners own signed sets. Only durable original delivery authorizes submit.
 * Submission is not settlement: retained originals remain eligible for later bounded ticks.
 * No chat row, fresh send, sign or release is used. */
export function createFinancialEnvelopeRecovery(options: {
  store: Pick<
    MessageStore,
    'financialEnvelopeBindings' | 'bindFinancialEnvelope'
  >
  accountId: string
  messagingChainIdentifier: string
  isCurrent(): boolean
  capture(
    references: readonly OutgoingFinancialOperation[],
  ): Promise<{ expose(digest: string): Promise<void>; submit(): Promise<void> }>
  attemptOf(
    messageId: string,
  ): Promise<{ payloadDigest: string; paid: boolean } | undefined>
  deliveryOf(digest: string): Promise<DirectMessageAttemptStatus | undefined>
  reconcile(params: {
    payloadDigests: string[]
    messageIds: readonly string[]
    onEnvelopeDurable(digest: string, messageId?: string): Promise<void>
  }): Promise<Record<string, DirectMessageAttemptStatus>>
  onError(binding: FinancialEnvelopeBinding | undefined, error: unknown): void
}) {
  const active = new Set<string>()
  let cursor = 0
  const assertCurrent = () => {
    if (!options.isCurrent())
      throw new Error('Financial envelope recovery context changed')
  }
  return {
    async tick(): Promise<void> {
      if (!options.isCurrent()) return
      let rows: readonly FinancialEnvelopeBinding[]
      try {
        rows = await options.store.financialEnvelopeBindings(options)
        assertCurrent()
      } catch (error) {
        if (options.isCurrent()) options.onError(undefined, error)
        return
      }
      const count = Math.min(16, rows.length)
      const offset = cursor % (rows.length || 1)
      cursor = (offset + count) % (rows.length || 1)
      await Promise.all(
        Array.from(
          { length: count },
          (_, i) => rows[(offset + i) % rows.length],
        ).map(async binding => {
          if (!options.isCurrent() || active.has(binding.messageId)) return
          active.add(binding.messageId)
          try {
            let originalDigest =
              binding.phase === 'bound' ? binding.payloadDigest : undefined
            let financial:
              | Awaited<ReturnType<typeof options.capture>>
              | undefined
            const submitOriginal = async () => {
              assertCurrent()
              financial ??= await options.capture(binding.financialOperations)
              assertCurrent()
              await financial.submit()
              assertCurrent()
            }
            if (binding.phase === 'pending') {
              const original = await options.attemptOf(binding.messageId)
              assertCurrent()
              if (!original)
                throw new Error(
                  'Financial envelope intent is pending: original has not been stored; no new message was created',
                )
              // Record identity only. A held original still requires its canonical exposure callback.
              await options.store.bindFinancialEnvelope({
                ...binding,
                phase: 'bound',
                payloadDigest: original.payloadDigest,
              })
              assertCurrent()
              originalDigest = original.payloadDigest
            }
            if (originalDigest !== undefined) {
              const status = await options.deliveryOf(originalDigest)
              assertCurrent()
              if (status === 'delivered') {
                // Restore the referenced owner handles even when every presentation row is gone.
                await submitOriginal()
                return
              }
            }
            const statuses = await options.reconcile({
              messageIds: [binding.messageId],
              payloadDigests:
                originalDigest === undefined ? [] : [originalDigest],
              async onEnvelopeDurable(digest, messageId) {
                assertCurrent()
                if (
                  messageId !== binding.messageId ||
                  (originalDigest !== undefined && digest !== originalDigest)
                )
                  throw new Error(
                    'Financial envelope original identity conflict',
                  )
                await options.store.bindFinancialEnvelope({
                  ...binding,
                  phase: 'bound',
                  payloadDigest: digest,
                })
                assertCurrent()
                originalDigest = digest
                financial = await options.capture(binding.financialOperations)
                assertCurrent()
                await financial.expose(digest)
                assertCurrent()
              },
            })
            assertCurrent()
            if (
              originalDigest === undefined ||
              statuses[originalDigest] === undefined ||
              statuses[originalDigest] === 'unknown'
            )
              throw new Error(
                'Financial envelope intent is pending: original has not been stored; no new message was created',
              )
            if (statuses[originalDigest] === 'delivered') await submitOriginal()
          } catch (error) {
            if (options.isCurrent()) options.onError(binding, error)
          } finally {
            active.delete(binding.messageId)
          }
        }),
      )
    },
  }
}

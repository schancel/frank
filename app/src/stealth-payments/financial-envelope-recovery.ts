import type {
  FinancialEnvelopeBinding,
  MessageStore,
} from '@frank/cashweb/relay/storage/storage'
import type { OutgoingFinancialOperation } from '@frank/cashweb/types/messages'
import type { DirectMessageAttemptStatus } from '@frank/wallet/chain'

/** Host recovery owns only the durable binding. Messaging owns originals and its handoff
 * barrier; financial owners own signed sets. No chat row, fresh send, sign or release is used. */
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
  ): Promise<{ expose(digest: string): Promise<void> }>
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
            if (binding.phase === 'bound') {
              const status = await options.deliveryOf(binding.payloadDigest)
              assertCurrent()
              if (status === 'delivered') {
                // Restore the referenced owner handles even when every presentation row is gone.
                await options.capture(binding.financialOperations)
                assertCurrent()
                return
              }
            }
            const statuses = await options.reconcile({
              messageIds: [binding.messageId],
              payloadDigests:
                binding.phase === 'bound' ? [binding.payloadDigest] : [],
              async onEnvelopeDurable(digest, messageId) {
                assertCurrent()
                if (
                  messageId !== binding.messageId ||
                  (binding.phase === 'bound' &&
                    digest !== binding.payloadDigest)
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
                const financial = await options.capture(
                  binding.financialOperations,
                )
                assertCurrent()
                await financial.expose(digest)
                assertCurrent()
              },
            })
            assertCurrent()
            if (
              (binding.phase === 'pending' &&
                Object.keys(statuses).length === 0) ||
              (binding.phase === 'bound' &&
                statuses[binding.payloadDigest] === 'unknown')
            )
              throw new Error(
                'Financial envelope intent is pending: original has not been stored; no new message was created',
              )
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

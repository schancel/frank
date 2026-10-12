import type { DirectMessageAttemptStatus } from '@frank/wallet/chain'
import type {
  StealthPaymentCapability,
  StealthPaymentProgress,
} from '@frank/wallet/stealth-payment'

/** Already-open, canonically bound owners. Enumeration must not open custody on every tick. */
export interface FinancialRecoveryWallet {
  readonly chainIdentifier: string
  /** The stable wallet instance, rather than a newly allocated capability facade. */
  readonly owner: object
  readonly payments: Pick<
    StealthPaymentCapability,
    'list' | 'submit' | 'reconcile'
  >
}

export interface FinancialRecoverySession {
  /** Captured account/session affinity; a replacement ends every effect of this pass. */
  isCurrent(): boolean
  readonly wallets: readonly FinancialRecoveryWallet[]
  /** Read-only durable delivery evidence from the captured messaging owner. */
  deliveryOf(
    payloadDigest: string,
  ): Promise<DirectMessageAttemptStatus | undefined>
}

export interface FinancialRecoveryFailure {
  readonly chainIdentifier: string
  readonly operationId?: string
  readonly payloadDigest?: string
  readonly stage: 'list' | 'delivery' | 'submit' | 'reconcile'
  readonly error: unknown
}

/** Caller-driven retry of original operations, independent of chat rows and UI retention.
 * Exposure alone is insufficient: a partially bound envelope may still be held locally.
 * Only durable delivery authorizes submission or potentially broadcasting reconciliation.
 */
export function createFinancialOperationRecovery(options: {
  captureSession(): Promise<FinancialRecoverySession | undefined>
  /** Fairly rotate through retained operation history; default: 16 per wallet per tick. */
  maxOperationsPerWallet?: number
  onError(failure: FinancialRecoveryFailure): void
  onProgress?(result: {
    chainIdentifier: string
    operationId: string
    payloadDigest: string
    progress: StealthPaymentProgress
  }): void
}) {
  const limit = options.maxOperationsPerWallet ?? 16
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
    throw new Error('Financial recovery operation limit must be in 1..64')
  const active = new WeakMap<object, Set<string>>()
  const cursors = new WeakMap<object, number>()
  return {
    /** Ticks may overlap. A slow operation excludes only itself, including on subsequent ticks. */
    async tick(): Promise<void> {
      const session = await options.captureSession()
      if (!session?.isCurrent()) return
      await Promise.all(
        session.wallets.map(async wallet => {
          let operations: Awaited<ReturnType<StealthPaymentCapability['list']>>
          try {
            if (!session.isCurrent()) return
            operations = await wallet.payments.list()
          } catch (error) {
            if (session.isCurrent())
              options.onError({
                chainIdentifier: wallet.chainIdentifier,
                stage: 'list',
                error,
              })
            return
          }
          if (!session.isCurrent()) return
          let held = active.get(wallet.owner)
          if (!held) {
            held = new Set()
            active.set(wallet.owner, held)
          }
          const inFlight = held
          const bindings = new Map<string, Set<string>>()
          for (const operation of operations) {
            if (operation.payloadDigest === undefined) continue
            const digests =
              bindings.get(operation.operationId) ?? new Set<string>()
            digests.add(operation.payloadDigest)
            bindings.set(operation.operationId, digests)
          }
          const entries = [...bindings]
          const offset =
            (cursors.get(wallet.owner) ?? 0) % (entries.length || 1)
          const count = Math.min(limit, entries.length)
          const selected = Array.from(
            { length: count },
            (_, index) => entries[(offset + index) % entries.length],
          )
          cursors.set(wallet.owner, (offset + count) % (entries.length || 1))
          await Promise.all(
            selected.map(async ([operationId, digests]) => {
              if (!session.isCurrent()) return
              const key = JSON.stringify([wallet.chainIdentifier, operationId])
              if (inFlight.has(key)) return
              inFlight.add(key)
              let stage: FinancialRecoveryFailure['stage'] = 'delivery'
              let payloadDigest: string | undefined
              try {
                for (const digest of digests) {
                  if (!session.isCurrent()) return
                  const delivery = await session.deliveryOf(digest)
                  if (!session.isCurrent()) return
                  if (delivery === 'delivered') {
                    payloadDigest = digest
                    break
                  }
                }
                if (payloadDigest === undefined) return
                stage = 'submit'
                await wallet.payments.submit(operationId)
                if (!session.isCurrent()) return
                stage = 'reconcile'
                const progress = await wallet.payments.reconcile(operationId)
                if (session.isCurrent())
                  options.onProgress?.({
                    chainIdentifier: wallet.chainIdentifier,
                    operationId,
                    payloadDigest,
                    progress,
                  })
              } catch (error) {
                if (session.isCurrent())
                  options.onError({
                    chainIdentifier: wallet.chainIdentifier,
                    operationId,
                    payloadDigest,
                    stage,
                    error,
                  })
              } finally {
                inFlight.delete(key)
              }
            }),
          )
        }),
      )
    },
  }
}

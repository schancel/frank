/** Typed host facade over the existing Solana authority. No additional operation,
 * reservation, balance, or signed-byte owner is introduced here. */
import type {
  SolanaStealthPaymentCapability,
  StealthPaymentProgress,
} from '@frank/wallet/stealth-payment'
import type { ExperimentalSolanaContactPayments } from '@frank/wallet/solana-contact-payments/engine'
import {
  validateSolanaPaymentRequest,
  type SolanaPaymentState,
} from '@frank/wallet/solana-contact-payments/state'
import type {
  SolanaPaymentAsset,
  SolanaPaymentRecord,
} from '@frank/wallet/solana-contact-payments/types'

export function createSolanaPaymentCapability(deps: {
  readonly state: SolanaPaymentState
  readonly engine: ExperimentalSolanaContactPayments
  readonly run: <T>(action: () => Promise<T>) => Promise<T>
  /** Refresh unreserved owned accounts; other authorized operations remain independent. */
  readonly refresh: (asset: SolanaPaymentAsset) => Promise<unknown>
}): SolanaStealthPaymentCapability {
  const unsigned = (operation: SolanaPaymentRecord) =>
    !('payloadDigest' in operation && operation.payloadDigest) &&
    !operation.signed.length &&
    ['quoting', 'quoted', 'reserved'].includes(operation.phase)
  const progress = async (
    operationId: string,
  ): Promise<StealthPaymentProgress> => {
    const observed = await deps.engine.progress(operationId)
    return {
      status: observed.status,
      intendedAmountAtomic: BigInt(observed.intendedAmount),
      verifiedReceivedAmountAtomic: BigInt(observed.verifiedReceivedAmount),
    }
  }
  return Object.freeze<SolanaStealthPaymentCapability>({
    family: 'solana',
    quoteReview(request) {
      const captured = structuredClone(request)
      validateSolanaPaymentRequest(captured, deps.state.chainIdentifier)
      return deps.run(async () => {
        const prior = (await deps.state.inspect()).operations[
          captured.operationId
        ]
        // Complete immutable reviews are returned by the owner. An unfinished
        // draft resumes its original allocation and derivation; it is never replanned.
        if (!prior || prior.phase === 'quoting')
          await deps.refresh(captured.asset)
        return deps.engine.quoteReview(captured)
      })
    },
    prepare: operationId => deps.run(() => deps.engine.prepare(operationId)),
    get: operationId =>
      deps.run(async () => {
        const operation = (await deps.state.inspect()).operations[operationId]
        return operation?.phase === 'quoting' ? undefined : operation
      }),
    expose(binding) {
      const { operationId, payloadDigest } = binding
      return deps.run(async () => {
        await deps.engine.expose(operationId, { payloadDigest })
      })
    },
    submit: operationId =>
      deps.run(async () => {
        await deps.engine.submit(operationId)
        return progress(operationId)
      }),
    reconcile: operationId =>
      deps.run(async () => {
        await deps.engine.reconcile(operationId)
        return progress(operationId)
      }),
    release: operationId =>
      deps.run(async () => {
        const operation = (await deps.state.inspect()).operations[operationId]
        if (!operation || !unsigned(operation)) return false
        try {
          // The authority's atomic reserved→quoted transition races persistSigned:
          // either signed persistence wins and release rejects, or preparation cannot
          // return signed bytes. The immutable review/context is retained either way.
          await deps.state.releaseUnsigned(operationId)
        } catch (error) {
          const current = (await deps.state.inspect()).operations[operationId]
          if (current && !unsigned(current)) return false
          throw error
        }
        const current = (await deps.state.inspect()).operations[operationId]
        return !!current && unsigned(current)
      }),
    list: () =>
      deps.run(async () =>
        Object.values((await deps.state.inspect()).operations).map(
          operation => ({
            operationId: operation.intent.operationId,
            ...('payloadDigest' in operation && operation.payloadDigest
              ? { payloadDigest: operation.payloadDigest }
              : {}),
          }),
        ),
      ),
  })
}

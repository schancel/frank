/**
 * Paying for one group write: the writer's half of `docs/protocol/groups/shared-mailbox-baseline.md`
 * "Paid group writes". Headless; the host injects the wallet capability, the relay's policy,
 * the relay submission and the durable message record.
 *
 * Order (persist, submit to the relay, then broadcast), each step durable before the next:
 * 1. the plan (payee, price, commitment calldata) and the wallet operation that pays it are
 *    stored on the message;
 * 2. the wallet signs exactly one transaction for that plan, the first its coin signs so its
 *    bytes land on their own, and claims the coin, broadcasting nothing (construction is
 *    idempotent per operation, so a retry or another start returns the same bytes);
 * 3. the signed bytes are stored on the message, and then that they are being submitted;
 * 4. the write goes to the hosting relay with those bytes; from here they may be out, because
 *    the relay broadcasts them once it has stored the write;
 * 5. only when the relay answers that it holds the write (appended or existing) does the wallet
 *    authorize the bytes and broadcast them itself, and keep reconciling them.
 *
 * Until the bytes are first submitted, a change of the host's terms replaces the plan: the
 * claimed coin is given back and the write is planned again. After that the plan is final.
 *
 * Any other relay outcome (no answer, a timeout, a gateway or server error) may still have
 * stored the write and broadcast its payment, so the write is retried with the same bytes;
 * nothing is signed again, and the write is marked uncertain. A definitive refusal (`402`
 * `group_payment_*`, `403`, `404`: nothing stored, nothing broadcast) lets the claimed coin go,
 * but only when no earlier attempt was uncertain and the wallet reads the chain and finds the
 * transaction neither pending nor mined. When the chain shows it, the wallet authorizes and
 * tracks it as spent and nothing more is submitted. After an uncertain attempt the coin is
 * never released: the write is retried until the relay holds it or the chain shows its payment.
 */
import type { SealedGroupMessageEnvelope } from '@frank/cashweb/groups/group-crypto'
import { bytesToHex, hexToBytes } from '@frank/cashweb/groups/group-crypto'
import {
  assertGroupWritePayment,
  groupWriteOperationId,
  groupWritePaymentPlan,
  groupWriteSigningDigest,
  storedGroupWritePlan,
  type GroupWritePaymentPlan,
  type GroupWritePaymentWire,
  type GroupWritePolicy,
  type StoredGroupWritePayment,
} from '@frank/cashweb/groups/group-write-payment'
import { GroupWriteRefusedError } from '@frank/cashweb/groups/group-relay-client'

/** The wallet capability a group write pays through. A `WalletHandle` of `@frank/wallet`
 * satisfies it; nothing else of the wallet is needed. */
export interface GroupWritePayer {
  readonly chainIdentifier: string
  constructTransactionSet?(request: {
    readonly operationId: string
    readonly amountAtomic: bigint
    readonly kdf: (transactionIndex: number, outputIndex: number) => Uint8Array
    readonly calldata?: Uint8Array
    readonly maxRecipientTransactions?: number
    readonly independentRecipientTransactions?: boolean
  }): Promise<GroupWritePreparedPayment>
  sendTransaction?(prepared: GroupWritePreparedPayment): Promise<unknown>
  releaseTransactionSet?(operationId: string): Promise<boolean>
  observeTransactionSet?(operationId: string): Promise<boolean>
}

export interface GroupWritePreparedPayment {
  readonly operationId: string
  readonly chainIdentifier: string
  readonly bundle: readonly { readonly rawTransaction: Uint8Array }[]
  readonly otherTransactions: readonly { readonly rawTransaction: Uint8Array }[]
}

/** This wallet cannot pay the host this write is addressed to. Nothing was signed for it. */
export class GroupWritePaymentUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GroupWritePaymentUnavailableError'
  }
}

/** The relay refused a write after an earlier attempt of it had no answer, and the chain does
 * not show its payment. The payment may still land, so the coin stays claimed and the write
 * is retried with the same bytes. */
export class GroupWritePaymentUnresolvedError extends Error {
  constructor(readonly refusal: GroupWriteRefusedError) {
    super(
      `${refusal.message}, after an attempt with no answer; its payment may still land`,
    )
    this.name = 'GroupWritePaymentUnresolvedError'
  }
}

export interface DeliverPaidGroupWriteParams<Receipt> {
  readonly groupIdHex: string
  readonly envelope: SealedGroupMessageEnvelope
  /** The payment already stored on this write's message, if any. */
  readonly stored: StoredGroupWritePayment | undefined
  /** The hosting relay's current policy; read only while no bytes were submitted. */
  readonly policy: () => Promise<GroupWritePolicy>
  /** Persist `next` on this write's message, durably, before returning. */
  readonly persist: (next: StoredGroupWritePayment) => Promise<void>
  readonly wallet: GroupWritePayer | undefined
  /** Hand the write and its payment to the hosting relay. Resolves when the relay holds the
   * write; rejects with `GroupWriteRefusedError` for a definitive refusal. */
  readonly submit: (payment: GroupWritePaymentWire) => Promise<Receipt>
}

export type GroupWriteDelivery<Receipt> =
  /** The relay holds the write. `settled` is false when the wallet's own authorization and
   * broadcast failed; the caller retries the same write, which repeats this step. */
  | {
      readonly state: 'delivered'
      readonly receipt: Receipt
      readonly settled: boolean
    }
  /** The relay refused the write for good. `released`: the coin is back and nothing of the
   * payment is out. `spent`: the chain shows the payment; the wallet tracks it as spent. Either
   * way the write is final. `error` is absent when a restart finishes an earlier refusal. */
  | {
      readonly state: 'refused'
      readonly outcome: 'released' | 'spent'
      readonly error?: GroupWriteRefusedError
    }

function samePlan(
  stored: StoredGroupWritePayment,
  plan: GroupWritePaymentPlan,
) {
  return (
    stored.network === plan.network &&
    stored.destination === plan.destination &&
    stored.amountWei === plan.amountWei.toString() &&
    stored.calldata === bytesToHex(plan.calldata)
  )
}

/**
 * Deliver one paid group write. Throws, leaving the write to be retried with the same bytes,
 * when the wallet cannot pay, the relay's outcome is unknown, or a refusal came after an
 * unknown outcome and the chain does not show the payment.
 */
export async function deliverPaidGroupWrite<Receipt>(
  params: DeliverPaidGroupWriteParams<Receipt>,
): Promise<GroupWriteDelivery<Receipt>> {
  let stored = params.stored
  if (stored?.released) return { state: 'refused', outcome: 'released' }
  if (stored?.spent) return { state: 'refused', outcome: 'spent' }
  const wallet = params.wallet
  const payer =
    wallet?.constructTransactionSet &&
    wallet.sendTransaction &&
    wallet.releaseTransactionSet &&
    wallet.observeTransactionSet
      ? (wallet as Required<GroupWritePayer>)
      : undefined
  const persist = async (next: StoredGroupWritePayment) => {
    stored = next
    await params.persist(next)
  }
  // A restart between a refusal and its recorded outcome finishes the release.
  if (stored?.releasing) {
    if (!payer)
      throw new GroupWritePaymentUnavailableError(
        'This wallet cannot pay for group writes',
      )
    return finishRefusal(payer, stored, persist, undefined)
  }
  const digest = groupWriteSigningDigest(params.groupIdHex, params.envelope)
  if (!stored?.submitted) {
    const plan = groupWritePaymentPlan(
      await params.policy(),
      params.groupIdHex,
      params.envelope,
    )
    if (stored && !samePlan(stored, plan) && !payer)
      // Its coin may be claimed under the old plan; only the wallet can give it back.
      throw new GroupWritePaymentUnavailableError(
        'This wallet cannot pay for group writes',
      )
    if (!stored || !samePlan(stored, plan)) {
      // Never submitted, so nothing of an earlier plan is out: give its coin back, if it was
      // ever claimed, and plan the write again under the host's current terms.
      if (stored && payer) await payer.releaseTransactionSet(stored.operationId)
      const generation = stored ? (stored.generation ?? 0) + 1 : 0
      await persist({
        network: plan.network,
        destination: plan.destination,
        amountWei: plan.amountWei.toString(),
        calldata: bytesToHex(plan.calldata),
        operationId: groupWriteOperationId(digest, generation),
        ...(generation === 0 ? {} : { generation }),
      })
    }
  }
  if (!stored) throw new Error('Group write payment plan missing')
  if (!payer)
    throw new GroupWritePaymentUnavailableError(
      'This wallet cannot pay for group writes',
    )
  if (payer.chainIdentifier !== stored.network)
    throw new GroupWritePaymentUnavailableError(
      `The group's host takes payment on ${stored.network}, not ${payer.chainIdentifier}`,
    )
  const plan = storedGroupWritePlan(stored)
  // Signs once and claims the coin; broadcasts nothing. A replay returns the same set.
  const prepared = await payer.constructTransactionSet({
    operationId: stored.operationId,
    amountAtomic: plan.amountWei,
    kdf: () => hexToBytes(plan.destination.slice(2)),
    calldata: plan.calldata,
    maxRecipientTransactions: 1,
    independentRecipientTransactions: true,
  })
  if (
    prepared.operationId !== stored.operationId ||
    prepared.chainIdentifier !== stored.network ||
    prepared.bundle.length !== 1
  )
    throw new Error(
      'Group write payment must be one transaction on its network',
    )
  const wire = assertGroupWritePayment(plan, prepared.bundle[0]!.rawTransaction)
  if (stored.rawTransaction === undefined)
    await persist({ ...stored, rawTransaction: wire.raw_transaction })
  else if (stored.rawTransaction !== wire.raw_transaction)
    throw new Error('Group write payment differs from the one already signed')
  if (!stored.submitted) await persist({ ...stored, submitted: true })

  let receipt: Receipt
  try {
    receipt = await params.submit(wire)
  } catch (error) {
    if (!(error instanceof GroupWriteRefusedError)) {
      if (!stored.uncertain) await persist({ ...stored, uncertain: true })
      throw error
    }
    if (stored.uncertain) {
      // An attempt had no answer: the relay may have stored it then and broadcast the bytes,
      // or still may. Only the chain can tell; without it the write is retried as it is.
      if (!(await payer.observeTransactionSet(stored.operationId)))
        throw new GroupWritePaymentUnresolvedError(error)
      return trackSpent(payer, prepared, stored, persist, error)
    }
    await persist({ ...stored, releasing: true })
    return finishRefusal(payer, stored, persist, error, prepared)
  }
  // The relay holds the write: now the wallet authorizes the same bytes, broadcasts them and
  // keeps reconciling them.
  try {
    await payer.sendTransaction(prepared)
    return { state: 'delivered', receipt, settled: true }
  } catch {
    return { state: 'delivered', receipt, settled: false }
  }
}

/** Release the coin of a refused write, after the wallet has read the chain; when the chain
 * shows the payment, track it as spent instead. */
async function finishRefusal(
  payer: Required<GroupWritePayer>,
  stored: StoredGroupWritePayment,
  persist: (next: StoredGroupWritePayment) => Promise<void>,
  error: GroupWriteRefusedError | undefined,
  prepared?: GroupWritePreparedPayment,
): Promise<GroupWriteDelivery<never>> {
  if (await payer.releaseTransactionSet(stored.operationId)) {
    const { releasing: _, ...rest } = stored
    await persist({ ...rest, released: true })
    return error
      ? { state: 'refused', outcome: 'released', error }
      : { state: 'refused', outcome: 'released' }
  }
  const set =
    prepared ??
    (await payer.constructTransactionSet({
      operationId: stored.operationId,
      amountAtomic: BigInt(stored.amountWei),
      kdf: () => hexToBytes(stored.destination.slice(2)),
      calldata: hexToBytes(stored.calldata),
      maxRecipientTransactions: 1,
      independentRecipientTransactions: true,
    }))
  return trackSpent(payer, set, stored, persist, error)
}

/** The chain shows a refused write's payment: authorize the set so the wallet reconciles it
 * to its mined state, and record the write as final. */
async function trackSpent(
  payer: Required<GroupWritePayer>,
  prepared: GroupWritePreparedPayment,
  stored: StoredGroupWritePayment,
  persist: (next: StoredGroupWritePayment) => Promise<void>,
  error: GroupWriteRefusedError | undefined,
): Promise<GroupWriteDelivery<never>> {
  await payer.sendTransaction(prepared)
  const { releasing: _, ...rest } = stored
  await persist({ ...rest, spent: true })
  return error
    ? { state: 'refused', outcome: 'spent', error }
    : { state: 'refused', outcome: 'spent' }
}

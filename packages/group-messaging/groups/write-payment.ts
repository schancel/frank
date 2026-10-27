/**
 * Paying for one group write: the writer's half of `docs/protocol/groups/shared-mailbox-baseline.md`
 * "Paid group writes". Headless; the host injects the wallet capability, the relay's policy,
 * the relay submission and the durable message record.
 *
 * Order (persist, submit to the relay, then broadcast), each step durable before the next:
 * 1. the plan (payee, price, commitment calldata) and the wallet operation that pays it are
 *    stored on the message;
 * 2. the wallet signs the transaction set for that plan, with exactly one payment, and claims
 *    its coin, broadcasting nothing (construction is idempotent per operation, so a retry or
 *    another start returns the same bytes). The set's own self-sends (change, splits) on the
 *    payment's account are shuffled with it in random order, so the payment may sit a few nonces
 *    above the account's pending one; only the payment goes to the relay;
 * 3. the signed bytes are stored on the message, and then that they are being submitted;
 * 4. the write goes to the hosting relay with those bytes; from here they may be out, because
 *    the relay broadcasts them once it has stored the write;
 * 5. only when the relay answers that it holds the write (appended or existing) does the wallet
 *    authorize the set and broadcast all of it in nonce order, and keep reconciling it.
 *
 * Until the bytes are first submitted, a change of the host's terms replaces the plan: the
 * claimed coin is given back and the write is planned again. After that the plan is final.
 * A plan never pays more than the price the writer was shown (`maxPriceWei`): a higher price
 * is refused before anything is planned, claimed or changed (`GroupWritePriceChangedError`),
 * so the writer sees the new price and sends again at it; this holds after a restart too.
 *
 * A host answer that it checked the payment and stored nothing yet (`503 group_payment_*`: the
 * node does not show the payment can land yet, or cannot be read) leaves the write pending; it
 * is retried with the same bytes. Any other outcome without a refusal (no answer, a timeout, a
 * gateway or server error) may still have stored the write and broadcast its payment, so the
 * write is retried with the same bytes; nothing is signed again, and the write is marked
 * uncertain. A definitive refusal (`402 group_payment_*`, `403`, `404`: nothing stored, nothing
 * broadcast) lets the claimed coin go, but only when no earlier attempt was uncertain and the
 * wallet reads the chain and finds no member pending or mined. After an uncertain attempt, a
 * host's `402 underpaid` for the same bytes is definitive too: the host answers a write it
 * accepted with its receipt before it looks at the price, and broadcasts a payment only after
 * accepting its write, so that answer says no attempt was ever accepted. When the chain shows the
 * payment, the funds have moved: the wallet authorizes and tracks the set (`spent`) and the write
 * stays pending, retried with the same bytes, since a paid write is still owed. After an
 * uncertain attempt the coin is never released.
 *
 * A write the host keeps deferring waits for funds or the chain. The user may discard it
 * (`discardPaidGroupWrite`): the host answered every attempt that it stored and handed over
 * nothing, so the coin goes back once the wallet reads the chain and finds no member pending or
 * mined. A discard is refused, keeping the coin, after an attempt without an answer or once the
 * chain shows the payment.
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
import {
  GroupWriteDeferredError,
  GroupWriteRefusedError,
} from '@frank/cashweb/groups/group-relay-client'

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

/** The host now prices the group above what the writer was shown. Nothing was planned, claimed
 * or changed for that price; the writer is shown `priceWei` and may send again. */
export class GroupWritePriceChangedError extends Error {
  constructor(readonly priceWei: bigint, readonly shownPriceWei: bigint) {
    super(
      `The group's price changed to ${priceWei} wei (shown: ${shownPriceWei} wei)`,
    )
    this.name = 'GroupWritePriceChangedError'
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

/** The relay refused a write, but the chain shows its payment: the funds have moved. The wallet
 * tracks the payment to its mined state, and the write is retried with the same bytes, since
 * the payment is owed its write. */
export class GroupWritePaidRefusalError extends Error {
  constructor(readonly refusal: GroupWriteRefusedError | undefined) {
    super(
      refusal
        ? `The write was refused after its payment was sent: ${refusal.message}`
        : 'The write was refused after its payment was sent',
    )
    this.name = 'GroupWritePaidRefusalError'
  }
}

export interface DeliverPaidGroupWriteParams<Receipt> {
  readonly groupIdHex: string
  readonly envelope: SealedGroupMessageEnvelope
  /** The payment already stored on this write's message, if any. */
  readonly stored: StoredGroupWritePayment | undefined
  /** The hosting relay's current policy; read only while no bytes were submitted. */
  readonly policy: () => Promise<GroupWritePolicy>
  /** The most this write may pay: the price the writer was shown when sending it. Absent only
   * for a writer with no one to show a price to (a headless tool). */
  readonly maxPriceWei?: bigint
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
  /** The relay refused the write for good, and the coin is back: nothing of the payment is
   * out. Final. `error` is absent when a restart finishes an earlier refusal. */
  | {
      readonly state: 'refused'
      readonly outcome: 'released'
      readonly error?: GroupWriteRefusedError
    }
  /** The user discarded the write and its coin is back; it is never sent. Final. */
  | { readonly state: 'discarded' }

/** Why a discard kept the write and its coin. */
export type GroupWriteDiscardRefusal =
  /** An attempt had no answer from the relay (it may have stored the write and broadcast the
   * payment), or the wallet cannot tell that its payment cannot land: it may still land. */
  | 'uncertain'
  /** The payment went out: the chain shows it pending or mined, or the wallet sent it. */
  | 'paid'
  /** This wallet cannot read the chain for this payment, or pays on another network. */
  | 'unavailable'

export type GroupWriteDiscard =
  | { readonly state: 'discarded' }
  | { readonly state: 'kept'; readonly reason: GroupWriteDiscardRefusal }

export interface DiscardPaidGroupWriteParams {
  /** The payment stored on this write's message, if any. */
  readonly stored: StoredGroupWritePayment | undefined
  /** Persist `next` on this write's message, durably, before returning. */
  readonly persist: (next: StoredGroupWritePayment) => Promise<void>
  readonly wallet: GroupWritePayer | undefined
}

/**
 * Discard a write that is not delivered, at the user's request. The coin goes back only when no
 * attempt of the write was without an answer (every answer said the relay stored and handed over
 * nothing) and the wallet, reading the chain first, finds no member of its set pending or mined.
 * Otherwise the write and its coin are kept, with the reason. Repeating a discard, or a restart in
 * the middle of one, gives the same outcome and releases nothing twice. The caller must not call
 * it for a write the relay already holds.
 */
export async function discardPaidGroupWrite(
  params: DiscardPaidGroupWriteParams,
): Promise<GroupWriteDiscard> {
  const stored = params.stored
  // Never planned: nothing was signed or claimed for it.
  if (!stored) return { state: 'discarded' }
  if (stored.discarded) return { state: 'discarded' }
  if (stored.released) {
    // Refused for good earlier, and its coin is already back.
    await params.persist({ ...stored, discarded: true })
    return { state: 'discarded' }
  }
  if (stored.spent) return { state: 'kept', reason: 'paid' }
  if (stored.uncertain) return { state: 'kept', reason: 'uncertain' }
  const wallet = params.wallet
  if (
    !wallet?.releaseTransactionSet ||
    wallet.chainIdentifier !== stored.network
  )
    return { state: 'kept', reason: 'unavailable' }
  const discarding: StoredGroupWritePayment = stored.discarding
    ? stored
    : { ...stored, discarding: true }
  if (discarding !== stored) await params.persist(discarding)
  const { discarding: _, ...rest } = discarding
  // The wallet reads the chain for every member first and keeps any the node shows.
  if (
    (await wallet.releaseTransactionSet(stored.operationId)) ||
    // `false` with no stored bytes is a plan whose set was never constructed.
    stored.rawTransaction === undefined
  ) {
    await params.persist({ ...rest, released: true, discarded: true })
    return { state: 'discarded' }
  }
  await params.persist(rest)
  // The wallet kept the set: either the chain shows a member, or the wallet cannot tell that
  // none can land (for example it authorized the set, or a member's nonce state is unknown).
  const onChain = await wallet.observeTransactionSet?.(stored.operationId)
  return { state: 'kept', reason: onChain ? 'paid' : 'uncertain' }
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
 * when the wallet cannot pay, the host defers the write, the relay's outcome is unknown, a
 * refusal came after an unknown outcome and the chain does not show the payment
 * (`GroupWritePaymentUnresolvedError`), or a refusal came while the chain shows the payment
 * (`GroupWritePaidRefusalError`).
 */
export async function deliverPaidGroupWrite<Receipt>(
  params: DeliverPaidGroupWriteParams<Receipt>,
): Promise<GroupWriteDelivery<Receipt>> {
  let stored = params.stored
  if (stored?.discarded) return { state: 'discarded' }
  if (stored?.released) return { state: 'refused', outcome: 'released' }
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
  // A restart in the middle of a discard finishes it; a discard the chain refuses leaves the
  // write to be sent as before.
  if (stored?.discarding) {
    const discard = await discardPaidGroupWrite({
      stored,
      persist,
      wallet,
    })
    if (discard.state === 'discarded') return { state: 'discarded' }
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
    const policy = await params.policy()
    // Never more than the writer saw: refused before any plan, claim or release.
    if (
      params.maxPriceWei !== undefined &&
      policy.priceWei > params.maxPriceWei
    )
      throw new GroupWritePriceChangedError(policy.priceWei, params.maxPriceWei)
    const plan = groupWritePaymentPlan(
      policy,
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
      if (
        stored &&
        payer &&
        !(await payer.releaseTransactionSet(stored.operationId)) &&
        stored.rawTransaction !== undefined
      )
        // The wallet keeps a set whose bytes were stored: it is not released, so it is not
        // replaced. `false` with no stored bytes is a plan whose set was never constructed.
        throw new Error('The earlier group write payment could not be released')
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
    // The host checked the payment and stored nothing: retried as it is.
    if (error instanceof GroupWriteDeferredError) throw error
    if (!(error instanceof GroupWriteRefusedError)) {
      if (!stored.uncertain) await persist({ ...stored, uncertain: true })
      throw error
    }
    // Already out and tracked: the write is owed, so it is retried as it is.
    if (stored.spent) throw new GroupWritePaidRefusalError(error)
    // `underpaid` for these exact bytes: the host checked for an accepted receipt first and
    // found none, so no attempt was accepted, and an unaccepted write's payment is never
    // broadcast by the host. Definitive, like a refusal with no unknown attempt.
    const neverAccepted =
      error.status === 402 &&
      error.code === 'group_payment_invalid' &&
      error.reason === 'underpaid'
    if (stored.uncertain && !neverAccepted) {
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
    }))
  return trackSpent(payer, set, stored, persist, error)
}

/** The chain shows a refused write's payment: authorize the set so the wallet reconciles it
 * to its mined state, record that, and leave the write to be retried with the same bytes. */
async function trackSpent(
  payer: Required<GroupWritePayer>,
  prepared: GroupWritePreparedPayment,
  stored: StoredGroupWritePayment,
  persist: (next: StoredGroupWritePayment) => Promise<void>,
  error: GroupWriteRefusedError | undefined,
): Promise<never> {
  await payer.sendTransaction(prepared)
  const { releasing: _, ...rest } = stored
  await persist({ ...rest, spent: true })
  throw new GroupWritePaidRefusalError(error)
}

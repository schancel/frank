import assert from 'assert'
import {
  ContactPaymentReleasedError,
  DirectMessageAlreadyAttemptedError,
} from '@frank/wallet/chain'
import { isDirectMessageNotAttempted } from '@frank/wallet/chain/active-chain'
import { MonadStampPendingAttemptError } from '@frank/wallet/evm-stamp-client'
import { decideOutgoingRetry } from './outgoing-retry-policy'
import type {
  DirectMessageAttemptStatus,
  DirectMessagePreparationProgress,
  DirectMessageSendResult,
  DirectMessageClient,
  WalletHandle,
} from '@frank/wallet/chain'
import type {
  FinancialEnvelopeBinding,
  MessageStore,
} from '@frank/cashweb/relay/storage/storage'
import type {
  Message,
  MessageItem,
  OutgoingDelivery,
  OutgoingFailureReason,
  OutgoingFinancialOperation,
} from '@frank/cashweb/types/messages'
import type {
  RecoveryMessage,
  RecoveryConversation,
  OutgoingRecoveryPorts,
} from './outgoing-recovery'

export type OutgoingOutcome =
  /** Delivered; the local copy is now keyed by its real payload hash. */
  | { state: 'sent'; payloadDigest: string }
  /** Payment not yet confirmed. The same payment is re-sent automatically; nothing new is paid. */
  | { state: 'payment-pending' }
  /** Failed; kept in the conversation with a manual Retry and Discard. */
  | { state: 'failed'; reason: OutgoingFailureReason }
  /** A retry could pay a second time; the caller must ask the user, then retry with
   * `confirmed: true`. */
  | { state: 'needs-confirmation'; reason: OutgoingFailureReason }
  /** This message is already being worked on, or no longer exists. */
  | { state: 'busy' }

export interface ExecutionMessage extends RecoveryMessage {
  items: MessageItem[]
  conversationId?: string
  stampValueWei?: bigint
  stampIsDeliveryFee?: Message['stampIsDeliveryFee']
  applicationAuthorization?: Message['applicationAuthorization']
}
export interface ExecutionContext {
  chainIdentifier: string
  current(): boolean
  parseAddress(
    address: string,
  ): Parameters<DirectMessageClient['send']>[0]['recipient'] | undefined
  directMessages: Pick<
    DirectMessageClient,
    | 'send'
    | 'reconcileAttempts'
    | 'endOf'
    | 'attemptOf'
    | 'unattributedAttempts'
    | 'resolveUnattributedAttempts'
    | 'minimumStamp'
  >
}
export interface OutgoingExecutionPorts<M extends ExecutionMessage>
  extends Pick<
    OutgoingRecoveryPorts<M>,
    | 'inflight'
    | 'withLock'
    | 'message'
    | 'owns'
    | 'resultAssertion'
    | 'isStale'
    | 'refresh'
    | 'messageId'
  > {
  messageEntries(): Array<[string, M | undefined]>
  conversations(): Array<RecoveryConversation<M> | undefined>
  captureMessagingContext(): ExecutionContext
  captureFinancialScope(
    wallet: WalletHandle,
    message: M,
    chainIdentifier: string,
    current: () => boolean,
    stillCurrent: () => boolean,
  ): { accountId(): string; assertCurrent(): void }
  captureFinancial(
    wallet: WalletHandle,
    references: readonly OutgoingFinancialOperation[],
  ): Promise<{
    paymentOperationId?: string
    expose(digest: string): Promise<void>
    submit(): Promise<void>
  }>
  readFinancialBootstrapAuthority(
    id: string,
    digest: string,
    sealedId: string,
    message: M,
    address: string,
    references: readonly OutgoingFinancialOperation[],
  ): Promise<{
    paid: boolean
    financialOperations: OutgoingFinancialOperation[]
  }>
  financialRepository(): Promise<Pick<MessageStore, 'bindFinancialEnvelope'>>
  captureApplication(
    wallet: WalletHandle,
    address: string,
    message: M,
  ): Promise<{ stampValue: bigint; assertCurrent(): void } | undefined>
  setState(
    address: string,
    id: string,
    status: 'pending' | 'payment-pending' | 'error',
    delivery: OutgoingDelivery,
    options?: { strict?: boolean; assertCurrent?: () => void },
  ): Promise<void>
  /** Takes `digest` off the message, which goes back to pending, durably. Only for an attempt
   * the wallet ended for funds tied up before anything of it was signed or handed out
   * (`DirectMessageEnd` `funds-tied-up`): it stands for no payment. Refuses when the message
   * records another attempt. */
  forgetTiedUpAttempt(
    address: string,
    id: string,
    digest: string,
    options: { assertCurrent: () => void },
  ): Promise<void>
  confirm(params: {
    address: string
    id: string
    payloadDigest: string
    stampValueWei?: bigint
    stampPayments?: DirectMessageSendResult['stampPayments']
    assertCurrent?: () => void
  }): Promise<void>
  applyAttemptStatus(params: {
    address: string
    id: string
    digest: string
    status: DirectMessageAttemptStatus
    assertCurrent: () => void
  }): Promise<'sent' | 'live' | 'dead' | 'unknown' | 'stale'>
  reconcileOutgoing(params: {
    wallet: WalletHandle
  }): Promise<{ pending: number }>
  presentation: {
    subject(conversationId: string | undefined): string | undefined
    subjectCarried(conversationId: string, subject: string): void
    wakeupItems(
      wallet: WalletHandle,
      address: string,
      items: MessageItem[],
    ): MessageItem[]
    cancellable(id: string): { signal: AbortSignal; done(): void }
    progress(id: string, progress: DirectMessagePreparationProgress): void
    clearProgress(id: string): void
    endWaiting(id: string): void
  }
  waitForMessagingReady?: (timeoutMs: number) => Promise<boolean>
  delay(ms: number): Promise<void>
  classifySendFailure(
    error: unknown,
    ownDigest: string | undefined,
  ): { reason: OutgoingFailureReason; keepDigest?: string }
  errorDetail(error: unknown): string
  stripReleasedPayments(message: M): void
  log: Pick<Console, 'warn' | 'info' | 'error'>
}

/** Host execution policy over existing owners; no independent wallet/session or message state. */
export function createOutgoingExecution<M extends ExecutionMessage>(
  ports: OutgoingExecutionPorts<M>,
) {
  const execution = {
    async runOutgoing({
      wallet,
      address,
      id,
      manual,
      automatic = false,
      confirmed = false,
      lockHeld = false,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      id: string
      manual: boolean
      /** A retry nobody clicked (see `retryOutgoing`): it may only build a message's first payment. */
      automatic?: boolean
      confirmed?: boolean
      /** The caller already holds this message's lock (see `sendMessage`). */
      lockHeld?: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const message = ports.message(id)
      if (ports.inflight.has(id) || !message || !ports.owns(wallet, message)) {
        return { state: 'busy' }
      }
      ports.inflight.add(id)
      let recoveredOthers = false
      try {
        // Another tab of this profile may be sending this very message (its row is saved before
        // the send starts, and this tab's copy may call it interrupted). Its lock is held for the
        // whole send: then this tab leaves the message as it is and pays nothing.
        const run = () =>
          execution.runOutgoingExclusive({
            wallet,
            address,
            id,
            manual,
            automatic: automatic && manual,
            confirmed: confirmed && !automatic,
            onPreparationProgress,
          })
        const locked = lockHeld
          ? { result: await run() }
          : await ports.withLock(id, run)
        if (!locked) return { state: 'busy' }
        const outcome = locked.result
        recoveredOthers =
          outcome.state === 'failed' && outcome.reason === 'recovered'
        if (outcome.state === 'sent') {
          const allChats = ports.conversations()
          const hasQueued = allChats.some(chat =>
            chat?.messages?.some(
              m =>
                m.outbound &&
                m.payloadDigest !== id &&
                m.status === 'payment-pending' &&
                m.delivery?.attemptDigest === undefined &&
                ports.owns(wallet, m),
            ),
          )
          if (hasQueued) void ports.reconcileOutgoing({ wallet })
        }
        return outcome
      } catch (error) {
        if (ports.isStale(error)) return { state: 'busy' }
        throw error
      } finally {
        ports.inflight.delete(id)
        // Another attempt was just recovered: settle its message now instead of at the next tick.
        if (recoveredOthers) void ports.reconcileOutgoing({ wallet })
      }
    },
    async runOutgoingExclusive({
      wallet,
      address,
      id,
      manual,
      automatic,
      confirmed,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      id: string
      manual: boolean
      automatic: boolean
      confirmed: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const messagingChain = ports.captureMessagingContext()
      const contextCurrent = () => messagingChain.current()
      // A Retry (clicked or automatic) acts on this tab's copy of the message, which can be stale:
      // another tab may have sent it (and removed its row) or recorded a payment for it since
      // this tab loaded. Read the durable row first, under the lock, and never act on an old copy.
      if (manual) {
        const fresh = await ports.refresh(address, id)
        if (!contextCurrent() || fresh === 'gone' || fresh === 'unreadable')
          return { state: 'busy' }
        if (
          fresh === 'changed' &&
          ports.message(id)?.delivery?.attemptDigest === undefined
        )
          return { state: 'busy' }
        // 'changed' with a recorded payment now: go on, and settle that payment below.
      }
      const message = ports.message(id)
      // Read again under the lock: the message may have changed while it was awaited.
      if (!message || !ports.owns(wallet, message)) return { state: 'busy' }
      if (automatic && (!message.outbound || message.status !== 'error'))
        return { state: 'busy' }
      const recipient = messagingChain.parseAddress(address)
      assert(recipient, `Invalid recipient address: ${address}`)
      const previous = message.delivery
      const digest = previous?.attemptDigest
      const stillCurrent = () =>
        ports.message(id) === message && ports.owns(wallet, message)

      const financialScope = ports.captureFinancialScope(
        wallet,
        message,
        messagingChain.chainIdentifier,
        contextCurrent,
        stillCurrent,
      )
      const sealedMessageId = message.sealedMessageId
      const financialReferences = message.financialOperations?.map(
        reference => ({ ...reference }),
      )
      const financial = financialReferences?.length
        ? await ports.captureFinancial(wallet, financialReferences)
        : undefined
      if (financial && !sealedMessageId)
        throw new Error('Financial message has no durable sealed identity')
      const assertFinancialCurrent = () => financialScope.assertCurrent()
      let financialEnvelope: FinancialEnvelopeBinding | undefined
      if (financial) {
        assertFinancialCurrent()
        financialEnvelope = {
          version: 1,
          phase: 'pending',
          accountId: financialScope.accountId(),
          messagingChainIdentifier: messagingChain.chainIdentifier,
          messageId: sealedMessageId!,
          financialOperations: financialReferences!,
        }
        if (digest !== undefined) {
          const authority = await ports.readFinancialBootstrapAuthority(
            id,
            digest,
            sealedMessageId!,
            message,
            address,
            financialReferences!,
          )
          assertFinancialCurrent()
          const original = await messagingChain.directMessages.attemptOf?.({
            wallet,
            messageId: sealedMessageId!,
          })
          assertFinancialCurrent()
          if (
            original?.payloadDigest !== digest ||
            original.paid !== authority.paid
          )
            throw new Error(
              'Financial envelope original association unavailable',
            )
          financialEnvelope = {
            ...financialEnvelope,
            phase: 'bound',
            payloadDigest: digest,
            financialOperations: authority.financialOperations,
          }
        }
        const repository = await ports.financialRepository()
        assertFinancialCurrent()
        await repository.bindFinancialEnvelope({
          version: financialEnvelope.version,
          phase: 'pending',
          accountId: financialEnvelope.accountId,
          messagingChainIdentifier: financialEnvelope.messagingChainIdentifier,
          messageId: financialEnvelope.messageId,
          financialOperations: financialEnvelope.financialOperations,
        })
        assertFinancialCurrent()
        if (financialEnvelope.phase === 'bound') {
          await repository.bindFinancialEnvelope(financialEnvelope)
          assertFinancialCurrent()
        }
      }
      const envelopeDurabilityCallback = (assertCurrent?: () => void) =>
        financial &&
        (async (attemptDigest: string) => {
          const assertEnvelopeCurrent = () => {
            assertCurrent?.()
            assertFinancialCurrent()
          }
          await ports.setState(
            address,
            id,
            'pending',
            { attemptDigest },
            { strict: true, assertCurrent: assertEnvelopeCurrent },
          )
          assertEnvelopeCurrent()
          const repository = await ports.financialRepository()
          assertEnvelopeCurrent()
          await repository.bindFinancialEnvelope({
            ...financialEnvelope!,
            phase: 'bound',
            payloadDigest: attemptDigest,
          })
          assertEnvelopeCurrent()
          await financial.expose(attemptDigest)
        })
      const onEnvelopeDurable = envelopeDurabilityCallback()
      // Free envelopes have their own durable replay owner; paid reconciliation cannot find them.
      const replayFreeFinancial = !!financial && message.stampValueWei === 0n

      // 1. An earlier payment attempt exists: ask what became of it BEFORE anything else.
      if (digest !== undefined && !replayFreeFinancial) {
        const assertCurrent = ports.resultAssertion(
          wallet,
          id,
          message,
          digest,
          contextCurrent,
        )
        try {
          assertCurrent()
          let statuses: Record<string, DirectMessageAttemptStatus>
          try {
            statuses = await messagingChain.directMessages.reconcileAttempts({
              wallet,
              payloadDigests: [digest],
              ...(financial ? { messageIds: [sealedMessageId!] } : {}),
              maxPutAttempts: manual ? 3 : 1,
              ...(financial
                ? {
                    onEnvelopeDurable:
                      envelopeDurabilityCallback(assertCurrent),
                  }
                : {}),
            })
          } catch (error) {
            assertCurrent()
            // Cannot tell. Keep the attempt on the message; never guess in favour of a new payment.
            ports.log.warn(
              'could not reconcile the earlier payment attempt',
              error,
            )
            if (manual) {
              await ports.setState(
                address,
                id,
                'error',
                {
                  attemptDigest: digest,
                  failureReason: 'error',
                  detail: ports.errorDetail(error),
                },
                { assertCurrent },
              )
              return { state: 'failed', reason: 'error' }
            }
            return { state: 'payment-pending' }
          }
          assertCurrent()
          const status = statuses[digest] ?? 'unknown'
          if (status === 'delivered' && financial) {
            try {
              await financial.submit()
            } catch (error) {
              // Delivered, but its payment is not on chain yet: never shown as sent. The next
              // reconciliation submits the same stored signed bytes again.
              ports.log.warn('Financial submission remains pending', error)
              await ports.setState(
                address,
                id,
                'payment-pending',
                {
                  attemptDigest: digest,
                },
                { assertCurrent },
              )
              return { state: 'payment-pending' }
            }
          }
          const applied = await ports.applyAttemptStatus({
            address,
            id,
            status,
            digest,
            assertCurrent,
          })
          if (applied === 'stale') return { state: 'busy' }
          if (applied === 'sent') {
            const confirmed = ports.message(digest)
            return confirmed && ports.owns(wallet, confirmed)
              ? { state: 'sent', payloadDigest: digest }
              : { state: 'busy' }
          }
          if (!stillCurrent()) return { state: 'busy' }
          if (applied === 'live') return { state: 'payment-pending' }
          // A relay terminal status or an exhausted local attempt is not financial nonexecution
          // proof. Even a confirmed Retry must settle the original authorized payment.
          // Why the wallet says it ended: only an end the relay gave is "rejected" (the same
          // mapping as `failureOfEnd` in outgoing-recovery.ts).
          const end =
            applied === 'dead'
              ? await messagingChain.directMessages
                  .endOf?.({ wallet, payloadDigest: digest })
                  .catch(() => undefined)
              : undefined
          const failureReason: OutgoingFailureReason =
            applied !== 'dead'
              ? 'unverified'
              : end?.reason === 'fee-exceeded'
              ? 'fee-exceeded'
              : end?.reason === 'discarded'
              ? 'error'
              : end?.reason === 'funds-tied-up'
              ? 'funds-in-pending-send'
              : end?.reason === 'payment-taken'
              ? 'payment-taken'
              : 'rejected'
          assertCurrent()
          // Ended by the wallet because its money was still in an earlier send, before anything
          // of it was signed or handed out: it stands for no payment, and the user's Retry sends
          // it again under the same message ID (owner ruling 2026-10-26). Only a click does; a
          // message carrying a payment of its own keeps that payment's attempt. Such a Retry
          // takes the ended attempt off the message and goes on to step 2 below.
          if (
            end?.reason === 'funds-tied-up' &&
            manual &&
            !automatic &&
            !financial
          ) {
            await ports.forgetTiedUpAttempt(address, id, digest, {
              assertCurrent,
            })
          } else {
            await ports.setState(
              address,
              id,
              'error',
              {
                attemptDigest: digest,
                failureReason,
                detail:
                  end?.reason === 'funds-tied-up' && end.tiedUpWei !== undefined
                    ? end.tiedUpWei.toString()
                    : previous?.detail,
              },
              { assertCurrent },
            )
            return { state: 'failed', reason: failureReason }
          }
        } catch (error) {
          if (ports.isStale(error)) return { state: 'busy' }
          throw error
        }
      } else if (
        digest === undefined &&
        automatic &&
        previous?.failureReason !== 'interrupted'
      ) {
        // No attempt recorded and not cut off mid-send: an earlier payment for it was given up
        // (dead) or the send failed for a reason the user must see. Only a click sends it again.
        return { state: 'failed', reason: previous?.failureReason ?? 'error' }
      } else if (
        digest === undefined &&
        manual &&
        !confirmed &&
        previous?.failureReason === 'recovered'
      ) {
        return { state: 'needs-confirmation', reason: 'recovered' }
      } else if (
        digest === undefined &&
        manual &&
        previous?.failureReason === 'interrupted'
      ) {
        // No attempt is recorded on this message, but the app stopped mid-send: the wallet may
        // hold (or already have resumed) a payment nobody points at. Do not pay again unless
        // there is provably none, or the user says so.
        const known = new Set<string>()
        for (const [key, other] of ports.messageEntries()) {
          if (other && !key.startsWith('pending:')) known.add(key)
          const attempt = other?.delivery?.attemptDigest
          if (attempt !== undefined) known.add(attempt)
        }
        let orphans: string[] | undefined
        try {
          orphans = await messagingChain.directMessages.unattributedAttempts({
            wallet,
            knownDigests: [...known],
          })
        } catch (error) {
          ports.log.warn('could not check for an unattributed payment', error)
        }
        if (!confirmed && (orphans === undefined || orphans.length > 0)) {
          // Leave the message 'interrupted': every unconfirmed Retry must hit this check again,
          // in this session and after a reload. Only the user's answer below ends that.
          return { state: 'needs-confirmation', reason: 'unverified' }
        }
        if (orphans !== undefined && orphans.length > 0) {
          // The user chose to pay again. Save that answer for the payments it was about, so they
          // stop blocking later retries. If it cannot be saved, the wallet keeps reporting them
          // and the next interrupted message asks again; that never pays without a prompt.
          try {
            await messagingChain.directMessages.resolveUnattributedAttempts({
              wallet,
              payloadDigests: orphans,
            })
          } catch (error) {
            ports.log.warn(
              'could not save the answer for an unattributed payment',
              error,
            )
          }
          if (!stillCurrent()) return { state: 'busy' }
        }
      }

      // All financial first-send projections share the same serialized ownership guard.
      // Nonfinancial callers retain their existing projection behavior.
      const setFirstSendState = (
        status: 'pending' | 'payment-pending' | 'error',
        delivery: OutgoingDelivery,
        options: { strict?: boolean } = {},
      ) =>
        ports.setState(address, id, status, delivery, {
          ...options,
          ...(financial ? { assertCurrent: assertFinancialCurrent } : {}),
        })

      // 2. Build and send a new payment set.
      if (!stillCurrent()) return { state: 'busy' }
      if (
        id.startsWith('pending:application:') &&
        !message.applicationAuthorization
      )
        throw new Error('Application delivery authorization reference missing')
      const application = await ports.captureApplication(
        wallet,
        address,
        message,
      )
      if (!stillCurrent()) return { state: 'busy' }
      application?.assertCurrent()
      // A manual Retry may raise to the current minimum only a stamp that is just the delivery
      // fee the composer chose (`stampIsDeliveryFee`): that was the sender's intent. An amount
      // the sender typed, or one the message states (a bet, a purchase, a payment), is the
      // message's meaning: its Retry sends that same amount, and fails again below the minimum
      // until the sender makes a new one. A retained application authorization fixes its stamp
      // for every retry, including interrupted automatic sends.
      if (
        !application &&
        manual &&
        !automatic &&
        message.stampIsDeliveryFee === true &&
        message.delivery?.failureReason === 'stamp-below-fee' &&
        message.stampValueWei !== undefined
      ) {
        const minimum = await messagingChain.directMessages
          .minimumStamp?.({ wallet })
          .catch(() => undefined)
        if (minimum !== undefined && minimum > message.stampValueWei)
          message.stampValueWei = minimum
      }
      // Keep an already queued message queued while it retries: toggling through pending
      // would reset the background backoff and make restart mistake it for a cut-off send.
      await setFirstSendState(
        message.status === 'payment-pending' ? 'payment-pending' : 'pending',
        // A queued message keeps saying why it is queued while it tries again.
        message.status === 'payment-pending' &&
          message.delivery?.attemptDigest === undefined &&
          message.delivery?.failureReason === 'unreachable'
          ? { failureReason: 'unreachable' }
          : {},
      )
      if (!stillCurrent()) return { state: 'busy' }
      let ownDigest: string | undefined
      let result: DirectMessageSendResult | undefined
      let lastSendError: unknown
      let allCallsUnattempted = true
      const maxSendAttempts = 3

      for (let sendAttempt = 1; sendAttempt <= maxSendAttempts; sendAttempt++) {
        if (!stillCurrent()) return { state: 'busy' }
        const cancellable = ports.presentation.cancellable(id)
        try {
          // The subject rides only on the first message of a conversation that has one and on
          // the first message after a rename; ordinary messages omit it.
          const subject = ports.presentation.subject(message.conversationId)
          const wireItems = ports.presentation.wakeupItems(
            wallet,
            address,
            message.items,
          )
          application?.assertCurrent()
          if (financial) assertFinancialCurrent()
          result = await messagingChain.directMessages.send({
            wallet,
            recipient,
            // Sealed: the relay learns the recipient, not who wrote to them. The wallet sends
            // this device's other frontends a note to self in place of the relay's outbox row.
            sealedSender: true,
            // One ID for this message, whatever attempt this is: the wallet makes one payment
            // per ID, ever, and answers a repeat with the attempt it already holds.
            messageId: message.sealedMessageId ?? ports.messageId(id),
            ...(financial?.paymentOperationId === undefined
              ? {}
              : { paymentOperationId: financial.paymentOperationId }),
            ...(onEnvelopeDurable ? { onEnvelopeDurable } : {}),
            conversationId: message.conversationId,
            ...(subject === undefined ? {} : { conversationName: subject }),
            items: wireItems,
            ...(message.stampValueWei === undefined
              ? {}
              : {
                  stampValue: application?.stampValue ?? message.stampValueWei,
                }),
            // Deleting the bubble while its send still waits cancels the send: nothing was
            // signed for it.
            signal: cancellable.signal,
            onPreparationProgress: progress => {
              // Its payment waits for the previous one to be mined, or the chain cannot be
              // reached and the send is queued: the bubble says which.
              ports.presentation.progress(id, progress)
              onPreparationProgress?.(progress)
            },
            onAttemptCreated: async attemptDigest => {
              ports.presentation.clearProgress(id)
              ownDigest = attemptDigest
              // Strict: this write must be durable before the relay sees any byte of the set.
              // If it fails, the send stops before any relay request. The wallet does NOT roll the
              // attempt back: its payment intent stays journaled, later sends wait behind it, and
              // reconciliation finishes and delivers those same bytes. `ownDigest` is therefore
              // kept on the message by the failure path below whenever that later write succeeds.
              await setFirstSendState(
                'pending',
                { attemptDigest },
                { strict: true },
              )
            },
          })
          if (subject !== undefined && message.conversationId !== undefined) {
            ports.presentation.subjectCarried(message.conversationId, subject)
          }
          break
        } catch (error) {
          lastSendError = error
          allCallsUnattempted &&=
            ownDigest === undefined && isDirectMessageNotAttempted(error)
          cancellable.done()
          if (financial) {
            try {
              assertFinancialCurrent()
            } catch {
              // A rejected stale callback must not label the replacement row as failed.
              return { state: 'busy' }
            }
          }
          if (
            error instanceof DirectMessageAlreadyAttemptedError ||
            (error instanceof Error &&
              error.name === 'DirectMessageAlreadyAttemptedError')
          ) {
            // The wallet already holds this message's one attempt (this row had not learned
            // its digest: the app stopped between the wallet's record and this row's). Nothing
            // new was paid or sent. The row now points at that attempt and the reconciliation
            // finishes it with the same bytes.
            const attemptDigest = (error as DirectMessageAlreadyAttemptedError)
              .payloadDigest
            ports.presentation.endWaiting(id)
            await setFirstSendState('payment-pending', {
              attemptDigest,
            })
            return { state: 'payment-pending' }
          }
          if (error instanceof MonadStampPendingAttemptError) {
            // Own payment set journaled but not yet confirmed: keep it, keep re-sending the same
            // bytes. Without an own set, an earlier attempt is still pending and this message has
            // not been paid for yet; it is sent once that clears.
            ports.log.info('[sendDirectMessage pending]:', error)
            await setFirstSendState(
              'payment-pending',
              ownDigest === undefined
                ? {}
                : { attemptDigest: ownDigest, live: true },
            )
            return { state: 'payment-pending' }
          }

          const retry = decideOutgoingRetry(error, {
            ownDigest,
            sendAttempt,
            maxSendAttempts,
            allCallsUnattempted,
            isCurrent: stillCurrent,
          })
          if (retry.kind === 'retry-messaging') {
            const ready =
              typeof ports.waitForMessagingReady === 'function'
                ? await ports.waitForMessagingReady(retry.readyTimeoutMs)
                : false
            if (!ready) {
              await ports.delay(retry.delayMs)
            }
            continue
          }

          if (retry.kind === 'retry-transport') {
            ports.log.warn(
              `[sendDirectMessage transient rpc error (attempt ${sendAttempt}/${maxSendAttempts})]:`,
              error,
            )
            await ports.delay(retry.delayMs)
            continue
          }

          if (retry.kind === 'queue-unattempted') {
            // Every rejected call explicitly did nothing. Retain this same message ID and
            // request for the existing background reconciliation queue, including after restart.
            // An absent digest alone never grants this authority.
            // Why it waits, for the message to say: the relay or the network could not be
            // reached (every call failed in transport and did nothing).
            await setFirstSendState('payment-pending', {
              failureReason: 'unreachable',
            })
            return { state: 'payment-pending' }
          }

          ports.log.error('[sendDirectMessage error]:', error)
          // The wallet released the payment this message carried (nothing of it was ever
          // sent): the saved message must not keep a sendable copy of its signed transfer. The
          // row is saved by the state change just below.
          if (
            error instanceof ContactPaymentReleasedError &&
            ports.message(id) &&
            !financial
          )
            ports.stripReleasedPayments(ports.message(id)!)
          // A Retry of a message ended over the fee finds its payment given back: that is the
          // same end, told the same way (nothing was paid, its funds are available again).
          const failure =
            error instanceof ContactPaymentReleasedError &&
            previous?.failureReason === 'fee-exceeded'
              ? { reason: 'fee-exceeded' as const }
              : ports.classifySendFailure(error, ownDigest)
          await setFirstSendState('error', {
            ...(failure.keepDigest === undefined
              ? {}
              : { attemptDigest: failure.keepDigest }),
            failureReason: failure.reason,
            detail: ports.errorDetail(error),
          })
          return { state: 'failed', reason: failure.reason }
        }
      }

      ports.presentation.endWaiting(id)
      if (!result) {
        const failure = ports.classifySendFailure(lastSendError, ownDigest)
        await setFirstSendState('error', {
          ...(failure.keepDigest === undefined
            ? {}
            : { attemptDigest: failure.keepDigest }),
          failureReason: failure.reason,
          detail: ports.errorDetail(lastSendError),
        })
        return { state: 'failed', reason: failure.reason }
      }

      if (financial) {
        assertFinancialCurrent()
        try {
          await financial.submit()
        } catch (error) {
          // The message was delivered (the recipient is told of the payment), but the payment
          // is not on chain yet. It stays payment-pending, and reconciliation submits the same
          // stored signed bytes again; never a new payment.
          ports.log.warn('Financial submission remains pending', error)
          await setFirstSendState('payment-pending', {
            attemptDigest: result.payloadDigest,
          })
          return { state: 'payment-pending' }
        }
      }
      await ports.confirm({
        address,
        id,
        payloadDigest: result.payloadDigest,
        stampValueWei: result.stampValueWei,
        stampPayments: result.stampPayments,
        ...(financial ? { assertCurrent: assertFinancialCurrent } : {}),
      })
      return { state: 'sent', payloadDigest: result.payloadDigest }
    },
  }
  return execution
}

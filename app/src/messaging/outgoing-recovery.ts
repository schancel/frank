import type {
  OutgoingDelivery,
  OutgoingFinancialOperation,
} from '@frank/cashweb/types/messages'
import type {
  DirectMessageAttemptStatus,
  DirectMessageEnd,
  WalletHandle,
} from '@frank/wallet/chain'
import type { OutgoingFailureReason } from '@frank/cashweb/types/messages'

/** What a message the wallet reports `dead` shows: why the wallet says it ended. Only an end
 * the relay gave is "rejected"; one the wallet ended itself over the approved fee, before
 * anything was signed or handed out, says so (nothing was paid, its funds are back). A wallet
 * that cannot say (no `endOf`) leaves the relay's answer. (`outgoing-execution.ts` makes the
 * same mapping; its boundary admits no runtime import from here.) */
function failureOfEnd(
  end: DirectMessageEnd | undefined,
): OutgoingFailureReason {
  if (end?.reason === 'fee-exceeded') return 'fee-exceeded'
  if (end?.reason === 'discarded') return 'error'
  return 'rejected'
}

export interface RecoveryMessage {
  outbound: boolean
  status: string
  senderAddress: string
  destinationAddress?: string
  payloadDigest: string
  sealedMessageId?: string
  delivery?: OutgoingDelivery
  financialOperations?: OutgoingFinancialOperation[]
}
export interface RecoveryConversation<M extends RecoveryMessage> {
  address: string
  messages: M[]
}
export interface RecoveryContext {
  current(): boolean
  parseAddress(address: string): boolean
  attemptOf(
    wallet: WalletHandle,
    messageId: string,
  ): Promise<{ payloadDigest: string; paid: boolean } | undefined>
  reconcileAttempts(
    wallet: WalletHandle,
    payloadDigests: string[],
  ): Promise<Record<string, DirectMessageAttemptStatus>>
  /** Why a `dead` attempt ended, as the wallet records it (`DirectMessageClient.endOf`). */
  endOf?(
    wallet: WalletHandle,
    payloadDigest: string,
  ): Promise<DirectMessageEnd | undefined>
}
export interface OutgoingRecoveryPorts<M extends RecoveryMessage> {
  message(id: string): M | undefined
  conversations(): Array<[string, RecoveryConversation<M> | undefined]>
  inflight: Set<string>
  starting: ReadonlySet<string>
  withLock<T>(
    id: string,
    run: () => Promise<T>,
  ): Promise<{ result: T } | undefined>
  captureContext(): RecoveryContext
  resultAssertion(
    wallet: WalletHandle,
    id: string,
    message: M,
    digest: string | undefined,
    current: () => boolean,
  ): () => void
  isStale(error: unknown): boolean
  owns(wallet: WalletHandle, message: M): boolean
  isAddress(address: string): boolean
  displayAddress(address: string): string
  messageId(localKey: string): string
  refresh(
    address: string,
    id: string,
  ): Promise<'same' | 'changed' | 'gone' | 'unreadable'>
  setState(
    address: string,
    id: string,
    status: 'pending' | 'payment-pending' | 'error',
    delivery: OutgoingDelivery,
    options: { assertCurrent: () => void },
  ): Promise<void>
  confirm(params: {
    address: string
    id: string
    payloadDigest: string
    assertCurrent: () => void
  }): Promise<void>
  run(params: {
    wallet: WalletHandle
    address: string
    id: string
    manual: false
  }): Promise<unknown>
  runExclusive(params: {
    wallet: WalletHandle
    address: string
    id: string
    manual: false
    automatic: false
    confirmed: false
  }): Promise<unknown>
  warn(message: string, error: unknown): void
}

/** Stateless recovery policy. References, exclusion sets and mutations belong to the host. */
export function createOutgoingRecovery<M extends RecoveryMessage>(
  ports: OutgoingRecoveryPorts<M>,
) {
  const recovery = {
    async applyAttemptStatus({
      address,
      id,
      status,
      digest,
      assertCurrent,
    }: {
      address: string
      id: string
      digest: string
      assertCurrent: () => void
      status: DirectMessageAttemptStatus
    }): Promise<'sent' | 'live' | 'dead' | 'unknown' | 'stale'> {
      try {
        assertCurrent()
        const message = ports.message(id)!
        if (status === 'delivered') {
          await ports.confirm({
            address,
            id,
            payloadDigest: digest,
            assertCurrent,
          })
          return 'sent'
        }
        if (
          status === 'live' &&
          (message.status !== 'payment-pending' || !message.delivery?.live)
        ) {
          await ports.setState(
            address,
            id,
            'payment-pending',
            {
              attemptDigest: digest,
              live: true,
            },
            { assertCurrent },
          )
        }
        return status
      } catch (error) {
        if (ports.isStale(error)) return 'stale'
        throw error
      }
    },

    async resumeCutOffOutgoing({
      wallet,
      address,
      id,
    }: {
      wallet: WalletHandle
      address: string
      id: string
    }): Promise<void> {
      const context = ports.captureContext()
      const contextCurrent = () => context.current()
      if (ports.inflight.has(id) || ports.starting.has(id)) return
      ports.inflight.add(id)
      try {
        await ports.withLock(id, async () => {
          if (!contextCurrent()) return
          const fresh = await ports.refresh(address, id)
          const message = ports.message(id)
          if (
            !contextCurrent() ||
            fresh === 'gone' ||
            fresh === 'unreadable' ||
            !message ||
            !message.outbound ||
            message.status !== 'pending' ||
            message.delivery?.attemptDigest !== undefined ||
            !ports.owns(wallet, message)
          )
            return
          const assertCurrent = ports.resultAssertion(
            wallet,
            id,
            message,
            undefined,
            contextCurrent,
          )
          let held: { payloadDigest: string; paid: boolean } | undefined
          try {
            held = await context.attemptOf(
              wallet,
              message.sealedMessageId ?? ports.messageId(id),
            )
          } catch (error) {
            ports.warn('could not ask the wallet about a cut-off send', error)
            return
          }
          assertCurrent()
          if (held?.paid) {
            await ports.setState(
              address,
              id,
              'payment-pending',
              {
                attemptDigest: held.payloadDigest,
              },
              { assertCurrent },
            )
          } else if (held) {
            // A free message the relay may or may not hold: the same envelope goes again.
            await ports.runExclusive({
              wallet,
              address: ports.displayAddress(address),
              id,
              manual: false,
              automatic: false,
              confirmed: false,
            })
          } else {
            await ports.setState(
              address,
              id,
              'error',
              {
                failureReason: 'interrupted',
              },
              { assertCurrent },
            )
          }
        })
      } catch (error) {
        if (!ports.isStale(error))
          ports.warn('could not resume a cut-off send', error)
      } finally {
        ports.inflight.delete(id)
      }
    },

    async reconcileOutgoing({
      wallet,
    }: {
      wallet: WalletHandle
    }): Promise<{ pending: number }> {
      const context = ports.captureContext()
      const contextCurrent = () => context.current()
      const waiting: Array<{
        address: string
        id: string
        digest?: string
        message: M
        assertCurrent: () => void
      }> = []
      const seenChats = new Set<RecoveryConversation<M>>()
      const allChats = ports.conversations()
      // First: messages whose send was cut off (a reload) and whose row has no attempt. The
      // wallet says what it stored for each; what it stored joins the settling below.
      const cutOffSeen = new Set<RecoveryConversation<M>>()
      for (const [key, chat] of allChats) {
        if (!chat || cutOffSeen.has(chat)) continue
        cutOffSeen.add(chat)
        for (const message of [...(chat.messages ?? [])]) {
          if (!contextCurrent()) break
          if (
            !message.outbound ||
            message.status !== 'pending' ||
            message.delivery?.attemptDigest !== undefined ||
            !ports.owns(wallet, message) ||
            ports.inflight.has(message.payloadDigest) ||
            ports.starting.has(message.payloadDigest)
          )
            continue
          const address =
            (ports.isAddress(chat.address) ? chat.address : undefined) ||
            message.destinationAddress ||
            (context.parseAddress(key) ? key : '')
          if (!address) continue
          await recovery.resumeCutOffOutgoing({
            wallet,
            address,
            id: message.payloadDigest,
          })
        }
      }
      for (const [key, chat] of allChats) {
        if (!chat || seenChats.has(chat)) continue
        seenChats.add(chat)
        for (const message of chat.messages ?? []) {
          if (!contextCurrent()) break
          if (
            message.outbound &&
            (message.status === 'payment-pending' ||
              (message.status === 'error' &&
                message.delivery?.attemptDigest !== undefined)) &&
            ports.owns(wallet, message) &&
            !ports.inflight.has(message.payloadDigest)
          ) {
            const address =
              (ports.isAddress(chat.address) ? chat.address : undefined) ||
              message.destinationAddress ||
              (context.parseAddress(key) ? key : '')
            if (!address) continue
            if (message.financialOperations?.length) {
              await ports.run({
                wallet,
                address,
                id: message.payloadDigest,
                manual: false,
              })
              continue
            }
            waiting.push({
              address,
              id: message.payloadDigest,
              digest: message.delivery?.attemptDigest,
              message,
              assertCurrent: ports.resultAssertion(
                wallet,
                message.payloadDigest,
                message,
                message.delivery?.attemptDigest,
                contextCurrent,
              ),
            })
          }
        }
      }
      const withAttempt: typeof waiting = []
      for (const entry of waiting.filter(entry => entry.digest !== undefined)) {
        if (!contextCurrent()) break
        const fresh = await ports.refresh(entry.address, entry.id)
        const current = ports.message(entry.id)
        if (
          !contextCurrent() ||
          current !== entry.message ||
          fresh === 'gone' ||
          fresh === 'unreadable' ||
          !current ||
          current.delivery?.attemptDigest !== entry.digest ||
          !ports.owns(wallet, current)
        ) {
          continue
        }
        withAttempt.push(entry)
      }
      if (withAttempt.length > 0 && contextCurrent()) {
        try {
          const statuses = await context.reconcileAttempts(
            wallet,
            withAttempt.map(entry => entry.digest as string),
          )
          for (const entry of withAttempt) {
            try {
              const applied = await recovery.applyAttemptStatus({
                address: entry.address,
                id: entry.id,
                status: statuses[entry.digest as string] ?? 'unknown',
                digest: entry.digest as string,
                assertCurrent: entry.assertCurrent,
              })
              if (applied === 'dead' || applied === 'unknown') {
                await ports.setState(
                  entry.address,
                  entry.id,
                  'error',
                  {
                    attemptDigest: entry.digest,
                    failureReason:
                      applied === 'dead'
                        ? failureOfEnd(
                            await context
                              .endOf?.(wallet, entry.digest as string)
                              .catch(() => undefined),
                          )
                        : 'unverified',
                  },
                  { assertCurrent: entry.assertCurrent },
                )
              }
            } catch (error) {
              if (!ports.isStale(error)) throw error
            }
          }
        } catch (error) {
          ports.warn('could not reconcile pending payment attempts', error)
        }
      }
      for (const entry of waiting.filter(entry => entry.digest === undefined)) {
        if (!contextCurrent()) break
        try {
          entry.assertCurrent()
        } catch (error) {
          if (ports.isStale(error)) continue
          throw error
        }
        await ports.run({
          wallet,
          address: entry.address,
          id: entry.id,
          manual: false,
        })
      }
      let pending = 0
      const countedChats = new Set<RecoveryConversation<M>>()
      const allChatValues = ports
        .conversations()
        .map(([, conversation]) => conversation)
      for (const chat of allChatValues) {
        if (!chat || countedChats.has(chat)) continue
        countedChats.add(chat)
        pending +=
          chat.messages?.filter(
            message =>
              message.outbound &&
              message.status === 'payment-pending' &&
              ports.owns(wallet, message),
          ).length ?? 0
      }
      return { pending }
    },
  }
  return recovery
}

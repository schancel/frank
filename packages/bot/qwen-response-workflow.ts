import { canonicalMonadEnvelopeAddress } from '@frank/cashweb/relay/monad-message-envelope'
import type { CanonicalFetch } from '@frank/cashweb/relay/canonical-dm-transport'
import type { Current } from '@frank/directory-admission'
import type { MonadTxOverrides } from '@frank/wallet/monad-account-tx'
import type {
  CanonicalWorkflowLink,
  MonadCanonicalStampClient,
} from '@frank/wallet/monad-stamp-client'
import type { CanonicalJournalAttempt } from '@frank/wallet/storage/stamp-attempt-journal'
import { QwenChatMessage } from './qwen-client'
import { QwenReplyGenerator } from './qwen-reply'
import {
  QWEN_COUPLING_MAX_CONTEXT_BYTES,
  QWEN_COUPLING_MAX_PAYLOAD_BYTES,
  QwenBotStateStore,
  QwenCouplingRow,
  QwenCouplingTerminal,
  QwenResponseContext,
  QwenResponseInput,
  QwenResponseReceipt,
  QwenResponseRow,
  QwenSavedResponse,
  qwenCouplingBinding,
  qwenCouplingConsumerId,
  qwenCouplingPrepared,
} from './qwen-bot-state'

type Outcome = 'confirmed' | 'duplicate' | 'held'

/** Fresh admitted directory snapshots for one preparation; never persisted. */
export interface QwenCanonicalCurrents {
  senderCurrent: Current
  recipientCurrent: Current
}
/** Opaque sealed bytes plus bounded public identity. The authenticated plaintext fields of the
 * producer's result are deliberately absent: the saved response row stays their only owner. */
export interface QwenSealedReply {
  payload: Uint8Array
  context: Uint8Array
  t3: Uint8Array
  messageId: Uint8Array
  contentDigest: Uint8Array
}
/** The wallet's public canonical consumer surface, exactly as the wallet exports it. */
export type QwenCanonicalWallet = Pick<
  MonadCanonicalStampClient,
  | 'bindPrepared'
  | 'lookup'
  | 'prepareIntent'
  | 'reconcileWorkflowLinks'
  | 'finishIntent'
  | 'submit'
  | 'cleanupTerminal'
  | 'acknowledgeWorkflow'
  | 'wasAcknowledged'
>
/** #703 outbound boundary: one saved result, one sealed envelope, one wallet attempt. */
export interface QwenCanonicalSender {
  wallet: QwenCanonicalWallet
  /** Undefined when the peer has no admitted current directory entry; the turn stays held. */
  currents(row: QwenSavedResponse): Promise<QwenCanonicalCurrents | undefined>
  /** Seals the saved text once through the shared producer. Called only when no envelope exists. */
  seal(row: QwenSavedResponse, currents: QwenCanonicalCurrents): QwenSealedReply
  /** Optional funding of spendable inventory; never a reply payment and never retried blindly. */
  prepareInventory?(): Promise<void>
  overrides?: MonadTxOverrides
  fetch?: CanonicalFetch
}

/** The live CLI's response boundary. One instance processes turns sequentially; the Level lock
 * excludes a second process. No held phase may call the ordinary randomized envelope builder. */
export class QwenResponseWorkflow {
  private canonicalQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly options: {
      state: QwenBotStateStore
      context: QwenResponseContext
      systemPrompt: string
      generator: Pick<QwenReplyGenerator, 'reply'>
    } & (
      | {
          /** Legacy combined send. It has no exact outbound identity, so its send-started
           * boundary stays held after any interruption. */
          send: (response: QwenSavedResponse) => Promise<QwenResponseReceipt>
          canonical?: undefined
        }
      | { canonical: QwenCanonicalSender; send?: undefined }
    ),
  ) {}

  private held(row: { payloadHashHex: string }, reason: string): 'held' {
    // Only controlled phase/reason strings and the inbound hash; no error objects or text.
    console.warn(
      `[bot] response ${row.payloadHashHex} held: ${reason}; preserve state, inspect the response record before operator reconciliation`,
    )
    return 'held'
  }

  async resume(payloadHashHex: string): Promise<Outcome> {
    const { canonical } = this.options
    if (!canonical) return this.resumeLegacy(payloadHashHex)
    // One producer/link owner at a time: a second caller observes the first one's durable rows.
    const next = this.canonicalQueue.then(() =>
      this.resumeCanonical(payloadHashHex, canonical),
    )
    this.canonicalQueue = next.catch(() => undefined)
    return next
  }

  /** Startup and per-poll correlation. Repairs link gaps from exact saved bytes, hands durable
   * wallet outcomes to their turns and retires consumed evidence. It never seals, prepares or
   * transmits anything new; a returned reason means every canonical send stays held. */
  async recover(): Promise<string | undefined> {
    const { canonical } = this.options
    if (!canonical) return undefined
    const next = this.canonicalQueue.then(() => this.correlate(canonical))
    this.canonicalQueue = next.catch(() => undefined)
    const reason = await next
    if (reason)
      console.warn(
        `[bot] canonical wallet correlation held: ${reason}; preserve bot and wallet state`,
      )
    return reason
  }

  private rowContextHold(
    row: QwenResponseRow,
    linkedAttempt = false,
  ): string | undefined {
    const { context } = this.options
    const sameContext = (
      Object.keys(context) as Array<keyof QwenResponseContext>
    ).every(key => row.context[key] === context[key])
    // Continuing an exact, already linked wallet attempt is not a new effect: its bytes,
    // payment and account are fixed, and its outcome must still be collected after a
    // configuration change. Anything that would need a new seal or intent stays held.
    if (!sameContext && !linkedAttempt) return 'account-or-send-context-changed'
    if (row.phase === 'model-started') return 'model-result-unknown'
    if (row.phase === 'send-started') return 'send-outcome-unknown'
    return undefined
  }

  private async resumeLegacy(payloadHashHex: string): Promise<Outcome> {
    const { state, send } = this.options
    const row = state.getResponse(payloadHashHex)
    if (!row) throw new Error('Missing Qwen response record')
    if (row.phase === 'confirmed') return 'duplicate'
    const hold = this.rowContextHold(row)
    if (hold) return this.held(row, hold)
    if (row.phase !== 'response-ready' || !send) return 'held'
    // A sealed envelope may only continue through the exact-attempt path that produced it.
    if (state.getCoupling(payloadHashHex))
      return this.held(row, 'canonical-coupling-requires-canonical-sender')
    await state.startResponseSend(payloadHashHex)
    let receipt: QwenResponseReceipt
    try {
      receipt = await send(row)
    } catch {
      return this.held(row, 'send-outcome-unknown')
    }
    await state.confirmResponse(payloadHashHex, receipt)
    console.log(`[bot] response ${payloadHashHex} confirmed`)
    return 'confirmed'
  }

  private links(): CanonicalWorkflowLink[] {
    return this.options.state.allCouplings().flatMap(coupling =>
      coupling.phase === 'intent-linked' || coupling.phase === 'terminal'
        ? [
            {
              attemptRef: coupling.attemptRef,
              consumerId: coupling.consumerId,
              prepared: qwenCouplingPrepared(coupling.binding),
            },
          ]
        : [],
    )
  }

  /** Effect-free toward the relay and the chain. State write failures propagate. */
  private async correlate(
    canonical: QwenCanonicalSender,
  ): Promise<string | undefined> {
    const { state } = this.options
    const { wallet } = canonical
    for (const coupling of state.allCouplings()) {
      if (coupling.phase === 'terminal') {
        // Crash after the wallet acknowledgement: only this turn's own durable terminal row
        // plus the wallet's validated frontier may settle it.
        let acknowledged: boolean
        try {
          acknowledged = wallet.wasAcknowledged(coupling.attemptRef)
        } catch {
          return 'wallet-unavailable'
        }
        if (acknowledged) await state.settleCoupling(coupling.payloadHashHex)
      } else if (coupling.phase === 'envelope-ready') {
        // Crash between the wallet's durable intent and this store's link: the exact saved
        // bytes find the existing record. Absence here is not yet permission to prepare.
        let found: ReturnType<QwenCanonicalWallet['lookup']>
        try {
          found = wallet.lookup(qwenCouplingPrepared(coupling.binding))
        } catch {
          return 'wallet-binding-mismatch'
        }
        if (!found) continue
        if (found.record.consumerId !== coupling.consumerId)
          return 'wallet-foreign-consumer'
        await state.linkCoupling(
          coupling.payloadHashHex,
          found.record.attemptRef,
        )
      }
    }
    const links = this.links()
    let results: ReturnType<QwenCanonicalWallet['reconcileWorkflowLinks']>
    try {
      results = wallet.reconcileWorkflowLinks(links)
    } catch {
      return 'wallet-correlation-failed'
    }
    if (results.some(result => result.state === 'hold'))
      return 'wallet-correlation-hold'
    // The wallet reports per retained record; a link it does not retain is a missing attempt.
    if (
      links.some(
        link => !results.some(result => result.attemptRef === link.attemptRef),
      )
    )
      return 'wallet-attempt-missing'
    for (const coupling of state.allCouplings())
      if (coupling.phase === 'terminal') await this.retire(canonical, coupling)
    return undefined
  }

  /** After the Qwen terminal batch: wallet cleanup, workflow acknowledgement, then compaction. */
  private async retire(
    canonical: QwenCanonicalSender,
    coupling: Extract<QwenCouplingRow, { phase: 'terminal' }>,
  ): Promise<void> {
    const { wallet } = canonical
    let acknowledged = false
    try {
      if (!wallet.wasAcknowledged(coupling.attemptRef)) {
        await wallet.cleanupTerminal(coupling.attemptRef, coupling.consumerId)
        await wallet.acknowledgeWorkflow(
          coupling.attemptRef,
          coupling.consumerId,
        )
      }
      acknowledged = wallet.wasAcknowledged(coupling.attemptRef)
    } catch {
      // The outcome is already owned by this store; retirement is repeated on a later pass.
      console.warn(
        `[bot] response ${coupling.payloadHashHex} wallet acknowledgement pending`,
      )
      return
    }
    if (acknowledged)
      await this.options.state.settleCoupling(coupling.payloadHashHex)
  }

  private terminalEvidence(
    attempt: CanonicalJournalAttempt,
  ): QwenCouplingTerminal | undefined {
    const terminal = attempt.terminal
    if (!terminal) return undefined
    const identity = attempt.request.identity
    const bound = {
      submissionIdentity: identity.submission_identity,
      payloadHashHex: identity.payload_hash,
      txHashes: [...identity.transaction_hashes],
    }
    return terminal.phase === 'delivered'
      ? {
          outcome: 'delivered',
          ...bound,
          mailboxCommittedAtMs: terminal.mailbox_committed_at_ms,
        }
      : { outcome: 'dead', ...bound, reason: terminal.reason }
  }

  private async resumeCanonical(
    payloadHashHex: string,
    canonical: QwenCanonicalSender,
  ): Promise<Outcome> {
    const { state, context } = this.options
    const { wallet } = canonical
    const row = state.getResponse(payloadHashHex)
    if (!row) throw new Error('Missing Qwen response record')
    if (row.phase === 'confirmed') {
      const coupling = state.getCoupling(payloadHashHex)
      if (coupling?.phase === 'terminal') await this.retire(canonical, coupling)
      return 'duplicate'
    }
    const existing = state.getCoupling(payloadHashHex)
    const hold = this.rowContextHold(
      row,
      existing !== undefined && 'attemptRef' in existing,
    )
    if (hold) return this.held(row, hold)
    if (row.phase !== 'response-ready') return 'held'
    // All workflow correlation precedes replay and any new envelope or payment.
    const correlation = await this.correlate(canonical)
    if (correlation) return this.held(row, correlation)

    const consumerId = qwenCouplingConsumerId(payloadHashHex)
    const stampValueWei = BigInt(context.stampValueWei)
    let currents: QwenCanonicalCurrents | undefined
    let coupling = state.getCoupling(payloadHashHex)
    if (!coupling) {
      try {
        currents = await canonical.currents(row)
      } catch {
        currents = undefined
      }
      if (!currents) return this.held(row, 'peer-directory-unavailable')
      let sealed: QwenSealedReply
      let prepared: ReturnType<QwenCanonicalWallet['bindPrepared']>
      try {
        sealed = canonical.seal(row, currents)
        prepared = wallet.bindPrepared({
          payload: sealed.payload,
          context: sealed.context,
          stampValueWei,
          economicBinding: new TextEncoder().encode(consumerId),
        })
      } catch {
        // Nothing is durable and no wallet effect ran; a later pass may seal once.
        return this.held(row, 'envelope-preparation-failed')
      }
      // A reply too large for the bounded coupling store is held here, before any durable
      // or wallet effect, instead of failing the store's validation and stopping the bot.
      if (
        sealed.payload.length > QWEN_COUPLING_MAX_PAYLOAD_BYTES ||
        sealed.context.length > QWEN_COUPLING_MAX_CONTEXT_BYTES
      )
        return this.held(row, 'reply-exceeds-coupling-bounds')
      const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
      // Synced before the first wallet effect. A failed write fails closed until reopen.
      const saved = await state.saveCoupling(
        payloadHashHex,
        {
          messageIdHex: hexOf(sealed.messageId),
          t3Hex: hexOf(sealed.t3),
          contentDigestHex: hexOf(sealed.contentDigest),
          stampValueWei: stampValueWei.toString(),
        },
        qwenCouplingBinding(prepared),
      )
      if (saved === 'capacity') return this.held(row, 'coupling-capacity')
      coupling = state.getCoupling(payloadHashHex)!
    }
    if (
      coupling.phase === 'envelope-ready' &&
      coupling.stampValueWei !== stampValueWei.toString()
    )
      return this.held(row, 'account-or-send-context-changed')

    if (coupling.phase === 'envelope-ready') {
      // correlate() found no wallet record for these exact bytes, so this is the first intent.
      const prepared = qwenCouplingPrepared(coupling.binding)
      if (!currents) {
        try {
          currents = await canonical.currents(row)
        } catch {
          currents = undefined
        }
      }
      if (!currents) return this.held(row, 'peer-directory-unavailable')
      try {
        await canonical.prepareInventory?.()
      } catch {
        return this.held(row, 'inventory-unavailable')
      }
      let linkFailure: unknown
      try {
        await wallet.prepareIntent({
          prepared,
          consumerId,
          stampValueWei,
          senderCurrent: currents.senderCurrent,
          recipientCurrent: currents.recipientCurrent,
          overrides: canonical.overrides,
          onIntentDurable: async link => {
            try {
              await state.linkCoupling(payloadHashHex, link.attemptRef)
            } catch (error) {
              linkFailure = error ?? new Error('Qwen coupling link failed')
              throw error
            }
          },
        })
      } catch {
        if (linkFailure) throw linkFailure
        // A durable intent, if any, is found again through the saved bytes; never re-sealed.
        return this.held(row, 'intent-preparation-failed')
      }
      coupling = state.getCoupling(payloadHashHex)!
    }

    let confirmed = false
    for (let step = 0; coupling.phase === 'intent-linked'; step++) {
      if (step > 4) return this.held(row, 'wallet-correlation-hold')
      const attemptRef = coupling.attemptRef
      let mine:
        | ReturnType<QwenCanonicalWallet['reconcileWorkflowLinks']>[number]
        | undefined
      let found: ReturnType<QwenCanonicalWallet['lookup']>
      try {
        mine = wallet
          .reconcileWorkflowLinks(this.links())
          .find(result => result.attemptRef === attemptRef)
        found = wallet.lookup(qwenCouplingPrepared(coupling.binding))
      } catch {
        return this.held(row, 'wallet-correlation-failed')
      }
      if (!mine || mine.state === 'hold')
        return this.held(row, 'wallet-correlation-hold')
      if (
        !found ||
        found.record.attemptRef !== attemptRef ||
        found.record.consumerId !== consumerId
      )
        return this.held(row, 'wallet-attempt-missing')
      if (mine.state === 'terminal') {
        const terminal =
          found.kind === 'attempt'
            ? this.terminalEvidence(found.record)
            : undefined
        if (!terminal) return this.held(row, 'wallet-correlation-hold')
        // The one Qwen terminal batch, fed only by the wallet's durable outcome.
        await state.commitCouplingTerminal(payloadHashHex, terminal)
        confirmed = terminal.outcome === 'delivered'
        coupling = state.getCoupling(payloadHashHex)!
        break
      }
      if (!mine.eligibility) return this.held(row, 'wallet-correlation-hold')
      if (found.kind === 'intent') {
        try {
          // Signs the stored unsigned members only; no repricing, nonce or account change.
          await wallet.finishIntent(mine.eligibility)
        } catch {
          return this.held(row, 'signing-incomplete')
        }
        continue
      }
      let accepted: Awaited<ReturnType<QwenCanonicalWallet['submit']>>
      try {
        // The exact promoted request; the wallet records terminal evidence before returning.
        accepted = await wallet.submit(mine.eligibility, {
          fetch: canonical.fetch,
        })
      } catch {
        return this.held(row, 'send-outcome-unknown')
      }
      if (accepted.phase === 'retained')
        return this.held(row, 'relay-retained-delivery-pending')
    }

    if (coupling.phase === 'terminal') await this.retire(canonical, coupling)
    if (confirmed) {
      console.log(`[bot] response ${payloadHashHex} confirmed`)
      return 'confirmed'
    }
    // Dead evidence never authorizes a replacement envelope or payment.
    return this.held(row, 'delivery-dead')
  }

  async respond(
    input: Omit<QwenResponseInput, 'context'> & { prompt: string },
  ): Promise<Outcome> {
    const { state, context, generator, systemPrompt } = this.options
    if (state.hasProcessed(input.payloadHashHex)) return 'duplicate'
    if (state.getResponse(input.payloadHashHex))
      return this.resume(input.payloadHashHex)
    const pending = state.pendingResponseForPeer(input.senderAddress)
    if (pending) return this.held(pending, 'earlier-turn-unresolved')
    // Do not copy the prompt into the identity record. model-started explicitly represents
    // the unavoidable window where a provider may have completed but its result was not saved.
    await state.beginResponse({
      payloadHashHex: input.payloadHashHex,
      senderAddress: canonicalMonadEnvelopeAddress(input.senderAddress),
      senderPubKeyHex: input.senderPubKeyHex,
      context,
    })
    const history: QwenChatMessage[] = state.getConversation(
      input.senderAddress,
    ) ?? [{ role: 'system', content: systemPrompt }]
    history.push({ role: 'user', content: input.prompt })
    let content: string
    try {
      content = (await generator.reply(history.map(turn => ({ ...turn }))))
        .content
    } catch {
      return this.held(
        state.getResponse(input.payloadHashHex)!,
        'model-result-unknown',
      )
    }
    history.push({ role: 'assistant', content })
    await state.saveResponse(input.payloadHashHex, content, history)
    return this.resume(input.payloadHashHex)
  }
}

import { canonicalMonadEnvelopeAddress } from '@frank/cashweb/relay/monad-message-envelope'
import { QwenChatMessage } from './qwen-client'
import { QwenReplyGenerator } from './qwen-reply'
import {
  QwenBotStateStore,
  QwenResponseContext,
  QwenResponseInput,
  QwenResponseReceipt,
  QwenResponseRow,
  QwenSavedResponse,
} from './qwen-bot-state'

type Outcome = 'confirmed' | 'duplicate' | 'held'

/** The live CLI's response boundary. One instance processes turns sequentially; the Level lock
 * excludes a second process. No held phase may call the ordinary randomized envelope builder. */
export class QwenResponseWorkflow {
  constructor(
    private readonly options: {
      state: QwenBotStateStore
      context: QwenResponseContext
      systemPrompt: string
      generator: Pick<QwenReplyGenerator, 'reply'>
      send: (response: QwenSavedResponse) => Promise<QwenResponseReceipt>
    },
  ) {}

  private held(row: QwenResponseRow, reason: string): 'held' {
    // Only controlled phase/reason strings and the inbound hash; no error objects or text.
    console.warn(
      `[bot] response ${row.payloadHashHex} held: ${reason}; preserve state, inspect the response record before operator reconciliation`,
    )
    return 'held'
  }

  async resume(payloadHashHex: string): Promise<Outcome> {
    const { state, context, send } = this.options
    const row = state.getResponse(payloadHashHex)
    if (!row) throw new Error('Missing Qwen response record')
    if (row.phase === 'confirmed') return 'duplicate'
    const sameContext = (
      Object.keys(context) as Array<keyof QwenResponseContext>
    ).every(key => row.context[key] === context[key])
    if (!sameContext) return this.held(row, 'account-or-send-context-changed')
    if (row.phase === 'model-started')
      return this.held(row, 'model-result-unknown')
    if (row.phase === 'send-started')
      return this.held(row, 'send-outcome-unknown')
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

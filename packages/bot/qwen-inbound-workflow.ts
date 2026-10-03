import {
  fetchMonadMailboxInboxPage,
  MailboxAuthParams,
  MonadMailboxAuthError,
  MonadMailboxStaleCursorError,
} from '@frank/cashweb/relay/monad-mailbox-client'
import {
  canonicalMonadEnvelopeAddress,
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { QwenBotStateStore, QwenInboxContext } from './qwen-bot-state'
import { QwenResponseWorkflow } from './qwen-response-workflow'
import { extractPromptText } from './qwen-prompt'

export const QWEN_INBOX_PAGE_LIMIT = 100
// Matches the existing relay page ceiling, including its largest supported single record.
export const QWEN_INBOX_PAGE_BYTES = 4 * 1024 * 1024 + 16 * 1024
export const QWEN_INBOX_PAGES_PER_POLL = 2

/** Private Qwen boundary: public authenticated pages -> durable ciphertext -> existing response owner. */
export class QwenInboundWorkflow {
  constructor(
    private readonly options: {
      state: QwenBotStateStore
      context: QwenInboxContext
      auth: MailboxAuthParams
      responses: QwenResponseWorkflow
      privateKey: Parameters<typeof tryDecryptEnvelope>[0]['myPrivateKey']
      senderKey: (address: string) => Promise<Buffer | undefined>
      peerBlockReason: (address: string) => Promise<string | undefined>
      reserveReply: (address: string) => boolean
    },
  ) {}

  async import(): Promise<void> {
    const { state, context, auth } = this.options
    state.assertInboxContext(context)
    state.assertInboxContext({
      ...context,
      botAddress: auth.recipient,
      relayBaseUrl: auth.relayBaseUrl,
    })
    let reset = false
    for (let page = 0; page < QWEN_INBOX_PAGES_PER_POLL; page++) {
      const scan = state.getInboxScan()
      let result
      try {
        result = await fetchMonadMailboxInboxPage({
          ...auth,
          sinceMs: scan.origin,
          cursor: scan.cursor,
          limit: QWEN_INBOX_PAGE_LIMIT,
          maxBytes: QWEN_INBOX_PAGE_BYTES,
        })
      } catch (error) {
        if (
          scan.cursor &&
          !reset &&
          (error instanceof MonadMailboxStaleCursorError ||
            error instanceof MonadMailboxAuthError)
        ) {
          await state.resetInboxCursor(context, scan.revision)
          reset = true
          continue
        }
        // Do not expose arbitrary provider bodies (including public-client network errors).
        throw new Error(
          'Qwen inbox read failed; retained inputs and checkpoint preserved',
        )
      }
      const inputs = result.messages.map(stored => {
        if (!stored.message) throw new Error('Invalid Qwen inbox page')
        return {
          payloadHashHex: Buffer.from(stored.message.payloadHash).toString(
            'hex',
          ),
          encryptedPayloadHex: Buffer.from(
            stored.message.encryptedPayload,
          ).toString('hex'),
          timestamp: stored.timestamp,
          networkTagHex: Buffer.from(stored.networkTag).toString('hex'),
        }
      })
      if (
        inputs.length > QWEN_INBOX_PAGE_LIMIT ||
        inputs.reduce((n, row) => n + row.encryptedPayloadHex.length / 2, 0) >
          QWEN_INBOX_PAGE_BYTES
      )
        throw new Error('Invalid Qwen inbox page budget')
      const outcome = await state.importInboxPage(
        context,
        scan.revision,
        inputs,
        result.nextCursor,
      )
      if (outcome === 'capacity') {
        console.warn(
          '[bot] inbox capacity reached; admission paused, retained inputs preserved',
        )
        return
      }
      if (outcome === 'stale' || !result.nextCursor) return
    }
  }

  async drain(quota: number): Promise<number> {
    const { state, context, responses } = this.options
    return state.withInboxDrain(async () => {
      state.assertInboxContext(context)
      let confirmed = 0
      // An earlier deferred input must not be overtaken by a later admitted turn for its peer.
      const deferred = new Set<string>()
      for (const row of state.pendingInbox()) {
        if (confirmed >= quota) break
        if (
          row.networkTagHex !== Buffer.from(context.networkTag).toString('hex')
        )
          continue
        const envelope = parseEnvelope(
          Buffer.from(row.encryptedPayloadHex, 'hex'),
        )
        // Unsupported envelopes and unavailable validation stay retained, never blanket-acked.
        if (!envelope) continue
        // An unverified claim is only a conservative local ordering barrier, never authority
        // to generate, spend, persist a sender, or permanently reject an input.
        const candidatePeer = canonicalMonadEnvelopeAddress(envelope.from)
        if (deferred.has(candidatePeer)) continue
        let key: Buffer | undefined
        try {
          key = await this.options.senderKey(envelope.from)
        } catch {
          deferred.add(candidatePeer)
          continue
        }
        if (!key) {
          deferred.add(candidatePeer)
          continue
        }
        const plaintext = tryDecryptEnvelope({
          envelope,
          myPrivateKey: this.options.privateKey,
          senderPubKey: key,
        })
        if (plaintext === undefined) {
          deferred.add(candidatePeer)
          continue
        }
        const peer = canonicalMonadEnvelopeAddress(envelope.from)
        if (deferred.has(peer)) continue
        if (!sameMonadEnvelopeAddress(envelope.to, context.botAddress)) {
          await state.rejectInbox(
            context,
            row.payloadHashHex,
            'wrong-recipient',
          )
          continue
        }
        if (sameMonadEnvelopeAddress(peer, context.botAddress)) {
          await state.rejectInbox(context, row.payloadHashHex, 'self')
          continue
        }
        if (state.pendingResponseForPeer(peer)) {
          deferred.add(peer)
          continue
        }
        const prompt = extractPromptText(plaintext)
        if (prompt === undefined) {
          await state.rejectInbox(context, row.payloadHashHex, 'no-text')
          continue
        }
        let blocked = true
        try {
          blocked = !!(await this.options.peerBlockReason(peer))
        } catch {
          /* transient lookup */
        }
        if (blocked || !this.options.reserveReply(peer)) {
          deferred.add(peer)
          continue
        }
        const outcome = await responses.respond({
          payloadHashHex: row.payloadHashHex,
          senderAddress: peer,
          senderPubKeyHex: key.toString('hex'),
          prompt,
        })
        if (outcome === 'confirmed') confirmed++
        else deferred.add(peer)
      }
      return confirmed
    })
  }
}

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
import { computeAddress } from 'ethers'
import { parseFrame, recipientPayloadDigest, toHex } from '@frank/codec'
import {
  openDirectMessage,
  type DirectMessageRoles,
} from '@frank/cashweb/relay/canonical-dm'
import type {
  CanonicalInboxRecord,
  CanonicalMailboxPage,
} from '@frank/cashweb/relay/monad-mailbox-client'
import type { Current } from '@frank/directory-admission'
import {
  QwenBotStateStore,
  QwenInboxContext,
  QwenInboxInput,
  QwenInboxRow,
} from './qwen-bot-state'
import { QwenResponseWorkflow } from './qwen-response-workflow'
import { extractCanonicalPromptText, extractPromptText } from './qwen-prompt'

export const QWEN_INBOX_PAGE_LIMIT = 100
// Matches the existing relay page ceiling, including its largest supported single record.
export const QWEN_INBOX_PAGE_BYTES = 4 * 1024 * 1024 + 16 * 1024
export const QWEN_INBOX_PAGES_PER_POLL = 2

/** #778 canonical inbound source. Pages come from the authenticated canonical mailbox; opening
 * uses the bot's own scoped role keys under fresh admitted directory snapshots. Nothing here
 * grants delivery, payment credit or trust: the directory decides who can be opened at all. */
export interface QwenCanonicalInbound {
  /** Canonical network identifier, e.g. `monad-testnet`. */
  network: string
  /** The bot's own compressed identity point P, lowercase hex. */
  subject: string
  /** The mailbox address and installed home relay these pages are authenticated for. */
  recipient: string
  relayBaseUrl: string
  fetchPage(input: {
    sinceMs: number
    cursor?: string
    limit: number
    maxBytes: number
  }): Promise<CanonicalMailboxPage<CanonicalInboxRecord>>
  selfCurrent(): Promise<Current>
  /** Admitted Current of an installed peer, or `undefined` when it is not installed or not
   * readable now. `refresh` forces a new read from the peer's relay instead of a recent one. */
  peerCurrent(subject: string, refresh?: boolean): Promise<Current | undefined>
  /** A scoped opening session for the bot's own current directory entry. */
  roles(self: Current): DirectMessageRoles
}

type PendingInbox = Extract<QwenInboxRow, { phase: 'pending' }>

/** Private Qwen boundary: public authenticated pages -> durable ciphertext -> existing response owner. */
export class QwenInboundWorkflow {
  constructor(
    private readonly options: {
      state: QwenBotStateStore
      context: QwenInboxContext
      responses: QwenResponseWorkflow
      peerBlockReason: (address: string) => Promise<string | undefined>
      reserveReply: (address: string) => boolean
    } & (
      | {
          auth: MailboxAuthParams
          privateKey: Parameters<typeof tryDecryptEnvelope>[0]['myPrivateKey']
          senderKey: (address: string) => Promise<Buffer | undefined>
          canonical?: undefined
        }
      | { canonical: QwenCanonicalInbound }
    ),
  ) {}

  /** One exact canonical record -> one durable row keyed by its recomputed payload digest. */
  private canonicalInput(
    canonical: QwenCanonicalInbound,
    record: CanonicalInboxRecord,
  ): QwenInboxInput {
    const delivery = parseFrame(record.delivery)
    if (
      delivery.kind !== 'parsed' ||
      delivery.typed?.type !== 1 ||
      delivery.typed.network !== canonical.network ||
      delivery.typed.payloadFrame.typed?.type !== 5
    )
      throw new Error('Invalid Qwen inbox page')
    // The dedup identity is recomputed from the exact payload frame, never taken on trust.
    const digest = toHex(
      recipientPayloadDigest(
        canonical.network,
        delivery.typed.payloadFrame.frame,
      ),
    )
    if (digest !== toHex(delivery.typed.payloadDigest))
      throw new Error('Invalid Qwen inbox page')
    return {
      payloadHashHex: digest,
      encryptedPayloadHex: toHex(record.delivery),
      contextHex: toHex(record.context),
      timestamp: record.timestampMs,
      networkTagHex: Buffer.from(this.options.context.networkTag).toString(
        'hex',
      ),
    }
  }

  async import(): Promise<void> {
    const { state, context } = this.options
    const canonical = this.options.canonical
    const auth = canonical ? undefined : this.options.auth
    state.assertInboxContext(context)
    state.assertInboxContext({
      ...context,
      botAddress: canonical ? canonical.recipient : auth!.recipient,
      relayBaseUrl: canonical ? canonical.relayBaseUrl : auth!.relayBaseUrl,
    })
    let reset = false
    for (let page = 0; page < QWEN_INBOX_PAGES_PER_POLL; page++) {
      const scan = state.getInboxScan()
      let result: { inputs: QwenInboxInput[]; nextCursor?: string }
      try {
        const page = {
          sinceMs: scan.origin,
          cursor: scan.cursor,
          limit: QWEN_INBOX_PAGE_LIMIT,
          maxBytes: QWEN_INBOX_PAGE_BYTES,
        }
        if (canonical) {
          const fetched = await canonical.fetchPage(page)
          result = {
            inputs: fetched.records.map(record =>
              this.canonicalInput(canonical, record),
            ),
            nextCursor: fetched.nextCursor,
          }
        } else {
          const fetched = await fetchMonadMailboxInboxPage({
            ...auth!,
            ...page,
          })
          result = {
            inputs: fetched.messages.map(stored => {
              if (!stored.message) throw new Error('Invalid Qwen inbox page')
              return {
                payloadHashHex: Buffer.from(
                  stored.message.payloadHash,
                ).toString('hex'),
                encryptedPayloadHex: Buffer.from(
                  stored.message.encryptedPayload,
                ).toString('hex'),
                timestamp: stored.timestamp,
                networkTagHex: Buffer.from(stored.networkTag).toString('hex'),
              }
            }),
            nextCursor: fetched.nextCursor,
          }
        }
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
      const inputs = result.inputs
      if (
        inputs.length > QWEN_INBOX_PAGE_LIMIT ||
        inputs.reduce(
          (n, row) =>
            n +
            (row.encryptedPayloadHex.length + (row.contextHex?.length ?? 0)) /
              2,
          0,
        ) > QWEN_INBOX_PAGE_BYTES
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
        const canonical = this.options.canonical
        // A row is opened only by the mode that imported it; the other kind stays retained.
        if ((row.contextHex !== undefined) !== (canonical !== undefined))
          continue
        if (canonical) {
          const outcome = await this.drainCanonical(canonical, row, deferred)
          if (outcome === 'confirmed') confirmed++
          continue
        }
        if (this.options.canonical) continue
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

  /** Canonical row -> at most one `respond`. Anything that cannot be validated now stays
   * retained and keeps its peer ordered; only facts proven by the frame itself reject. */
  private async drainCanonical(
    canonical: QwenCanonicalInbound,
    row: PendingInbox,
    deferred: Set<string>,
  ): Promise<'confirmed' | 'other'> {
    const { state, context, responses } = this.options
    const delivery = parseFrame(
      new Uint8Array(Buffer.from(row.encryptedPayloadHex, 'hex')),
    )
    const payload =
      delivery.kind === 'parsed' && delivery.typed?.type === 1
        ? delivery.typed.payloadFrame
        : undefined
    if (!payload || payload.typed?.type !== 5) return 'other'
    const senderSubject = toHex(payload.typed.sender.keyBytes)
    // The sender field is unauthenticated until the envelope opens. A row that has not opened
    // never holds the ordering key for the peer it merely claims to be from.
    const peer = computeAddress('0x' + senderSubject).toLowerCase()
    if (toHex(payload.typed.recipient.keyBytes) !== canonical.subject) {
      await state.rejectInbox(context, row.payloadHashHex, 'wrong-recipient')
      return 'other'
    }
    if (senderSubject === canonical.subject) {
      await state.rejectInbox(context, row.payloadHashHex, 'self')
      return 'other'
    }
    const open = (sender: Current, self: Current): string | undefined => {
      const roles = canonical.roles(self)
      try {
        return extractCanonicalPromptText(
          openDirectMessage({
            mode: 'receive',
            network: canonical.network,
            payload: payload.frame,
            context: new Uint8Array(Buffer.from(row.contextHex!, 'hex')),
            roles,
            senderCurrent: sender,
            recipientCurrent: self,
          }).items,
        )
      } finally {
        roles.dispose()
      }
    }
    let sender: Current | undefined
    let self: Current
    try {
      sender = await canonical.peerCurrent(senderSubject)
      // Not an installed peer, or not readable now: never opened, never answered, retained.
      if (!sender) return 'other'
      self = await canonical.selfCurrent()
    } catch {
      return 'other'
    }
    let prompt: string | undefined
    try {
      prompt = open(sender, self)
    } catch {
      // It did not open under the directory entry held a moment ago. Decide only against a
      // new read from the relay: unreadable now stays retained; a deterministic failure
      // against that fresh entry is terminal, so it cannot block anything behind it.
      let fresh: Current | undefined
      try {
        fresh = await canonical.peerCurrent(senderSubject, true)
        self = await canonical.selfCurrent()
      } catch {
        return 'other'
      }
      if (!fresh) return 'other'
      try {
        prompt = open(fresh, self)
      } catch {
        await state.rejectInbox(context, row.payloadHashHex, 'unopenable')
        console.warn(
          `[bot] inbox ${row.payloadHashHex} rejected: unopenable under current directory evidence`,
        )
        return 'other'
      }
    }
    // Authenticated from here on: this row now orders its peer.
    if (deferred.has(peer)) return 'other'
    if (state.pendingResponseForPeer(peer)) {
      deferred.add(peer)
      return 'other'
    }
    if (prompt === undefined) {
      await state.rejectInbox(context, row.payloadHashHex, 'no-text')
      return 'other'
    }
    let blocked = true
    try {
      blocked = !!(await this.options.peerBlockReason(peer))
    } catch {
      /* transient lookup */
    }
    if (blocked || !this.options.reserveReply(peer)) {
      deferred.add(peer)
      return 'other'
    }
    const outcome = await responses.respond({
      payloadHashHex: row.payloadHashHex,
      senderAddress: peer,
      senderPubKeyHex: senderSubject,
      prompt,
    })
    if (outcome === 'confirmed') return 'confirmed'
    deferred.add(peer)
    return 'other'
  }
}

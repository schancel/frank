/** App composition lends feature orchestration a revocable signer and ordinary messaging only. */
import { shallowReactive } from 'vue'
import { fromHex, toHex } from '@frank/codec'
import { hmacSha256 } from '@frank/crypto-box'
import {
  formatConversationId,
  uuidv5Bytes,
} from '@frank/cashweb/relay/conversation-id'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import { conversationIdSaltOf } from '@frank/wallet/chain/evm-chain'
import {
  authorizeNegotiation,
  type LocalNegotiationIntent,
  type NegotiationAuthorization,
  type NegotiationRecord,
} from '@frank/swap-protocol/src/outgoing-negotiation'
import {
  TESTNET_NEGOTIATION_POLICY,
  type NegotiationContext,
} from '@frank/swap-protocol/src/negotiation'
import { accountSession } from '../accounts/session'
import { store } from '../adapters/level-message-store'
import { useChatStore } from '../stores/chats'
import { captureDirectoryPeer } from '../utils/directory-peer'
import { messagingState } from '../utils/messaging-state'
import { negotiationRecoveryStatus } from '../utils/negotiation-recovery'

export const negotiationCommandStatus = shallowReactive({
  busy: false,
  error: '',
  delivery: '',
})
/** Presentation uses localized categories; callers retain the original exception for diagnostics. */
export function negotiationErrorCode(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/capacity/i.test(detail)) return 'capacity'
  if (/expired|expiry/i.test(detail)) return 'expired'
  if (/conflict|differs|different/i.test(detail)) return 'conflict'
  if (/amount|principal|precision|decimal/i.test(detail)) return 'invalidAmount'
  if (/intent|schema|canonical|stored signature|stored message/i.test(detail))
    return 'invalidIntent'
  if (
    /session|closed|context|conversation changed|directory session/i.test(
      detail,
    )
  )
    return 'sessionChanged'
  if (/storage|store|database|unavailable/i.test(detail)) return 'storage'
  if (/delivery pending/i.test(detail)) return 'deliveryPending'
  return 'failed'
}
export function negotiationUnavailable(): string {
  if (
    activeChain.chainIdentifier !==
    TESTNET_NEGOTIATION_POLICY.evmChainIdentifier
  )
    return 'unsupported'
  if (
    accountSession.state.status !== 'ready' ||
    messagingState.status !== 'ready'
  )
    return 'restoring'
  const recovery = negotiationRecoveryStatus.snapshot
  return recovery?.state === 'ready' ? '' : recovery?.state ?? 'restoring'
}
export interface CapturedNegotiation {
  readonly auth: NegotiationAuthorization
  readonly context: NegotiationContext
  readonly address: string
  readonly wallet: WalletHandle
  readonly stampValueWei: string
}
export async function captureNegotiation(input: {
  address: string
  conversationId: string
  swapId: Uint8Array
  stampValue: bigint
  responseContext?: NegotiationContext
}): Promise<CapturedNegotiation> {
  if (negotiationUnavailable()) throw new Error(negotiationUnavailable())
  const signer = await accountSession.createIdentityDigestSigner()
  signer.assertCurrent()
  const wallet = accountSession.peekWallet()
  if (!wallet || wallet.chainIdentifier !== signer.chainIdentifier)
    throw new Error('Session changed')
  const peer = await captureDirectoryPeer(input.address)
  signer.assertCurrent()
  const salt = conversationIdSaltOf(wallet)
  if (!salt) throw new Error('Private account identity unavailable')
  const auth: NegotiationAuthorization = {
    accountId: signer.accountId,
    publicKey: signer.publicKey,
    recipientPublicKey: peer.publicKey,
    messagingChainIdentifier: signer.chainIdentifier,
    conversationId: input.conversationId,
    assertCurrent() {
      signer.assertCurrent()
      peer.assertCurrent()
      if (
        messagingState.status !== 'ready' ||
        accountSession.peekWallet() !== wallet
      )
        throw new Error('Messaging session changed')
      const unavailable = negotiationUnavailable()
      if (unavailable) throw new Error(unavailable)
    },
    intentKey: transcript => toHex(hmacSha256(transcript, salt)),
    messageId: transcript =>
      formatConversationId(uuidv5Bytes(salt, toHex(transcript))),
    assertAdmittedOffer(context, offerBytes, decision) {
      const journal = negotiationRecoveryStatus.snapshot?.journals.find(
        j =>
          j.owner.messagingChainIdentifier === signer.chainIdentifier &&
          toHex(j.owner.localPublicKey) === toHex(signer.publicKey) &&
          toHex(j.context.swapId) === toHex(context.swapId) &&
          toHex(j.context.conversationId) === toHex(context.conversationId) &&
          j.context.policy.name === context.policy.name &&
          j.context.parties.every(
            (key, i) => toHex(key) === toHex(context.parties[i]!),
          ) &&
          j.entries.some(e => toHex(e.eventBytes) === toHex(offerBytes)),
      )
      if (
        !journal?.reduction.history.offer ||
        journal.reduction.violation ||
        (journal.reduction.history.decision &&
          journal.reduction.history.decision !== decision)
      )
        throw new Error('Exact authenticated offer required')
    },
    signDigest: signer.signDigest,
  }
  auth.assertCurrent()
  const context: NegotiationContext = input.responseContext ?? {
    swapId: new Uint8Array(input.swapId),
    conversationId: fromHex(input.conversationId.replace(/-/g, '')),
    parties: [signer.publicKey, peer.publicKey],
    policy: TESTNET_NEGOTIATION_POLICY,
  }
  return {
    auth,
    context,
    address: input.address,
    wallet: wallet as WalletHandle,
    stampValueWei: input.stampValue.toString(),
  }
}
let activeCommands = 0
export async function sendNegotiation(
  captured: CapturedNegotiation,
  intent: LocalNegotiationIntent,
): Promise<void> {
  negotiationCommandStatus.error = ''
  activeCommands++
  negotiationCommandStatus.busy = true
  try {
    captured.auth.assertCurrent()
    const storage = await store
    captured.auth.assertCurrent()
    const record = await authorizeNegotiation({
      intent,
      auth: captured.auth,
      stampValueWei: captured.stampValueWei,
      now: () => BigInt(Math.floor(Date.now() / 1000)),
      owner: {
        claimOutgoingApplicationMessage: claim =>
          storage.claimOutgoingApplicationMessage(claim),
        completeOutgoingApplicationMessage: completion =>
          storage.completeOutgoingApplicationMessage(completion),
        getOutgoingApplicationMessage: intentKey =>
          storage.outgoingApplicationMessage({
            intentKey,
            accountId: captured.auth.accountId,
          }),
      },
    })
    captured.auth.assertCurrent()
    await deliver(captured, record)
  } catch (error) {
    negotiationCommandStatus.error = negotiationErrorCode(error)
    throw error
  } finally {
    activeCommands--
    negotiationCommandStatus.busy = activeCommands > 0
  }
}
async function deliver(
  captured: CapturedNegotiation,
  record: NegotiationRecord & {
    phase: 'signed'
    messageId: string
    signedPayloadHex: string
  },
): Promise<void> {
  const outcome = await useChatStore().deliverPersistedApplicationMessage({
    wallet: captured.wallet,
    address: captured.address,
    conversationId: record.conversationId,
    localMessageKey: `pending:application:${record.messageId}`,
    messageId: record.messageId,
    applicationAuthorization: {
      accountId: record.accountId,
      intentKey: record.intentKey,
    },
    stampValue: BigInt(record.stampValueWei),
    items: [
      {
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex: record.signedPayloadHex },
      },
    ],
    assertCurrent: captured.auth.assertCurrent,
  })
  captured.auth.assertCurrent()
  negotiationCommandStatus.delivery = outcome.state
  if (outcome.state !== 'sent')
    throw new Error('Signed negotiation delivery pending')
}

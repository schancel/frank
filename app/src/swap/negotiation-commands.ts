/** App composition lends feature orchestration a revocable signer and ordinary messaging only. */
import { shallowReactive } from 'vue'
import { sha256 } from '@noble/hashes/sha256.js'
import { fromHex, toHex } from '@frank/codec'
import { hmacSha256 } from '@frank/crypto-box'
import {
  formatConversationId,
  uuidv5Bytes,
} from '@frank/cashweb/relay/conversation-id'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import {
  conversationIdSaltOf,
  htlcMainAccountOf,
  swapSecretCapabilityOf,
} from '@frank/wallet/chain/evm-chain'
import {
  authorizeNegotiation,
  type LocalNegotiationIntent,
  type NegotiationAuthorization,
  type NegotiationRecord,
} from '@frank/swap-protocol/src/outgoing-negotiation'
import {
  TESTNET_NEGOTIATION_POLICY,
  decodeNegotiationEventStandalone,
  defaultNegotiationDeadlinesFor,
  deriveOfferSwapId,
  latestNegotiationExpiry,
  negotiationLockWindow,
  validateOfferFields,
  type NegotiationContext,
} from '@frank/swap-protocol/src/negotiation'
import type { SwapResult } from '@frank/swap-protocol/src'
import { accountSession } from '../accounts/session'
import { openXecHtlcKeys } from '../accounts/utxo-wallets'
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
  if (/would refuse the lock/i.test(detail)) return 'tooFar'
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
  return recovery?.state === 'ready' ||
    (recovery?.state === 'scanning' && recovery.coverage !== undefined)
    ? ''
    : recovery?.state ?? 'restoring'
}
/** The conversation, ordered parties [self, peer] and policy of a new offer; no swapId yet. */
export type OfferBase = Omit<NegotiationContext, 'swapId'>
export interface CapturedNegotiation {
  readonly auth: NegotiationAuthorization
  readonly offerBase: OfferBase
  readonly address: string
  readonly wallet: WalletHandle
  readonly stampValueWei: string
}
export async function captureNegotiation(input: {
  address: string
  conversationId: string
  stampValue: bigint
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
    // `frank/swap-offer-id/v1` transcripts carry their own label, so they never collide with
    // the intent-key or message-ID transcripts keyed by the same private salt.
    offerSwapId: transcript => hmacSha256(transcript, salt),
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
  return {
    auth,
    offerBase: {
      conversationId: fromHex(input.conversationId.replace(/-/g, '')),
      parties: [signer.publicKey, peer.publicKey],
      policy: TESTNET_NEGOTIATION_POLICY,
    },
    address: input.address,
    wallet: wallet as WalletHandle,
    stampValueWei: input.stampValue.toString(),
  }
}
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000))
/** The latest acceptance deadline an offer made now may choose (Unix seconds). */
export function latestOfferExpiry(): bigint {
  return unwrap(
    latestNegotiationExpiry(TESTNET_NEGOTIATION_POLICY, nowSeconds()),
  )
}
const unwrap = <T>(value: SwapResult<T>): T => {
  if (!value.ok) throw new Error(value.error.detail ?? value.error.code)
  return value.value
}
const addressBytes = (address: string): Uint8Array => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid address')
  return fromHex(address.slice(2).toLowerCase())
}
/** This network's GenericHTLC: the contract the wallet sends HTLC calls to (deployment record). */
function htlcContract(): Uint8Array {
  if (
    activeChain.chainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier ||
    !activeChain.getHtlcAddress
  )
    throw new Error('unsupported')
  return addressBytes(activeChain.getHtlcAddress())
}
function evmMainAccount(wallet: WalletHandle): Uint8Array {
  const main = htlcMainAccountOf(wallet)
  if (!main) throw new Error('Private account identity unavailable')
  return addressBytes(main)
}
/** This account's per-swap eCash key; custody derives it and never hands out the secret. */
async function xecHtlcPublicKey(
  captured: CapturedNegotiation,
  swapId: Uint8Array,
  role: 'claim' | 'refund',
): Promise<Uint8Array> {
  const keys = await openXecHtlcKeys(
    TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
  )
  captured.auth.assertCurrent()
  return keys.htlcPublicKey(toHex(swapId), role)
}
/**
 * A's complete v2 offer: the default deadlines for the chosen acceptance deadline E, A's main
 * account as the MON recipient, this network's GenericHTLC, a swapId A derives from those facts
 * under its private account salt, the hash lock of A's swap secret for that swapId and A's
 * per-swap eCash refund key. Every device of the account builds the same offer.
 */
export async function buildOfferIntent(
  captured: CapturedNegotiation,
  input: { xecPrincipal: bigint; evmPrincipal: bigint; expiry: bigint },
): Promise<Extract<LocalNegotiationIntent, { action: 'offer' }>> {
  captured.auth.assertCurrent()
  const base = captured.offerBase
  const deadlines = unwrap(
    defaultNegotiationDeadlinesFor(base.policy, input.expiry),
  )
  const evmRecipient = evmMainAccount(captured.wallet)
  const evmHtlcContract = htlcContract()
  const swapId = unwrap(
    deriveOfferSwapId(
      {
        ...base,
        xecPrincipal: input.xecPrincipal,
        evmPrincipal: input.evmPrincipal,
        ...deadlines,
        evmRecipient,
        evmHtlcContract,
      },
      captured.auth.offerSwapId,
    ),
  )
  const secrets = swapSecretCapabilityOf(captured.wallet)
  if (!secrets) throw new Error('Private account identity unavailable')
  // The swapId is A's own (derived above), so asking for its secret is allowed (PR 4 notes).
  const preimage = secrets.swapPreimage({
    policyName: base.policy.name,
    swapId,
  })
  const hashLock = sha256(preimage)
  preimage.fill(0)
  const xecRefundPublicKey = await xecHtlcPublicKey(captured, swapId, 'refund')
  captured.auth.assertCurrent()
  const intent = {
    action: 'offer' as const,
    context: { ...base, swapId },
    xecPrincipal: input.xecPrincipal,
    evmPrincipal: input.evmPrincipal,
    ...deadlines,
    hashLock,
    xecRefundPublicKey,
    evmRecipient,
    evmHtlcContract,
  }
  // Refuse at review what signing would refuse (dust principal, deadline rules).
  unwrap(validateOfferFields(intent.context, intent, nowSeconds()))
  return intent
}
/**
 * B's response to an admitted offer. An accept adds B's per-swap eCash claim key and B's main
 * account (sender and refund address of B's MON lock), and is refused unless the offer names
 * this network's GenericHTLC.
 */
export async function buildResponseIntent(
  captured: CapturedNegotiation,
  context: NegotiationContext,
  offerBytes: Uint8Array,
  decision: 'accept' | 'reject',
): Promise<LocalNegotiationIntent> {
  captured.auth.assertCurrent()
  if (decision === 'reject')
    return { context, action: 'reject', offerBytes: new Uint8Array(offerBytes) }
  const offer = unwrap(decodeNegotiationEventStandalone(offerBytes, context))
  if (offer.kind !== 'offer') throw new Error('Response requires signed offer')
  if (toHex(offer.terms.evmHtlcContract) !== toHex(htlcContract()))
    throw new Error('Offer names a different HTLC contract (conflict)')
  // B's lock must fit GenericHTLC's maximum duration, or A would fund a swap B cannot lock.
  unwrap(negotiationLockWindow(offer.terms, nowSeconds()))
  const evmSender = evmMainAccount(captured.wallet)
  const xecClaimPublicKey = await xecHtlcPublicKey(
    captured,
    context.swapId,
    'claim',
  )
  return {
    context,
    action: 'accept',
    offerBytes: new Uint8Array(offerBytes),
    xecClaimPublicKey,
    evmSender,
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

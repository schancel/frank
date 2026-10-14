import { encodeCanonical, toHex } from '@frank/codec'
import { hmacSha256 } from '@frank/crypto-box'
import protocolChains from '../../../docs/protocol/chains/v1.json'
import { profilePubKeyFromBytes } from './profile-pubkey'

const DOMAIN = 'frank/app/message-variant/v1'
const canonicalChains = new Set(protocolChains.chains.map(chain => chain.id))

/** Absence is an authenticated wire fact, never an unset UI/default conversation. */
export type WireConversationFact =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly id: Uint8Array }

/** Supplied by an authenticated opener/replay boundary. This helper checks representation,
 * not provenance. Missing optional app metadata cannot establish these facts. Canonical type 6
 * always carries a 16-byte message ID and a 32-byte content digest; type 8 is not an edit marker. */
export interface AuthenticatedMessageVariantFacts {
  readonly chainIdentifier: string
  readonly sender: { readonly keyType: 1; readonly keyBytes: Uint8Array }
  readonly wireConversation: WireConversationFact
  readonly claimedMessageId: Uint8Array
  readonly contentDigest: Uint8Array
}

/** Local content identity only: never a sealed wire message ID or a payment/delivery key. */
export type MessageVariantId = `message-variant:v1:${string}`

function invalid(field: string): never {
  throw new TypeError(`Invalid message variant identity: ${field}`)
}

function bytes(value: unknown, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) return invalid(field)
  const copied = Uint8Array.from(value)
  if (copied.length !== length) return invalid(field)
  return copied
}

/** Pure, unintegrated derivation. The caller supplies the account's existing 16-byte private
 * conversation-ID salt; nothing here obtains custody, derives that salt or stores any value.
 * Receipt order, aliases and payload/attempt identities do not participate in this transcript. */
export function deriveMessageVariantId(
  accountSalt: Uint8Array,
  facts: AuthenticatedMessageVariantFacts,
): MessageVariantId {
  const salt = bytes(accountSalt, 16, 'accountSalt')
  if (!facts || typeof facts !== 'object') return invalid('facts')
  const chainIdentifier = facts.chainIdentifier
  if (
    typeof chainIdentifier !== 'string' ||
    !canonicalChains.has(chainIdentifier)
  )
    return invalid('chainIdentifier')
  const sender = facts.sender
  if (!sender || sender.keyType !== 1) return invalid('sender')
  const senderBytes = bytes(sender.keyBytes, 33, 'sender')
  try {
    profilePubKeyFromBytes(senderBytes)
  } catch {
    return invalid('sender')
  }
  const wireConversation = facts.wireConversation
  if (!wireConversation || typeof wireConversation !== 'object')
    return invalid('wireConversation')
  const presence = wireConversation.kind
  if (presence !== 'absent' && presence !== 'present')
    return invalid('wireConversation')
  if (presence === 'absent' && 'id' in wireConversation)
    return invalid('wireConversation')
  const conversation =
    presence === 'absent'
      ? [0]
      : [1, bytes(wireConversation.id, 16, 'wireConversation')]
  const claimedMessageId = bytes(facts.claimedMessageId, 16, 'claimedMessageId')
  const contentDigest = bytes(facts.contentDigest, 32, 'contentDigest')
  const transcript = encodeCanonical([
    DOMAIN,
    chainIdentifier,
    [1, senderBytes],
    conversation,
    claimedMessageId,
    contentDigest,
  ])
  // crypto-box takes data first and key second. Keep all 32 bytes; this is not a UUID.
  return `message-variant:v1:${toHex(hmacSha256(transcript, salt))}`
}

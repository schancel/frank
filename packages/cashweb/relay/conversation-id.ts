/**
 * Conversation identifiers.
 *
 * A conversation's ID is allocated by whoever starts the conversation and is then simply carried:
 * every message sent in a conversation carries its ID, and a receiver files a message under the
 * ID it carries. The two sides compute nothing in common.
 *
 * An account allocates IDs from a private salt, derived from its own key material and known to
 * nobody else ({@link conversationIdSalt}). Every device and process holding the account derives
 * the same salt, so they allocate the same IDs; no other account can compute them.
 *
 *  - Opening a chat with a peer: UUIDv5(namespace = my salt, name = the peer). The same however
 *    often and wherever I open it, different for every other account that opens a chat with the
 *    same peer, and equal to my notes-to-self ID only when the peer is me.
 *  - A message that arrives with no ID (a client that sent none): filed under the ID I would
 *    allocate for its sender, so one such sender stays in one conversation.
 *  - A further, explicitly created conversation with the same peer: a random UUIDv4.
 *
 * The peer is named by whatever stable identifier the allocating code holds for it; the value
 * only has to be stable for the account that allocates it.
 */
import { hmacSha256 } from '@frank/crypto-box'
import { sha1 } from '@noble/hashes/sha1'

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/** RFC 4122 version-5 UUID of `name` in the 16-byte `namespace`, as 16 bytes. */
export function uuidv5Bytes(namespace: Uint8Array, name: string): Uint8Array {
  if (namespace.length !== 16)
    throw new Error('UUID namespace must contain exactly 16 bytes')
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(16 + nameBytes.length)
  input.set(namespace, 0)
  input.set(nameBytes, 16)

  const digest = sha1(input).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50 // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80 // RFC 4122 variant
  return digest
}

/** 16 bytes as a lowercase 8-4-4-4-12 UUID string. */
export function formatConversationId(id: Uint8Array): string {
  if (id.length !== 16)
    throw new Error('Conversation identity must contain exactly 16 bytes')
  const h = hex(id)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20,
  )}-${h.slice(20, 32)}`
}

const SALT_LABEL = new TextEncoder().encode('frank/conversation-id-salt/v1')

/**
 * The account's private conversation-ID salt: 16 bytes derived, under a fixed label, from a
 * 32-byte secret root the account already holds (the messaging root of a wallet). It is a keyed
 * hash of the label, never the root itself, and it leaves the device only as the IDs made from
 * it. The caller owns `secretRoot` and the result.
 */
export function conversationIdSalt(secretRoot: Uint8Array): Uint8Array {
  if (secretRoot.length !== 32)
    throw new RangeError('conversation-ID salt root must be exactly 32 bytes')
  return hmacSha256(SALT_LABEL, secretRoot).slice(0, 16)
}

/**
 * The ID this account allocates for its conversation with `peer` when it opens one (or when a
 * message from `peer` arrives with none): UUIDv5(namespace = `salt`, name = `peer`, no topic).
 * This is the one place an opening ID is allocated; every caller that needs one calls it.
 */
export function allocateOpeningConversationId(
  salt: Uint8Array,
  peer: string,
): Uint8Array {
  if (salt.length !== 16)
    throw new Error('A conversation-ID salt is exactly 16 bytes')
  if (peer.length === 0)
    throw new Error('A conversation needs the identifier of its peer')
  return uuidv5Bytes(salt, peer)
}

/**
 * Whether `conversationId` (its 8-4-4-4-12 text) is an opening ID: a UUIDv5, the kind an account
 * allocates when it opens a chat with a peer. An explicitly created further conversation is a
 * UUIDv4 and is not one. The version is all that tells the two apart on the wire.
 */
export function isOpeningConversationId(conversationId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    conversationId,
  )
}

/**
 * Who said what in a conversation with more than two people.
 *
 * A message is filed under the conversation ID it carries, so someone other than the peer a
 * conversation was opened with can post into it. Once that has happened every message that is
 * not ours is shown with its own sender: name, avatar and the sender's key colour. A
 * conversation between two people is shown without any of that.
 */
import { pubKeyToColor } from './formatting'
import { sameCanonicalAddress } from './own-address'
import { shortAddress } from './short-address'

/** What is known about a sender: the contact, if they are one, and the key their messages in
 * this conversation were verified against. */
export interface SenderRecord {
  address: string
  /** False for someone who posted into the conversation without being a contact. */
  inContacts: boolean
  name?: string | null
  username?: string | null
  avatar?: string | null
  pubKey?: Uint8Array | null
}

export interface SenderIdentity {
  address: string
  /** The name to show. Never ambiguous within one conversation. */
  label: string
  avatar?: string
  /** The colour derived from the sender's key, the same as in the contact list and the chat
   * header. Absent when no key is known. */
  color?: string
  inContacts: boolean
}

export interface BubbleAttribution {
  sender: SenderIdentity
  /** First message of a run by this sender: the name is shown. */
  showName: boolean
  /** Last message of a run by this sender: the avatar is shown. */
  showAvatar: boolean
}

const key = (address: string) => address.toLowerCase()

/** The participants other than this user. Empty until the own address is known, so a chat is
 * never drawn as a group merely because it lists this user beside the peer. */
export function otherParticipants(
  participants: readonly string[] | undefined,
  ownAddress: string | null | undefined,
): string[] {
  if (!ownAddress) return []
  return (participants ?? []).filter(
    participant => !sameCanonicalAddress(participant, ownAddress),
  )
}

/** More than two people: this user and at least two others. */
export function isGroupConversation(
  participants: readonly string[] | undefined,
  ownAddress: string | null | undefined,
): boolean {
  return otherParticipants(participants, ownAddress).length > 1
}

/** A contact is shown by the name the app has for them. Someone who is not a contact is shown
 * by their address only: a name they published themselves is not shown as if it were known. */
function baseName(record: SenderRecord): string {
  const name = record.inContacts ? record.name : undefined
  // Nothing visible (empty, spaces, zero-width or direction marks) is not a name, and neither
  // is the placeholder of a contact whose profile has not been fetched yet.
  return !name ||
    name.replace(/[\p{Cf}\s]/gu, '') === '' ||
    name === 'Loading...'
    ? shortAddress(record.address)
    : name
}

const comparable = (name: string) =>
  name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The identities of a conversation's senders. Display names are not unique, so when two of
 * them would read the same each gets a suffix that is: the username once the profile has one,
 * otherwise the shortened address.
 */
export function resolveSenders(
  records: readonly SenderRecord[],
): Map<string, SenderIdentity> {
  const names = records.map(baseName)
  const count = new Map<string, number>()
  for (const name of names)
    count.set(comparable(name), (count.get(comparable(name)) ?? 0) + 1)
  const senders = new Map<string, SenderIdentity>()
  records.forEach((record, index) => {
    const name = names[index]
    const short = shortAddress(record.address)
    const ambiguous = (count.get(comparable(name)) ?? 0) > 1 && name !== short
    const unique =
      record.inContacts && record.username ? `@${record.username}` : short
    senders.set(key(record.address), {
      address: record.address,
      label: ambiguous ? `${name} (${unique})` : name,
      avatar: (record.inContacts && record.avatar) || undefined,
      color: record.pubKey ? pubKeyToColor(record.pubKey) : undefined,
      inContacts: record.inContacts,
    })
  })
  return senders
}

export function senderOf(
  senders: ReadonlyMap<string, SenderIdentity>,
  address: string,
): SenderIdentity | undefined {
  return senders.get(key(address))
}

/**
 * One entry per message: nothing for our own messages, and for anyone else's the sender, with
 * the name on the first message of a run by that sender and the avatar on the last.
 */
export function attributeMessages(
  messages: ReadonlyArray<{ outbound: boolean; senderAddress: string }>,
  senders: ReadonlyMap<string, SenderIdentity>,
): Array<BubbleAttribution | undefined> {
  const author = (index: number) => {
    const message = messages[index]
    return message && !message.outbound ? key(message.senderAddress) : undefined
  }
  return messages.map((message, index) => {
    const sender = message.outbound
      ? undefined
      : senderOf(senders, message.senderAddress)
    if (!sender) return undefined
    return {
      sender,
      showName: author(index - 1) !== author(index),
      showAvatar: author(index + 1) !== author(index),
    }
  })
}

/** The contact store, as far as naming a sender needs it. */
export interface ContactLookup {
  isContact(address: string): boolean
  getContactProfile(address: string):
    | {
        name?: string | null
        username?: string | null
        avatar?: string | null
        pubKey?: { toBuffer(): Uint8Array } | null
      }
    | undefined
}

function bytesFromHex(hex: string | undefined): Uint8Array | undefined {
  if (!hex || !/^([0-9a-f]{2})+$/i.test(hex)) return undefined
  return Uint8Array.from(hex.match(/../g) as string[], byte =>
    parseInt(byte, 16),
  )
}

/**
 * Everyone but this user who is in the conversation or sent one of `messages`, resolved the way
 * the rest of the app resolves a person: the contact's name, avatar and key when they are a
 * contact; otherwise their address, a generated avatar, and the key their first message here
 * was verified against.
 */
export function conversationSenders(
  conversation:
    | {
        participants?: readonly string[]
        members?: Record<string, { address: string; pubKeyHex?: string }>
      }
    | null
    | undefined,
  ownAddress: string | null | undefined,
  contacts: ContactLookup,
  messages: ReadonlyArray<{ outbound: boolean; senderAddress: string }> = [],
): Map<string, SenderIdentity> {
  const addresses = new Map<string, string>()
  for (const address of otherParticipants(
    conversation?.participants,
    ownAddress,
  ))
    addresses.set(key(address), address)
  for (const message of messages)
    if (!message.outbound && !addresses.has(key(message.senderAddress)))
      addresses.set(key(message.senderAddress), message.senderAddress)
  const members = Object.values(conversation?.members ?? {})
  return resolveSenders(
    Array.from(addresses.values()).map(address => {
      const inContacts = contacts.isContact(address)
      const profile = inContacts
        ? contacts.getContactProfile(address)
        : undefined
      const member = members.find(m => sameCanonicalAddress(m.address, address))
      return {
        address,
        inContacts,
        name: profile?.name,
        username: profile?.username,
        avatar: profile?.avatar,
        pubKey: profile?.pubKey?.toBuffer() ?? bytesFromHex(member?.pubKeyHex),
      }
    }),
  )
}

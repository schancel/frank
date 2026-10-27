import { isOpeningConversationId } from '@frank/cashweb/relay/conversation-id'

/**
 * Which conversations the conversation list shows. Opening a contact's chat (from Contacts, a
 * profile or a link) makes its default thread, but as in ordinary messengers that thread is not
 * listed until it has a message or a draft: an empty chat the user only looked at is not a
 * conversation. One that had messages and was cleared stays listed.
 * Every conversation the user created on purpose (a further conversation with a peer, with or
 * without a subject, a forum topic, a group, an email thread) is listed from the start.
 */
export interface ListableConversation {
  id: string
  kind: string
  name?: string
  topic?: string
  messages: readonly unknown[]
  /** Relay time of the newest message it ever had: a chat the user cleared stays listed. */
  lastReceived?: number
}

/**
 * `hasDraft` says whether the composer holds an unsent draft for the conversation; a default
 * thread with a draft is listed, so the draft can be found again.
 */
export function isListedConversation(
  conversation: ListableConversation,
  hasDraft: (conversation: ListableConversation) => boolean = () => false,
): boolean {
  const unopenedDefaultThread =
    conversation.kind === 'direct' &&
    isOpeningConversationId(conversation.id) &&
    !conversation.name &&
    !conversation.topic &&
    conversation.messages.length === 0 &&
    !conversation.lastReceived
  return !unopenedDefaultThread || hasDraft(conversation)
}

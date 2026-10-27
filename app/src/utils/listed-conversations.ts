/**
 * Which conversations the conversation list shows. Opening a contact's chat (from Contacts, a
 * profile or a link) makes its default thread, but as in ordinary messengers that thread is not
 * listed until it has a message: an empty chat the user only looked at is not a conversation.
 * One that had messages and was cleared stays listed.
 * A conversation the user created on purpose (a subject, a forum topic, a group, an email
 * thread) is listed from the start.
 */
export interface ListableConversation {
  kind: string
  name?: string
  topic?: string
  messages: readonly unknown[]
  /** Relay time of the newest message it ever had: a chat the user cleared stays listed. */
  lastReceived?: number
}

export function isListedConversation(
  conversation: ListableConversation,
): boolean {
  return !(
    conversation.kind === 'direct' &&
    !conversation.name &&
    !conversation.topic &&
    conversation.messages.length === 0 &&
    !conversation.lastReceived
  )
}

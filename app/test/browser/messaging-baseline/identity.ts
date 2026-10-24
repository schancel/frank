// A synthetic ready messaging capability. Startup publication is NOT measured in this slice.
export * from '../../../src/utils/identity-session.original'
import {
  messagingStateOwner,
  messagingState,
} from '../../../src/utils/messaging-state'
import { setConversationIdSalt } from '../../../src/stores/chats'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'
import { getWallet, initialize, peekWallet } from './runtime'
export { messagingState }
export const messagingWallet = peekWallet
export async function ensureConversationIdSalt() {
  setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(0x7e)))
}
export async function initializeMonadIdentity() {
  await initialize()
  await ensureConversationIdSalt()
  messagingStateOwner.status = 'ready'
  messagingStateOwner.reason = null
  return 'started' as const
}
export async function waitForMessagingReady() {
  await initializeMonadIdentity()
  return true
}
export async function startMessaging() {
  await initializeMonadIdentity()
}
export async function stopMessaging() {
  messagingStateOwner.status = 'pending'
}
export async function nameOwnProfile() {
  await getWallet()
}

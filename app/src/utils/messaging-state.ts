/**
 * Whether direct messaging is on, and if not, why. Written only by the messaging session
 * (`monad-identity-session.ts`); kept in its own small module so components can show it without
 * pulling in the wallet.
 */
import { reactive, readonly } from 'vue'

/** Why messaging is off. Each one has a plain sentence in the status banner. */
export type MessagingReason =
  | 'account-unavailable'
  | 'relay-unreachable'
  | 'relay-rejected'
  | 'relay-misconfigured'
  | 'entry-refused'
  | 'device-clock'
  | 'storage'

export interface MessagingState {
  status: 'pending' | 'publishing' | 'ready'
  /** Why messaging is off; `null` before the first attempt and while ready. */
  reason: MessagingReason | null
}

/** Mutable handle for the messaging session only. */
export const messagingStateOwner = reactive<MessagingState>({
  status: 'pending',
  reason: null,
})
export const messagingState = readonly(messagingStateOwner)

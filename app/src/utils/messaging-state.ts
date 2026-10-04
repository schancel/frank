/**
 * The visible state of direct messaging for the current account (#778): pending, checking or
 * ready, and why. Written only by `monad-identity-session.ts`; kept in its own small module so
 * panels that merely show it do not pull in the session, wallet and relay machinery.
 */
import { reactive, readonly } from 'vue'
import type {
  ParticipantStatuses,
  ReadinessReason,
} from './directory-readiness'

export interface MessagingState {
  status: 'pending' | 'checking' | 'ready'
  /** Why messaging is pending; `null` before the first check and while ready. */
  reason: ReadinessReason | null
  participants: ParticipantStatuses
  /** Address of the installed bot, shown once messaging is ready. */
  peerAddress: string | null
}

export const idleParticipants = (): ParticipantStatuses => ({
  'relay-a': 'unchecked',
  'relay-b': 'unchecked',
  'bot': 'unchecked',
})

/** Mutable handle for the session module only. Everything else reads `messagingState`. */
export const mutableMessagingState = reactive<MessagingState>({
  status: 'pending',
  reason: null,
  participants: idleParticipants(),
  peerAddress: null,
})
export const messagingState = readonly(mutableMessagingState)

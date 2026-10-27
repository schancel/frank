/**
 * Which call media a conversation can carry.
 *
 * `WebRtcCallSessionController` (webrtc-call-controller.ts) connects exactly one remote peer:
 * its invite is sent to the conversation's single peer, with voice or with video (screen sharing
 * is switched on from inside a connected call). Group calls are not implemented: the SFrame key
 * schedule in `@frank/wallet/message-item-plugins/webrtc-call/sframe-spec` has no SFU, signalling
 * or UI behind it. So a group conversation supports no call at all, and the header must offer
 * none rather than a button that cannot work.
 */
import { ACCOUNT_TYPE_BOT, ACCOUNT_TYPE_SERVICE } from '@frank/codec'

export type WebRtcCallMedia = 'audio' | 'video'

export interface CallConversation {
  /** A shared group mailbox, whatever its member count. */
  readonly group: boolean
  /** Participants other than this account. */
  readonly otherParticipantCount: number
  /** The peer's profile declares it a bot or a service (`isAutomatedAccount`): nobody there
   * answers a call. */
  readonly peerIsAutomated?: boolean
}

/** What a profile declares about itself: the bot marker, or a bot or service account type.
 * Never inferred from a name. */
export function isAutomatedAccount(
  profile:
    | { isBot?: boolean | null; accountType?: number | null }
    | null
    | undefined,
): boolean {
  return (
    profile?.isBot === true ||
    profile?.accountType === ACCOUNT_TYPE_BOT ||
    profile?.accountType === ACCOUNT_TYPE_SERVICE
  )
}

const ONE_TO_ONE: readonly WebRtcCallMedia[] = ['audio', 'video']
const NONE: readonly WebRtcCallMedia[] = []

/** The call media `conversation` supports; empty when calls are unsupported there. */
export function supportedCallMedia(
  conversation: CallConversation,
): readonly WebRtcCallMedia[] {
  return !conversation.group &&
    conversation.otherParticipantCount <= 1 &&
    !conversation.peerIsAutomated
    ? ONE_TO_ONE
    : NONE
}

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
export type WebRtcCallMedia = 'audio' | 'video'

export interface CallConversation {
  /** A shared group mailbox, whatever its member count. */
  readonly group: boolean
  /** Participants other than this account. */
  readonly otherParticipantCount: number
}

const ONE_TO_ONE: readonly WebRtcCallMedia[] = ['audio', 'video']
const NONE: readonly WebRtcCallMedia[] = []

/** The call media `conversation` supports; empty when calls are unsupported there. */
export function supportedCallMedia(
  conversation: CallConversation,
): readonly WebRtcCallMedia[] {
  return !conversation.group && conversation.otherParticipantCount <= 1
    ? ONE_TO_ONE
    : NONE
}

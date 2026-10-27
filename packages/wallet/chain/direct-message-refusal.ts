/**
 * Why a direct-message send the wallet refused before anything was paid or handed out can never
 * succeed as it is. Pure: reads the refusal, touches nothing. The app's failure reasons and the
 * bot host's reply handling read it, so a message refused this way is not sent again.
 */
import {
  MessageItemEncodeError,
  MessageItemUnsupportedError,
} from '@frank/cashweb/message-items/registry'
import { FrankCodecError } from '@frank/codec'
import { isDirectMessageNotAttempted } from './active-chain'
import { SealedSelfCopyTooLargeError } from './canonical-dm'

/** `too-large` when the message (or its note to self) is more than a direct message carries,
 * `unencodable` when an item cannot be encoded. Undefined for anything else, and for a refusal
 * the wallet did not label as having created nothing. */
export function unencodableReason(
  error: unknown,
): 'too-large' | 'unencodable' | undefined {
  if (!isDirectMessageNotAttempted(error)) return undefined
  if (
    error instanceof SealedSelfCopyTooLargeError ||
    (error instanceof FrankCodecError && error.category === 'resource') ||
    (error instanceof MessageItemEncodeError &&
      error.detail.startsWith('resource'))
  )
    return 'too-large'
  if (
    error instanceof MessageItemEncodeError ||
    error instanceof MessageItemUnsupportedError
  )
    return 'unencodable'
  return undefined
}

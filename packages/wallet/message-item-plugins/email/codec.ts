/**
 * An email item is the canonical type-26 frame. `encodeEmailItem` makes the same call the
 * canonical direct message path makes today (it passes the same fields, which do not include
 * `bcc`), so the bytes are identical; `decodeEmailItem` gives the same projection the receive path
 * gives.
 */
import {
  encodeEmailMessageItem,
  isEmailMessageItemFrame,
  projectEmailMessageItem,
} from '@frank/codec'
import type { EmailItem } from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  type MessageItemDecodeContext,
} from '../registry'
import { decodeWith, openItemFrame } from '../shared/frame'

export function encodeEmailItem(item: EmailItem): Uint8Array {
  return encodeEmailMessageItem({
    messageId: item.messageId,
    from: item.from,
    to: item.to,
    cc: item.cc,
    subject: item.subject,
    textBody: item.textBody,
    htmlBody: item.htmlBody,
    inReplyTo: item.inReplyTo,
    references: item.references,
    attachments: item.attachments,
    replyTo: item.replyTo,
  })
}

export function decodeEmailItem(
  bytes: Uint8Array,
  context: MessageItemDecodeContext,
): EmailItem {
  const parsed = openItemFrame('email', bytes, context)
  if (!isEmailMessageItemFrame(parsed))
    throw new MessageItemDecodeError('email', 'not an email item frame')
  return decodeWith('email', () => ({
    ...projectEmailMessageItem(parsed),
    type: 'email' as const,
  }))
}

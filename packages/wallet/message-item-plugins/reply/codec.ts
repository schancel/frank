import type { ReplyItem } from '@frank/cashweb/types/messages'

import { cborItemCodec, req, text } from '../shared/cbor-fields'

export const replyCodec = cborItemCodec<ReplyItem>('reply', {
  payloadDigest: req(0, text),
})

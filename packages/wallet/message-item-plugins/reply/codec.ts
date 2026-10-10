import type { ReplyItem } from '@frank/cashweb/types/messages'

import { cborItemCodec, req, token } from '../shared/cbor-fields'

export const replyCodec = cborItemCodec<ReplyItem>('reply', {
  // The key of the message replied to: a 64-hex payload digest, or a local key such as
  // `pending:<ms>:<seq>:<id>` for a message that has no digest yet.
  payloadDigest: req(0, token(128)),
})

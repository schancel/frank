/**
 * `GET /message/monad?since=<timestamp>` client (ticket #37's message-discovery route) --
 * ticket #9's bot needs this to poll for new messages without already knowing their
 * `payload_hash` out of band, which `MonadStampClient` (`./monad-stamp-client.ts`, ticket #13)
 * never needed since it only ever fetches a message it just submitted itself. No TS client for
 * this route existed yet: `monad_message_pb.js`/`.d.ts`'s own doc comment on
 * `StoredMonadMessages` said as much ("Not yet mirrored ... since the app doesn't consume this
 * endpoint yet -- regenerate those when it does") -- this ticket is that "when it does", so
 * `generate_protobufs.sh` was re-run to add the `StoredMonadMessages` binding this file decodes.
 *
 * See `../../../backend/cashweb/cashweb-registry/src/http/monad_message.rs`'s module docs (the
 * "Message discovery" section) for why this endpoint can't filter by recipient server-side, and
 * `./monad-message-envelope.ts` for how this ticket works around that client-side.
 */
import axios from 'axios'

import { StoredMonadMessages } from './monad_message_pb'
import { StoredMonadMessageProto } from './monad-stamp-client'

/** `GET /message/monad?since=<sinceMs>`: every `StoredMonadMessage` the relay has stored at or
 * after `sinceMs` (milliseconds since the Unix epoch), ordered by `timestamp` ascending (the
 * server's own contract -- see that route's doc comment). */
export async function fetchMonadMessagesSince(params: {
  relayBaseUrl: string
  sinceMs: number
}): Promise<StoredMonadMessageProto[]> {
  const response = await axios({
    method: 'get',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/message/monad`,
    params: { since: params.sinceMs },
    responseType: 'arraybuffer',
  })
  const decoded = StoredMonadMessages.deserializeBinary(
    new Uint8Array(response.data),
  )
  return decoded.getMessagesList().map(stored => {
    const nested = stored.getMessage()
    return {
      message: nested
        ? {
            rawBurnTx: nested.getRawBurnTx_asU8(),
            encryptedPayload: nested.getEncryptedPayload_asU8(),
            payloadHash: nested.getPayloadHash_asU8(),
          }
        : undefined,
      senderAddress: stored.getSenderAddress_asU8(),
      txHash: stored.getTxHash_asU8(),
      timestamp: stored.getTimestamp(),
    }
  })
}

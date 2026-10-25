import { MessageItem } from './messages'
import { Utxo } from './utxo'

/** Contact placeholder on a received message. Callers read toBuffer(). */
export interface CopartyPubKey {
  toBuffer(): Uint8Array
}

export interface UIStealthOutput {
  type: 'stealth'
  txId: string
  satoshis: number
  outputIndex: number
}

export interface UIStampOutput {
  type: 'stamp'
  txId: string
  satoshis: number
  outputIndex: number
}

export type UIOutput = UIStealthOutput | UIStampOutput

export type ReceivedMessage = {
  outbound: boolean
  status: string
  items: MessageItem[]
  serverTime: number
  receivedTime: number
  outpoints: Utxo[]
  senderAddress: string
  destinationAddress: string
  /** See `../types/messages.ts`'s `Message.stampValueWei` -- same additive field, mirrored here
   * since `stores/chats.ts`'s `receiveMessages` re-types `ReceivedMessageWrapper.message` as
   * `Message` (ticket #42). */
  stampValueWei?: bigint
  stampPayments?: Array<{
    txHash: string
    destinationAddress: string
    valueWei: bigint
  }>
  conversationId?: string
  /** The conversation subject this message carries (a first message or a rename), if any. */
  conversationName?: string
  logicalMessageId?: string
  /** Authenticated canonical type-20 content digest (bare lowercase 64-hex), when available.
   * Describes the original content frame, not an edit or a delivery/payment identity. */
  contentDigest?: string
}

export type ReceivedMessageWrapper = {
  outbound: boolean
  senderAddress: string
  copartyAddress: string
  copartyPubKey: CopartyPubKey
  index: string
  stampValue: number
  message: Readonly<ReceivedMessage>
  conversationId?: string
}

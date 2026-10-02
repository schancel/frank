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
}

export type ReceivedMessageWrapper = {
  outbound: boolean
  senderAddress: string
  copartyAddress: string
  copartyPubKey: CopartyPubKey
  index: string
  stampValue: number
  message: Readonly<ReceivedMessage>
}

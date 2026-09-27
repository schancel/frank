import { Utxo } from './utxo'

export interface ReplyItem {
  type: 'reply'
  payloadDigest: string
}

export interface TextItem {
  type: 'text'
  text: string
}

export interface P2PKHSendItem {
  type: 'p2pkh'
  address: string
  amount: number
}

export interface StealthItem {
  type: 'stealth'
  amount: number
  txId?: string
  outputIndex?: number
}

export interface ImageItem {
  type: 'image'
  image: string
}

export type MessageItem =
  | StealthItem
  | P2PKHSendItem
  | TextItem
  | ReplyItem
  | ImageItem

export interface Message {
  outbound: boolean
  status: string
  receivedTime: number
  serverTime: number
  items: Array<MessageItem>
  outpoints: Array<Utxo>
  senderAddress: string
  /** Wei burned in this message's stamp transaction, for chains (Monad, ticket #42) that have no
   * UTXO/`outpoints` equivalent -- see `stores/chats.ts`'s header for the decision to add this
   * additively alongside `outpoints` rather than replace it. Always `undefined` for Lotus-origin
   * messages (`outpoints` is authoritative for those). */
  burnValueWei?: bigint
}

export interface MessageWrapper {
  message: Message
  index: string
  outbound: boolean
  senderAddress: string
  copartyAddress: string
}

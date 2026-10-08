// Encoding, decoding, and validation for Type 6 CBOR token transfers (docs/protocol/cbor).

import { cborMap, decodeCanonical, encodeCanonical } from './cbor'
import { TYPE_ENCRYPTED_MESSAGE_CONTENT } from './constants'
import { encodeFrame } from './frame'
import { messageContentDigest } from './hash'
import { tokenTransfer } from './schema'
import { checkTokenTransferSemantics } from './semantic'
import type {
  EncryptedMessageContent,
  ParsedFrame,
  TokenTransfer,
} from './types'
import { defaultContext, validateFrame } from './validate'

export function encodeTokenTransferMap(
  transfer: TokenTransfer,
): Map<number | bigint, any> {
  checkTokenTransferSemantics(transfer, 'token-transfer')

  const entries: Array<[number, any]> = [
    [1, transfer.chainNamespace],
    [2, transfer.contractAddress],
    [3, transfer.amount],
    [4, transfer.decimals],
    [5, transfer.symbol],
  ]
  if (transfer.rawTxOrPermit !== undefined) {
    entries.push([6, transfer.rawTxOrPermit])
  }
  return cborMap(entries)
}

export function encodeTokenTransfer(transfer: TokenTransfer): Uint8Array {
  return encodeCanonical(encodeTokenTransferMap(transfer))
}

export function decodeTokenTransfer(bytes: Uint8Array): TokenTransfer {
  const cbor = decodeCanonical(bytes)
  const parsed = tokenTransfer(cbor)
  checkTokenTransferSemantics(parsed, 'token-transfer')
  return parsed
}

export interface EncryptedMessageContentFields {
  network: string
  messageId: Uint8Array
  conversationId: Uint8Array
  revisionFrame: Uint8Array
  contentDigest?: Uint8Array
  conversationName?: string
  tokenTransfer?: TokenTransfer
}

export function encodeEncryptedMessageContent(
  fields: EncryptedMessageContentFields,
): Uint8Array {
  const digest =
    fields.contentDigest ?? messageContentDigest(fields.revisionFrame)
  const entries: Array<[number, any]> = [
    [0, fields.network],
    [1, fields.messageId],
    [2, fields.revisionFrame],
    [3, digest],
    [4, fields.conversationId],
  ]
  if (fields.conversationName !== undefined) {
    entries.push([5, fields.conversationName])
  }
  if (fields.tokenTransfer !== undefined) {
    entries.push([6, encodeTokenTransferMap(fields.tokenTransfer)])
  }
  const payload = encodeCanonical(cborMap(entries))
  return encodeFrame(
    {
      typeId: TYPE_ENCRYPTED_MESSAGE_CONTENT,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    { bytes: payload },
  )
}

export function decodeEncryptedMessageContent(
  bytes: Uint8Array,
): EncryptedMessageContent<ParsedFrame> {
  const parsed = validateFrame(bytes, defaultContext())
  if (parsed.kind !== 'parsed') {
    throw new Error(`expected parsed frame, got ${parsed.kind}`)
  }
  if (parsed.typed?.type !== TYPE_ENCRYPTED_MESSAGE_CONTENT) {
    throw new Error(
      `expected Type 6 EncryptedMessageContent, got type ${parsed.typed?.type}`,
    )
  }
  return parsed.typed as EncryptedMessageContent<ParsedFrame>
}

// Encoding, decoding, and validation for Type 12 CBOR token transfers (docs/protocol/cbor).

import { cborMap, decodeCanonical, encodeCanonical } from './cbor'
import {
  ENCRYPTED_MESSAGE_CONTENT,
  TOKEN_TRANSFER,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
} from './constants'
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
    [TOKEN_TRANSFER.chainNamespace, transfer.chainNamespace],
    [TOKEN_TRANSFER.contractAddress, transfer.contractAddress],
    [TOKEN_TRANSFER.amount, transfer.amount],
    [TOKEN_TRANSFER.decimals, transfer.decimals],
    [TOKEN_TRANSFER.symbol, transfer.symbol],
  ]
  if (transfer.rawTxOrPermit !== undefined) {
    entries.push([TOKEN_TRANSFER.rawTxOrPermit, transfer.rawTxOrPermit])
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
    [ENCRYPTED_MESSAGE_CONTENT.network, fields.network],
    [ENCRYPTED_MESSAGE_CONTENT.messageId, fields.messageId],
    [ENCRYPTED_MESSAGE_CONTENT.revisionFrame, fields.revisionFrame],
    [ENCRYPTED_MESSAGE_CONTENT.contentDigest, digest],
    [ENCRYPTED_MESSAGE_CONTENT.conversationId, fields.conversationId],
  ]
  if (fields.conversationName !== undefined) {
    entries.push([
      ENCRYPTED_MESSAGE_CONTENT.conversationName,
      fields.conversationName,
    ])
  }
  if (fields.tokenTransfer !== undefined) {
    entries.push([
      ENCRYPTED_MESSAGE_CONTENT.tokenTransfer,
      encodeTokenTransferMap(fields.tokenTransfer),
    ])
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
      `expected Type 12 EncryptedMessageContent, got type ${parsed.typed?.type}`,
    )
  }
  return parsed.typed as EncryptedMessageContent<ParsedFrame>
}

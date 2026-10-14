// Pure encoder, validator, and projection for Type 26 email bridge message item (RFC 8949 CBOR).

import { cborMap } from './cbor'
import {
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES,
  MAX_EMAIL_RECIPIENTS,
  TYPE_EMAIL_MESSAGE_ITEM,
} from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { utf8Encode } from './utf8'
import type {
  AccountRef,
  EmailAttachment,
  EmailMessageItem,
  EmailParty,
  ParsedFrame,
  UnknownFields,
  ValidationResult,
} from './types'
import {
  defaultContext,
  validateFrame,
  type ValidationContext,
} from './validate'

const bad = (msg: string, location = 'email-message-item') =>
  new FrankCodecError('schema', '8.2', msg, location)

function requireTextBytes(
  value: string,
  field: string,
  min: number,
  max: number,
): void {
  const length = value === undefined ? -1 : utf8Encode(value).length
  if (length < min || length > max) {
    throw bad(`${field} must be ${min}..${max} UTF-8 bytes`)
  }
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const g = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined
  if (g && typeof g.atob === 'function') {
    const bin: string = g.atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    return bytes
  }
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = new Uint8Array(256)
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i
  let len = b64.length
  if (b64.endsWith('==')) len -= 2
  else if (b64.endsWith('=')) len -= 1
  const bytes = new Uint8Array((len * 3) >> 2)
  let a = 0,
    b = 0,
    c = 0,
    d = 0,
    p = 0
  for (let i = 0; i < b64.length; i += 4) {
    a = lookup[b64.charCodeAt(i)]
    b = lookup[b64.charCodeAt(i + 1)]
    c = lookup[b64.charCodeAt(i + 2)]
    d = lookup[b64.charCodeAt(i + 3)]
    bytes[p++] = (a << 2) | (b >> 4)
    if (p < bytes.length) bytes[p++] = ((b & 15) << 4) | (c >> 2)
    if (p < bytes.length) bytes[p++] = ((c & 3) << 6) | (d & 63)
  }
  return bytes
}

export interface CanonicalEmailMessageItem {
  messageId: string
  from: EmailParty
  to: EmailParty[]
  cc?: EmailParty[]
  subject: string
  textBody: string
  htmlBody?: string
  inReplyTo?: string
  references?: string[]
  attachments?: EmailAttachment[]
  replyTo?: EmailParty
  unknownFields?: UnknownFields
}

export function encodeEmailParty(party: EmailParty): Map<number | bigint, any> {
  requireTextBytes(party.address, 'party address', 3, 320)
  const entries: Array<[number, any]> = [[0, party.address]]
  if (party.name !== undefined) {
    requireTextBytes(party.name, 'party name', 1, 256)
    entries.push([1, party.name])
  }
  if (party.frankAccount !== undefined) {
    if (party.frankAccount.keyBytes.length !== 33) {
      throw bad('party frankAccount requires 33 key bytes')
    }
    entries.push([
      2,
      cborMap([
        [0, party.frankAccount.keyType],
        [1, party.frankAccount.keyBytes],
      ]),
    ])
  }
  if (party.unknownFields) {
    for (const [k, v] of party.unknownFields) {
      entries.push([Number(k), v])
    }
  }
  return cborMap(entries)
}

export function encodeEmailAttachment(
  att: EmailAttachment,
): Map<number | bigint, any> {
  requireTextBytes(att.filename, 'attachment filename', 1, 256)
  requireTextBytes(att.contentType, 'attachment contentType', 1, 128)
  let content = att.content
  if (!content && att.dataBase64) {
    const clean = att.dataBase64
      .replace(/^data:[^;]+;base64,/, '')
      .replace(/\s+/g, '')
    content = decodeBase64ToBytes(clean)
  }
  if (!content) {
    content = new Uint8Array(0)
  }
  if (content.length > 8_388_608) {
    throw bad('attachment content exceeds 8388608 bytes')
  }
  const entries: Array<[number, any]> = [
    [0, att.filename],
    [1, att.contentType],
    [2, content],
  ]
  if (att.contentId !== undefined) {
    requireTextBytes(att.contentId, 'attachment contentId', 1, 128)
    entries.push([3, att.contentId])
  }
  if (att.unknownFields) {
    for (const [k, v] of att.unknownFields) {
      entries.push([Number(k), v])
    }
  }
  return cborMap(entries)
}

/**
 * Encodes a canonical Type 26 email message item frame.
 */
export function encodeEmailMessageItem(
  email: CanonicalEmailMessageItem,
): Uint8Array {
  requireTextBytes(email.messageId, 'messageId', 1, 256)
  if (
    !email.to ||
    email.to.length === 0 ||
    email.to.length > MAX_EMAIL_RECIPIENTS
  ) {
    throw bad(`to must contain 1..${MAX_EMAIL_RECIPIENTS} recipients`)
  }
  if (email.cc && email.cc.length > MAX_EMAIL_RECIPIENTS) {
    throw bad(`cc must not exceed ${MAX_EMAIL_RECIPIENTS} recipients`)
  }
  requireTextBytes(email.subject, 'subject', 0, 1024)
  requireTextBytes(email.textBody, 'textBody', 0, 262144)
  if (email.htmlBody !== undefined) {
    requireTextBytes(email.htmlBody, 'htmlBody', 0, 524288)
  }
  if (email.inReplyTo !== undefined) {
    requireTextBytes(email.inReplyTo, 'inReplyTo', 1, 256)
  }
  if (email.references && email.references.length > 64) {
    throw bad('references must not exceed 64 items')
  }
  for (const reference of email.references ?? []) {
    requireTextBytes(reference, 'reference', 1, 256)
  }
  if (email.attachments && email.attachments.length > MAX_EMAIL_ATTACHMENTS) {
    throw bad(`attachments must not exceed ${MAX_EMAIL_ATTACHMENTS} items`)
  }

  const entries: Array<[number, any]> = [
    [0, email.messageId],
    [1, encodeEmailParty(email.from)],
    [2, email.to.map(encodeEmailParty)],
  ]
  if (email.cc && email.cc.length > 0) {
    entries.push([3, email.cc.map(encodeEmailParty)])
  }
  entries.push([4, email.subject])
  entries.push([5, email.textBody])
  if (email.htmlBody !== undefined) {
    entries.push([6, email.htmlBody])
  }
  if (email.inReplyTo !== undefined) {
    entries.push([7, email.inReplyTo])
  }
  if (email.references && email.references.length > 0) {
    entries.push([8, email.references])
  }
  if (email.attachments && email.attachments.length > 0) {
    entries.push([9, email.attachments.map(encodeEmailAttachment)])
  }
  if (email.replyTo !== undefined) {
    entries.push([10, encodeEmailParty(email.replyTo)])
  }
  if (email.unknownFields) {
    for (const [k, v] of email.unknownFields) {
      entries.push([Number(k), v])
    }
  }

  const frameBytes = encodeFrame(
    {
      typeId: TYPE_EMAIL_MESSAGE_ITEM,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    cborMap(entries),
  )

  if (frameBytes.length > MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES) {
    throw bad(
      `frame exceeds maximum length of ${MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES} bytes`,
    )
  }

  return frameBytes
}

/**
 * Checks if a parsed frame is a valid Type 26 email message item.
 */
export function isEmailMessageItemFrame(
  frame: ValidationResult,
): frame is ParsedFrame & { typed: EmailMessageItem } {
  return (
    frame.kind === 'parsed' &&
    frame.typeId === TYPE_EMAIL_MESSAGE_ITEM &&
    frame.typed?.type === 23
  )
}

/**
 * Projects a validated parsed Type 23 frame into its typed payload.
 */
export function projectEmailMessageItem(frame: ParsedFrame): EmailMessageItem {
  if (!isEmailMessageItemFrame(frame)) {
    throw bad('frame is not a valid email message item')
  }
  return frame.typed
}

/**
 * Validates raw frame bytes as a Type 23 email message item through stages 1-9.
 */
export function validateEmailMessageItem(
  frameBytes: Uint8Array,
  context?: Partial<ValidationContext>,
): ParsedFrame & { typed: EmailMessageItem } {
  const ctx = defaultContext(context)
  const result = validateFrame(frameBytes, ctx)
  if (result.kind !== 'parsed') {
    throw bad(`expected parsed frame, got ${result.kind}`)
  }
  if (!isEmailMessageItemFrame(result)) {
    throw bad(`expected Type 23 frame, got type ${result.typeId}`)
  }
  return result
}

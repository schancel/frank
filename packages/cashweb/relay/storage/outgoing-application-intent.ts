import protocol from '../../../../docs/protocol/chains/v1.json'
import { pointMultiply } from '@frank/nakamoto'

export interface OutgoingApplicationMessageClaim {
  readonly version: 1
  readonly intentKey: string
  readonly accountId: string
  readonly signerKeyId: string
  readonly messagingChainIdentifier: string
  readonly recipientPublicKey: string
  readonly conversationId: string
  readonly stampValueWei: string
  readonly intentHex: string
}
export type OutgoingApplicationMessageRecord = OutgoingApplicationMessageClaim &
  (
    | { readonly phase: 'claimed' }
    | {
        readonly phase: 'signed'
        readonly signedPayloadHex: string
        readonly messageId: string
      }
  )
export interface OutgoingApplicationMessageCompletion {
  readonly claim: OutgoingApplicationMessageClaim
  readonly signedPayloadHex: string
  readonly messageId: string
}

export const outgoingApplicationIntentPrefix = 'outgoingApplicationIntent:'
const fields = [
  'version',
  'intentKey',
  'accountId',
  'signerKeyId',
  'messagingChainIdentifier',
  'recipientPublicKey',
  'conversationId',
  'stampValueWei',
  'intentHex',
]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digest = /^[0-9a-f]{64}$/
function object(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid outgoing application intent')
  if (
    Reflect.ownKeys(value).some(
      key => typeof key !== 'string' || !allowed.includes(key),
    )
  )
    throw new Error('Unknown outgoing application intent field')
  // Snapshot each own field once; caller getters and later mutations cannot alter validation.
  return Object.fromEntries(
    Object.keys(value).map(key => [
      key,
      (value as Record<string, unknown>)[key],
    ]),
  )
}
function hex(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 8192 &&
    /^(?:[0-9a-f]{2})+$/.test(value)
  )
}
export function outgoingApplicationAccount(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    new TextEncoder().encode(value).length > 512
  )
    throw new Error('Invalid outgoing application account')
  return value
}
export function outgoingApplicationKey(value: unknown): string {
  if (typeof value !== 'string' || !digest.test(value))
    throw new Error('Invalid outgoing application intent key')
  return value
}
function parseClaim(
  row: Record<string, unknown>,
): OutgoingApplicationMessageClaim {
  if (fields.some(key => !Object.prototype.hasOwnProperty.call(row, key)))
    throw new Error('Invalid outgoing application claim: missing field')
  const accountId = outgoingApplicationAccount(row.accountId)
  const intentKey = outgoingApplicationKey(row.intentKey)
  if (
    row.version !== 1 ||
    typeof row.signerKeyId !== 'string' ||
    !digest.test(row.signerKeyId) ||
    typeof row.messagingChainIdentifier !== 'string' ||
    !protocol.chains.some(chain => chain.id === row.messagingChainIdentifier) ||
    typeof row.recipientPublicKey !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(row.recipientPublicKey) ||
    typeof row.conversationId !== 'string' ||
    !uuid.test(row.conversationId) ||
    typeof row.stampValueWei !== 'string' ||
    row.stampValueWei.length > 78 ||
    !/^(0|[1-9][0-9]*)$/.test(row.stampValueWei) ||
    BigInt(row.stampValueWei) >= 1n << 256n ||
    !hex(row.intentHex)
  )
    throw new Error('Invalid outgoing application claim')
  const scalar = new Uint8Array(32)
  scalar[31] = 1
  const key = Uint8Array.from(row.recipientPublicKey.match(/../g)!, pair =>
    parseInt(pair, 16),
  )
  // Multiplication by one uses Nakamoto's public point parser; this does not sign.
  if (!pointMultiply(key, scalar).ok)
    throw new Error('Invalid outgoing application recipient key')
  // Explicit order is the canonical serialization; no caller objects are retained.
  return Object.freeze({
    version: 1,
    intentKey,
    accountId,
    signerKeyId: row.signerKeyId,
    messagingChainIdentifier: row.messagingChainIdentifier,
    recipientPublicKey: row.recipientPublicKey,
    conversationId: row.conversationId,
    stampValueWei: row.stampValueWei,
    intentHex: row.intentHex,
  })
}
export function outgoingApplicationClaim(
  value: unknown,
): OutgoingApplicationMessageClaim {
  return parseClaim(object(value, fields))
}
export function outgoingApplicationRecord(
  value: unknown,
): OutgoingApplicationMessageRecord {
  const row = object(value, [
    ...fields,
    'phase',
    'signedPayloadHex',
    'messageId',
  ])
  const claim = parseClaim(row)
  if (
    row.phase === 'claimed' &&
    !('signedPayloadHex' in row) &&
    !('messageId' in row)
  )
    return Object.freeze({ ...claim, phase: 'claimed' })
  if (
    row.phase === 'signed' &&
    hex(row.signedPayloadHex) &&
    typeof row.messageId === 'string' &&
    uuid.test(row.messageId)
  )
    return Object.freeze({
      ...claim,
      phase: 'signed',
      signedPayloadHex: row.signedPayloadHex,
      messageId: row.messageId,
    })
  throw new Error('Invalid outgoing application record phase')
}
export function outgoingApplicationCompletion(
  value: unknown,
): OutgoingApplicationMessageRecord {
  const row = object(value, ['claim', 'signedPayloadHex', 'messageId'])
  return outgoingApplicationRecord({
    ...outgoingApplicationClaim(row.claim),
    phase: 'signed',
    signedPayloadHex: row.signedPayloadHex,
    messageId: row.messageId,
  })
}
export function outgoingApplicationStoredRow(
  key: string,
  value: string,
): OutgoingApplicationMessageRecord {
  const row = outgoingApplicationRecord(JSON.parse(value))
  if (key !== outgoingApplicationIntentPrefix + row.intentKey)
    throw new Error('Outgoing application intent key conflicts with record')
  return row
}
/** Expected refusals are known not to have committed and do not poison the owner. */
export class OutgoingApplicationIntentRefusal extends Error {}
export function resolveOutgoingApplicationIntent(
  requested: OutgoingApplicationMessageRecord,
  rows: readonly OutgoingApplicationMessageRecord[],
): OutgoingApplicationMessageRecord {
  const existing = rows.find(row => row.intentKey === requested.intentKey)
  if (existing) {
    const claim = (row: OutgoingApplicationMessageRecord) => {
      const { phase: _phase, ...rest } = row
      if ('signedPayloadHex' in rest) {
        const { signedPayloadHex: _payload, messageId: _id, ...facts } = rest
        return JSON.stringify(facts)
      }
      return JSON.stringify(rest)
    }
    if (claim(existing) !== claim(requested))
      throw new OutgoingApplicationIntentRefusal(
        'Outgoing application intent conflict',
      )
    if (requested.phase === 'claimed') return existing
    if (existing.phase === 'claimed') return requested
    if (JSON.stringify(existing) === JSON.stringify(requested)) return existing
    throw new OutgoingApplicationIntentRefusal(
      'Outgoing application completion conflict',
    )
  }
  if (requested.phase === 'signed')
    throw new OutgoingApplicationIntentRefusal(
      'Outgoing application claim missing',
    )
  if (rows.filter(row => row.accountId === requested.accountId).length >= 128)
    throw new OutgoingApplicationIntentRefusal(
      'Outgoing application intent capacity exceeded',
    )
  return requested
}

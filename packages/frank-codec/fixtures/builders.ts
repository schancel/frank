// Deterministic builders for the positive fixtures and for the hostile-vector corpus. Only the
// codec's encoder is used to produce canonical bytes; hostile bytes are written by hand.
import { Encodable, cborMap, encodeCanonical } from '../src/cbor'
import { encodeFrame, wrapFrame } from '../src/frame'
import {
  commonTranscript,
  fromHex,
  messageContentDigest,
  paymentCommitment,
  recipientPayloadDigest,
} from '../src/hash'
import type { TokenTransfer } from '../src/types'
import { encodeTokenTransferMap } from '../src/token-transfer'

export type Fields = Map<number, Encodable>

export const NET = 'frank-test'

export const hex = (s: string): Uint8Array => fromHex(s.replace(/\s+/g, ''))
export const M = (entries: Array<[number, Encodable]>): Fields =>
  new Map(entries)

/** Deterministic filler bytes. */
export function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (seed * 37 + i * 11 + 5) & 0xff
  return out
}

/** Key type 1: 33-byte compressed SEC1 key (first byte 02, then filler). */
export function acct1(seed: number): Fields {
  const k = new Uint8Array(33)
  k[0] = 0x02
  k.set(bytesOf(32, seed), 1)
  return M([
    [0, 1],
    [1, k],
  ])
}

/** Key type 2: 32-byte Ed25519 key. The first byte is `seed`, so seeds order keys. */
export function acct2(seed: number): Fields {
  const k = bytesOf(32, seed)
  k[0] = seed
  return M([
    [0, 2],
    [1, k],
  ])
}

export const ts = (seconds: bigint | number, nanos: number): Fields =>
  M([
    [0, seconds],
    [1, nanos],
  ])

/**
 * A frame around `payload`. Type 4 is written at `schema_version` 2 with `min_reader_version` 2
 * by default, because its stamp key (field 8) is required from schema 2 (README S10a.1); every
 * other type is version 1.
 */
export const fr = (
  typeId: number,
  payload: Encodable,
  schema = typeId === 4 ? 2 : 1,
  minReader = typeId === 4 ? 2 : 1,
): Uint8Array =>
  encodeFrame(
    { typeId, schemaVersion: schema, minReaderVersion: minReader },
    payload,
  )

export const frRaw = (
  typeId: number,
  payloadBytes: Uint8Array,
  schema = 1,
  minReader = 1,
): Uint8Array =>
  encodeFrame(
    { typeId, schemaVersion: schema, minReaderVersion: minReader },
    { bytes: payloadBytes },
  )

/** A complete frame around arbitrary (possibly hostile) envelope body bytes. */
export const body = (b: Uint8Array | string, version = 1): Uint8Array =>
  wrapFrame(typeof b === 'string' ? hex(b) : b, version)

/** A frame whose declared length is overridden. */
export function withLength(frame: Uint8Array, declared: number): Uint8Array {
  const out = frame.slice()
  out[5] = (declared >>> 24) & 0xff
  out[6] = (declared >>> 16) & 0xff
  out[7] = (declared >>> 8) & 0xff
  out[8] = declared & 0xff
  return out
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Hand-written canonical envelope body around raw payload bytes (for hostile frames). */
export function envBody(
  typeId: number,
  schema: number,
  min: number,
  payload: Uint8Array,
): Uint8Array {
  return encodeCanonical(
    cborMap([
      [0, typeId],
      [1, schema],
      [2, min],
      [3, payload],
    ]),
  )
}

/** A well-formed frame whose payload item is the given raw (possibly hostile) bytes. */
export const framePayload = (
  payload: Uint8Array | string,
  typeId = 17,
  schema = 1,
  min = 1,
): Uint8Array =>
  frRaw(
    typeId,
    typeof payload === 'string' ? hex(payload) : payload,
    schema,
    min,
  )

// ---------------------------------------------------------------------------------------------
// Message items (types 16, 17, unknown)
// ---------------------------------------------------------------------------------------------

export const textItem = (s = 'hello'): Uint8Array => fr(17, M([[0, s]]))
export const containerItem = (children: Uint8Array[]): Uint8Array =>
  fr(16, M([[0, children]]))
export const UNKNOWN_TYPE = 0xffff0001
export const unknownItem = (n = 1): Uint8Array =>
  fr(UNKNOWN_TYPE, M([[0, `future item ${n}`]]))
export const revision8 = (items: Uint8Array[]): Fields =>
  M([
    [0, 'frank'],
    [1, items],
  ])

/** The README section 1 worked example: a type-17 item `{0: "hi"}` (23 bytes). */
export const WORKED_TEXT_HI = hex(
  '46524e4b010000000e a4 0011 0101 0201 0345 a1 00 62 6869',
)
/** The README section 1 retention example: `0xffff0001`, payload `a0`. */
export const WORKED_RETAINED = hex(
  '46524e4b010000000ea4001affff0001010102010341a0',
)

// ---------------------------------------------------------------------------------------------
// Direct messages (types 1, 5, 6, 8)
// ---------------------------------------------------------------------------------------------

/** The nested, recursive type-8 revision used by the direct-message fixture. */
export function nestedItems(): Uint8Array[] {
  return [
    textItem('hello from the browser codec'),
    containerItem([
      textItem('nested text'),
      unknownItem(1),
      containerItem([textItem('two levels down')]),
    ]),
  ]
}

export const rev8Frame = (items = nestedItems()): Uint8Array =>
  fr(8, revision8(items))

export const DEFAULT_CONVERSATION_ID = bytesOf(16, 8)

export function type6Frame(
  rev8 = rev8Frame(),
  conversationId = DEFAULT_CONVERSATION_ID,
  conversationName?: string,
  tokenTransfer?: TokenTransfer,
): Uint8Array {
  const entries: [number, any][] = [
    [0, NET],
    [1, bytesOf(16, 7)],
    [2, rev8],
    [3, messageContentDigest(rev8)],
    [4, conversationId],
  ]
  if (conversationName !== undefined) {
    entries.push([5, conversationName])
  }
  if (tokenTransfer !== undefined) {
    entries.push([6, encodeTokenTransferMap(tokenTransfer)])
  }
  return fr(6, M(entries))
}

/**
 * README T3c worked example (network `monad`): `P'`, `E`, `X` and the DLEQ proof `c || s`.
 * Real curve points and a real proof, so a type-5 frame built from them passes the T3b encoding
 * rules. The typed fixtures use a different network tag, so the proof is not verifiable there;
 * stage 10 is a later step and typed frames never claim it.
 */
export const T3C = {
  stampKey: hex(
    '03f7fc9b839b4c4c8ff821777ecc410b461d6ca6b36e931ddbfadda8b37a55ae33',
  ),
  ephemeral: hex(
    '022f88fd8059bf1bfda332a2ff01f4667efdc1d8526562ecbd6bcac57ace81b6c3',
  ),
  shared: hex(
    '02d066aa56e65e5cba4051500237a51ae9fd16c2c3476904d47d667f9fe1fca3e9',
  ),
  proof: hex(
    'bf8f2ddfeb72fb808d95507bf325ca2e09ea762fd874aef4422a74b7b82e327d' +
      'a6708a4fa9553e426718e3cf8ed714d75546b0458f8a4ef1820c30dce4b0163a',
  ),
} as const

/** A key-type-1 account holding `key` (default: the T3c stamp key `P'`). */
export const stampAccount = (key: Uint8Array = T3C.stampKey): Fields =>
  M([
    [0, 1],
    [1, key],
  ])

export function type5Payload(
  o: Partial<{
    net: string
    recipient: Fields
    suite: number
    e: Encodable
    x: Encodable
    proof: Encodable
  }> = {},
): Fields {
  return M([
    [0, o.net ?? NET],
    [1, acct2(9)],
    [2, o.recipient ?? acct1(3)],
    [3, o.suite ?? 65535],
    [4, bytesOf(24, 4)],
    // Proof suite 65535: the ciphertext is exactly the decrypted type-6 frame (README S2c).
    [5, type6Frame()],
    [6, o.e ?? T3C.ephemeral],
    [7, o.x ?? T3C.shared],
    [8, o.proof ?? T3C.proof],
  ])
}

export const type5Frame = (
  o?: Parameters<typeof type5Payload>[0],
): Uint8Array => fr(5, type5Payload(o))

export interface PaymentOpts {
  index: number
  txSeed?: number
  addrSeed?: number
}

/**
 * Payment member. The address bytes are placeholders: the T3a derivation is out of scope for
 * this ticket, so the fixtures are `typed` cases and never claim `full` validity. The T4
 * commitment is real.
 */
export function payment(t3: Uint8Array, o: PaymentOpts): Fields {
  const value = new Uint8Array(32)
  value[31] = 1 + (o.index % 200)
  value[30] = 0x0f
  return M([
    [0, o.index],
    [1, bytesOf(32, o.txSeed ?? 100 + o.index)],
    [2, value],
    [3, bytesOf(20, o.addrSeed ?? 50 + o.index)],
    [4, paymentCommitment(t3, o.index)],
  ])
}

export function deliveryPayload(
  o: Partial<{
    net: string
    destination: Fields
    payloadFrame: Uint8Array
    payments: Fields[] | number
    recipient: Fields
    dleqProof: Uint8Array
  }> = {},
): Fields {
  const pf = o.payloadFrame ?? type5Frame()
  const t3 = recipientPayloadDigest(NET, pf)
  const payments =
    typeof o.payments === 'number'
      ? Array.from({ length: o.payments }, (_, i) => payment(t3, { index: i }))
      : o.payments ?? [payment(t3, { index: 0 }), payment(t3, { index: 1 })]
  const m = M([
    [0, o.net ?? NET],
    [1, o.destination ?? stampAccount()],
    [2, pf],
    [3, t3],
    [4, payments],
  ])
  if (o.recipient !== undefined) m.set(5, o.recipient)
  if (o.dleqProof !== undefined) m.set(6, o.dleqProof)
  return m
}

export const deliveryFrame = (
  o?: Parameters<typeof deliveryPayload>[0],
): Uint8Array => fr(1, deliveryPayload(o))

export { recipientPayloadDigest }

// ---------------------------------------------------------------------------------------------
// Topic events (types 9, 10, 11)
// ---------------------------------------------------------------------------------------------

export function topicPostPayload(
  o: Partial<{
    net: string
    topic: string
    parent: Uint8Array | null
    body: Uint8Array
  }> = {},
): Fields {
  const m = M([
    [0, o.net ?? NET],
    [1, o.topic ?? 'frank.demo'],
    [3, o.body ?? bytesOf(64, 21)],
  ])
  if (o.parent !== null && o.parent !== undefined) m.set(2, o.parent)
  return m
}

export const topicPostFrame = (
  o?: Parameters<typeof topicPostPayload>[0],
): Uint8Array => fr(9, topicPostPayload(o))

/** Filler for the raw signed chain transaction: the codec never opens it (README T8). */
export const burnTx = (seed = 31, length = 110): Uint8Array =>
  bytesOf(length, seed)

export function topicSubmissionPayload(
  o: Partial<{ net: string; post: Uint8Array; burnTx: Uint8Array }> = {},
): Fields {
  return M([
    [0, o.net ?? NET],
    [1, o.post ?? topicPostFrame()],
    [2, o.burnTx ?? burnTx()],
  ])
}

export const topicSubmissionFrame = (
  o?: Parameters<typeof topicSubmissionPayload>[0],
): Uint8Array => fr(10, topicSubmissionPayload(o))

export function topicVotePayload(
  o: Partial<{ net: string; target: Uint8Array; burnTx: Uint8Array }> = {},
): Fields {
  return M([
    [0, o.net ?? NET],
    [1, o.target ?? bytesOf(32, 41)],
    [2, o.burnTx ?? burnTx(32)],
  ])
}

export const topicVoteFrame = (
  o?: Parameters<typeof topicVotePayload>[0],
): Uint8Array => fr(11, topicVotePayload(o))

// ---------------------------------------------------------------------------------------------
// Directory (types 2, 4, 7)
// ---------------------------------------------------------------------------------------------

export function relay(
  i: number,
  endpoint = `https://relay${i}.example/frank`,
): Fields {
  const id = bytesOf(16, i)
  id[0] = i
  return M([
    [0, id],
    [1, endpoint],
    [2, acct1(20 + i)],
    [3, ts(1_800_000_000, 0)],
  ])
}

export function statementPayload(
  o: Partial<{
    net: string
    subject: Fields
    revision: bigint
    relays: Fields[]
    transitions: Fields[]
    expiry: Fields
    authorities: Fields[]
    stampKey: Fields | null
  }> = {},
): Fields {
  const m = M([
    [0, o.net ?? NET],
    [1, o.subject ?? acct2(1)],
    [2, o.revision ?? 5n],
    [3, ts(1_700_000_000, 123_456_789)],
    [4, o.relays ?? [relay(1), relay(2)]],
  ])
  if (o.transitions) m.set(5, o.transitions)
  if (o.expiry) m.set(6, o.expiry)
  if (o.authorities) m.set(7, o.authorities)
  // Schema 2 requires the stamp key; `stampKey: null` builds the field-less schema-1 layout.
  if (o.stampKey !== null) m.set(8, o.stampKey ?? stampAccount())
  return m
}

export const statementFrame = (
  o?: Parameters<typeof statementPayload>[0],
): Uint8Array => fr(4, statementPayload(o))

export function sig(signer: Fields, seed = 1, algorithm = 16): Fields {
  return M([
    [0, algorithm],
    [1, signer],
    [2, bytesOf(64, seed)],
  ])
}

export const attestationFrame = (
  stmt: Uint8Array,
  sigs: Fields[],
): Uint8Array =>
  fr(
    2,
    M([
      [0, stmt],
      [1, sigs],
    ]),
  )

export function transitionStatement(
  o: Partial<{
    net: string
    subject: Fields
    prior: Fields
    revision: bigint
    newKey: Fields
  }> = {},
): Uint8Array {
  return fr(
    7,
    M([
      [0, o.net ?? NET],
      [1, o.subject ?? acct2(1)],
      [2, o.prior ?? acct2(1)],
      [3, o.revision ?? 6n],
      [4, o.newKey ?? acct2(2)],
    ]),
  )
}

export function transition(
  stmt: Uint8Array,
  signer: Fields = acct2(1),
): Fields {
  return M([
    [0, stmt],
    [1, 16],
    [2, signer],
    [3, bytesOf(64, 9)],
  ])
}

// ---------------------------------------------------------------------------------------------
// Checkpoints (type 3)
// ---------------------------------------------------------------------------------------------

export function fact(
  seconds: number,
  nanos: number,
  idSeed: number,
  payload: Uint8Array = new Uint8Array(0),
): Fields {
  return M([
    [0, ts(seconds, nanos)],
    [1, bytesOf(16, idSeed)],
    [2, 7],
    [3, payload],
  ])
}

export function section(
  type: number,
  schema: number,
  value: Uint8Array,
): Fields {
  return M([
    [0, type],
    [1, schema],
    [2, value],
  ])
}

export function checkpointPayload(
  o: Partial<{ facts: Fields[]; sections: Fields[] }> = {},
): Fields {
  const m = M([
    [0, NET],
    [1, acct1(5)],
    [2, bytesOf(16, 77)],
    [3, ts(1_700_000_500, 5)],
    [
      4,
      o.facts ?? [
        fact(1_700_000_100, 0, 1, bytesOf(10, 1)),
        // A journal fact retaining an unknown nested message item, byte for byte.
        fact(1_700_000_100, 9, 2, unknownItem(2)),
      ],
    ],
  ])
  m.set(
    5,
    o.sections ?? [
      section(1, 1, bytesOf(12, 3)),
      // A future section kind, and one whose bytes happen to be a Frank frame: never opened.
      section(0x7fff0001, 9, unknownItem(3)),
    ],
  )
  return m
}

export const checkpointFrame = (
  o?: Parameters<typeof checkpointPayload>[0],
): Uint8Array => fr(3, checkpointPayload(o))

export { commonTranscript }

/** A copy of a field map with one field replaced. */
export function withField(m: Fields, key: number, value: Encodable): Fields {
  const out = new Map(m)
  out.set(key, value)
  return out
}

/** Replaces the single occurrence of `from` in `bytes` with `to` (fails if not unique). */
export function patchBytes(
  bytes: Uint8Array,
  from: Uint8Array,
  to: Uint8Array,
): Uint8Array {
  const hits: number[] = []
  for (let i = 0; i + from.length <= bytes.length; i++) {
    if (from.every((b, j) => bytes[i + j] === b)) hits.push(i)
  }
  if (hits.length !== 1)
    throw new Error(`patchBytes: expected one match, found ${hits.length}`)
  return concatBytes(
    bytes.subarray(0, hits[0]),
    to,
    bytes.subarray(hits[0] + from.length),
  )
}

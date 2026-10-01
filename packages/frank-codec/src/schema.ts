// Stage 8.1 (type-specific limits), 8.2 (CDDL structure and ranges) and 8.3 (allocated
// identifiers) for the version-1 payload schemas.
import type { FrankValue } from './cbor'
import {
  ENCRYPTION_SUITE_PROOF,
  I64_MAX,
  I64_MIN,
  MAX_CIPHERTEXT_BYTES,
  MAX_JOURNAL_FACTS,
  MAX_MESSAGE_ITEMS_PER_ARRAY,
  MAX_OPAQUE_SECTIONS,
  MAX_PAYMENT_MEMBERS,
  MAX_RELAY_BINDINGS,
  MAX_SIGNATURES,
  MAX_FRAME_BYTES,
  MAX_TOPIC_BODY_BYTES,
  MAX_TOPIC_FRAME_BYTES,
  MAX_TOPIC_VOTE_FRAME_BYTES,
  TYPE_CONTAINER_MESSAGE_ITEM,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_DIRECTORY_STATEMENT,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_KEY_TRANSITION_STATEMENT,
  TYPE_MAILBOX_CHECKPOINT,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_TEXT_MESSAGE_ITEM,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
  U32_MAX,
  U64_MAX,
} from './constants'
import { ErrorCategory, ErrorStage, FrankCodecError } from './errors'
import { isCompressedPoint, isProofEncoding } from './point'
import type {
  AccountRef,
  DraftPayload,
  JournalFact,
  KeyTransition,
  OpaqueSection,
  PaymentMember,
  RelayBinding,
  SignatureEntry,
  Timestamp,
  UnknownFields,
} from './types'

function fail(
  category: ErrorCategory,
  stage: ErrorStage,
  path: string,
  message: string,
): FrankCodecError {
  return new FrankCodecError(category, stage, message, path)
}

const bad = (path: string, message: string) =>
  fail('schema', '8.2', path, message)

// ---------------------------------------------------------------------------------------------
// Value getters (8.2)
// ---------------------------------------------------------------------------------------------

function isMap(
  v: FrankValue | undefined,
): v is ReadonlyMap<bigint, FrankValue> {
  return v instanceof Map
}

function uintRange(
  v: FrankValue | undefined,
  path: string,
  min: bigint,
  max: bigint,
): bigint {
  if (typeof v !== 'bigint') throw bad(path, 'expected an unsigned integer')
  if (v < min || v > max) throw bad(path, `integer outside ${min}..${max}`)
  return v
}

function u32ish(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): number {
  return Number(uintRange(v, path, BigInt(min), BigInt(max)))
}

function bstr(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): Uint8Array {
  if (!(v instanceof Uint8Array)) throw bad(path, 'expected a byte string')
  if (v.length < min || v.length > max)
    throw bad(path, `byte string size outside ${min}..${max}`)
  return v
}

function tstr(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): string {
  if (typeof v !== 'string') throw bad(path, 'expected a text string')
  return textSize(v, path, min, max)
}

function textSize(v: string, path: string, min: number, max: number): string {
  // .size counts UTF-8 bytes; the decoded string is well-formed, so count code points.
  let n = 0
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  if (n < min || n > max) throw bad(path, `text size outside ${min}..${max}`)
  return v
}

const NETWORK_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/

function networkTag(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 64)
  if (!NETWORK_TAG.test(s)) throw bad(path, 'network tag does not match S1')
  return s
}

// S4: scheme, then only bytes 0x21..0x7e excluding " < > \ ^ ` { | }.
const ENDPOINT = /^[A-Za-z][A-Za-z0-9+.-]*:[!#-;=?-[\]_a-z~]*$/

function endpoint(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 2048)
  // The class above is bytes 21,23-3b,3d,3f-5b,5d,5f,61-7a,7e: everything 21-7e except
  // 22 " 3c < 3e > 5c \ 5e ^ 60 ` 7b { 7c | 7d }.
  if (!ENDPOINT.test(s)) throw bad(path, 'endpoint violates S4')
  return s
}

const KEY_LENGTHS: ReadonlyMap<number, number> = new Map([
  [1, 33],
  [2, 32],
  [3, 32],
])

function asList(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): FrankValue[] {
  if (!Array.isArray(v)) throw bad(path, 'expected an array')
  if (v.length < min || v.length > max)
    throw bad(path, `array size outside ${min}..${max}`)
  return v
}

interface MapView {
  get(k: number): FrankValue | undefined
  has(k: number): boolean
  unknown: UnknownFields
}

/**
 * Checks a map against its declared keys. `open` maps (CDDL `* uint => frank-value`) retain
 * undeclared keys only when the enclosing frame is read through V6.3 (`allowUnknown`);
 * otherwise C12 makes an undeclared key a schema error. Closed maps never allow one.
 */
function fields(
  v: FrankValue | undefined,
  path: string,
  required: readonly number[],
  optional: readonly number[],
  open: boolean,
  allowUnknown: boolean,
): MapView {
  if (!isMap(v)) throw bad(path, 'expected a map')
  for (const k of required) {
    if (!v.has(BigInt(k))) throw bad(path, `missing required key ${k}`)
  }
  const unknown = new Map<bigint, FrankValue>()
  for (const [k, val] of v) {
    const n = k <= BigInt(U32_MAX) ? Number(k) : -1
    if (required.includes(n) || optional.includes(n)) continue
    if (open && allowUnknown) unknown.set(k, val)
    else throw bad(path, `undeclared key ${k} (C12)`)
  }
  return { get: k => v.get(BigInt(k)), has: k => v.has(BigInt(k)), unknown }
}

function account(v: FrankValue | undefined, path: string): AccountRef {
  const m = fields(v, path, [0, 1], [], false, false)
  const keyType = u32ish(m.get(0), `${path}.0`, 0, 65535)
  const keyBytes = bstr(m.get(1), `${path}.1`, 1, 128)
  const expected = KEY_LENGTHS.get(keyType)
  if (expected !== undefined && keyBytes.length !== expected) {
    throw bad(
      `${path}.1`,
      `key type ${keyType} requires ${expected} key bytes (S2)`,
    )
  }
  return { keyType, keyBytes }
}

/** A type-5 stamp point (T3b encoding rules): 33 compressed bytes on the curve. */
function point(v: FrankValue | undefined, path: string): Uint8Array {
  const b = bstr(v, path, 33, 33)
  if (!isCompressedPoint(b))
    throw bad(path, 'not a valid compressed secp256k1 point (T3b)')
  return b
}

/** The type-5 DLEQ proof `c || s` (T3b encoding rules): 64 bytes, both scalars in 1..n-1. */
function proof(v: FrankValue | undefined, path: string): Uint8Array {
  const b = bstr(v, path, 64, 64)
  if (!isProofEncoding(b)) throw bad(path, 'proof scalar outside 1..n-1 (T3b)')
  return b
}

function timestamp(v: FrankValue | undefined, path: string): Timestamp {
  const m = fields(v, path, [0, 1], [], false, false)
  const seconds = m.get(0)
  if (typeof seconds !== 'bigint' || seconds < I64_MIN || seconds > I64_MAX) {
    throw bad(`${path}.0`, 'seconds must be an i64')
  }
  return { seconds, nanoseconds: u32ish(m.get(1), `${path}.1`, 0, 999999999) }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.1
// ---------------------------------------------------------------------------------------------

/** Root frame length limits of R2 and R3. Only a root frame is charged. */
export function checkRootFrameLimit(
  typeId: number,
  frameLength: number,
): boolean {
  if (typeId === TYPE_DIRECT_MESSAGE_DELIVERY) return frameLength <= 1_048_576
  if (typeId === TYPE_DIRECTORY_ATTESTATION) return frameLength <= 262_144
  if (typeId === TYPE_TOPIC_POST || typeId === TYPE_TOPIC_POST_SUBMISSION)
    return frameLength <= MAX_TOPIC_FRAME_BYTES
  if (typeId === TYPE_TOPIC_VOTE_SUBMISSION)
    return frameLength <= MAX_TOPIC_VOTE_FRAME_BYTES
  return frameLength <= MAX_FRAME_BYTES
}

function tooMany(v: FrankValue | undefined, limit: number): boolean {
  return Array.isArray(v) && v.length > limit
}

/** Reads R2-R4 counts from the decoded fields, before typed conversion. */
export function checkTypeLimits(typeId: number, payload: FrankValue): void {
  if (!isMap(payload)) return
  const over = (what: string): never => {
    throw fail(
      'resource',
      '8.1',
      'root/payload',
      `${what} exceeds its limit (R2-R4)`,
    )
  }
  const f = (k: number) => payload.get(BigInt(k))
  switch (typeId) {
    case TYPE_DIRECT_MESSAGE_DELIVERY:
      if (tooMany(f(4), MAX_PAYMENT_MEMBERS)) over('payment members')
      break
    case TYPE_DIRECTORY_ATTESTATION:
      if (tooMany(f(1), MAX_SIGNATURES)) over('signatures')
      break
    case TYPE_MAILBOX_CHECKPOINT:
      if (tooMany(f(4), MAX_JOURNAL_FACTS)) over('journal facts')
      if (tooMany(f(5), MAX_OPAQUE_SECTIONS)) over('opaque sections')
      break
    case TYPE_DIRECTORY_STATEMENT:
      if (tooMany(f(4), MAX_RELAY_BINDINGS)) over('relay bindings')
      break
    case TYPE_RECIPIENT_ENCRYPTED_PAYLOAD: {
      const c = f(5)
      if (c instanceof Uint8Array && c.length > MAX_CIPHERTEXT_BYTES)
        over('ciphertext')
      break
    }
    case TYPE_TOPIC_POST: {
      const b = f(3)
      if (b instanceof Uint8Array && b.length > MAX_TOPIC_BODY_BYTES)
        over('topic body')
      break
    }
    case TYPE_MESSAGE_CONTENT_REVISION:
      if (tooMany(f(1), MAX_MESSAGE_ITEMS_PER_ARRAY)) over('message items')
      break
    case TYPE_CONTAINER_MESSAGE_ITEM:
      if (tooMany(f(0), MAX_MESSAGE_ITEMS_PER_ARRAY)) over('message items')
      break
    default:
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.2
// ---------------------------------------------------------------------------------------------

const framed = (v: FrankValue | undefined, path: string): Uint8Array =>
  bstr(v, path, 9, MAX_FRAME_BYTES)

function paymentMember(v: FrankValue | undefined, path: string): PaymentMember {
  const m = fields(v, path, [0, 1, 2, 3, 4], [], false, false)
  return {
    childIndex: u32ish(m.get(0), `${path}.0`, 0, 2147483647),
    transactionId: bstr(m.get(1), `${path}.1`, 1, 128),
    value: bstr(m.get(2), `${path}.2`, 32, 32),
    address: bstr(m.get(3), `${path}.3`, 1, 128),
    commitment: bstr(m.get(4), `${path}.4`, 32, 32),
  }
}

function signatureEntry(
  v: FrankValue | undefined,
  path: string,
): SignatureEntry {
  const m = fields(v, path, [0, 1, 2], [], false, false)
  return {
    algorithm: u32ish(m.get(0), `${path}.0`, 0, 65535),
    signer: account(m.get(1), `${path}.1`),
    signature: bstr(m.get(2), `${path}.2`, 1, 512),
  }
}

function relayBinding(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): RelayBinding {
  const m = fields(v, path, [0, 1, 2, 3], [], true, allow)
  return {
    relayId: bstr(m.get(0), `${path}.0`, 16, 64),
    endpoint: endpoint(m.get(1), `${path}.1`),
    identity: account(m.get(2), `${path}.2`),
    expiry: timestamp(m.get(3), `${path}.3`),
    unknownFields: m.unknown,
  }
}

function keyTransition(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): KeyTransition<Uint8Array> {
  const m = fields(v, path, [0, 1, 2, 3], [], true, allow)
  return {
    statementFrame: framed(m.get(0), `${path}.0`),
    algorithm: u32ish(m.get(1), `${path}.1`, 0, 65535),
    signer: account(m.get(2), `${path}.2`),
    signature: bstr(m.get(3), `${path}.3`, 1, 512),
    unknownFields: m.unknown,
  }
}

function journalFact(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): JournalFact {
  const m = fields(v, path, [0, 1, 2, 3], [], true, allow)
  return {
    timestamp: timestamp(m.get(0), `${path}.0`),
    factId: bstr(m.get(1), `${path}.1`, 16, 16),
    kind: u32ish(m.get(2), `${path}.2`, 0, 65535),
    payload: bstr(m.get(3), `${path}.3`, 0, 8_388_608),
    unknownFields: m.unknown,
  }
}

function opaqueSection(v: FrankValue | undefined, path: string): OpaqueSection {
  const m = fields(v, path, [0, 1, 2], [], false, false)
  return {
    sectionType: u32ish(m.get(0), `${path}.0`, 0, U32_MAX),
    sectionSchemaVersion: u32ish(m.get(1), `${path}.1`, 1, U32_MAX),
    value: bstr(m.get(2), `${path}.2`, 0, 8_388_608),
  }
}

/**
 * Stage 8.2: converts a generic payload to the typed draft of `typeId`, applying the CDDL
 * structure and range rules. Framed fields stay raw bytes until stage 8.4 opens them.
 */
export function parseDraft(
  typeId: number,
  payload: FrankValue,
  allow: boolean,
  schema: { envelope: number; effective: number } = {
    envelope: 1,
    effective: 1,
  },
): DraftPayload {
  const P = 'root/payload'
  switch (typeId) {
    case TYPE_DIRECT_MESSAGE_DELIVERY: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [], true, allow)
      return {
        type: 1,
        network: networkTag(m.get(0), `${P}.0`),
        destination: account(m.get(1), `${P}.1`),
        payloadFrame: framed(m.get(2), `${P}.2`),
        payloadDigest: bstr(m.get(3), `${P}.3`, 32, 32),
        payments: asList(m.get(4), `${P}.4`, 1, MAX_PAYMENT_MEMBERS).map(
          (e, i) => paymentMember(e, `${P}.4[${i}]`),
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_DIRECTORY_ATTESTATION: {
      const m = fields(payload, P, [0, 1], [], true, allow)
      return {
        type: 2,
        statementFrame: framed(m.get(0), `${P}.0`),
        signatures: asList(m.get(1), `${P}.1`, 1, MAX_SIGNATURES).map((e, i) =>
          signatureEntry(e, `${P}.1[${i}]`),
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_MAILBOX_CHECKPOINT: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [5], true, allow)
      const cp: DraftPayload = {
        type: 3,
        network: networkTag(m.get(0), `${P}.0`),
        owner: account(m.get(1), `${P}.1`),
        checkpointId: bstr(m.get(2), `${P}.2`, 16, 16),
        timestamp: timestamp(m.get(3), `${P}.3`),
        facts: asList(m.get(4), `${P}.4`, 0, MAX_JOURNAL_FACTS).map((e, i) =>
          journalFact(e, `${P}.4[${i}]`, allow),
        ),
        unknownFields: m.unknown,
      }
      if (m.has(5)) {
        cp.sections = asList(m.get(5), `${P}.5`, 0, MAX_OPAQUE_SECTIONS).map(
          (e, i) => opaqueSection(e, `${P}.5[${i}]`),
        )
      }
      return cp
    }
    case TYPE_DIRECTORY_STATEMENT: {
      // Field 8 (the stamp key) is required in schema 2 and undefined in schema 1, where C12
      // makes it a schema error (S10a.1). `effective` is the exact version, or the reader's
      // highest supported schema when a newer frame is read through V6.3.
      const m = fields(
        payload,
        P,
        schema.effective >= 2 ? [0, 1, 2, 3, 4, 8] : [0, 1, 2, 3, 4],
        [5, 6, 7],
        true,
        allow,
      )
      const st: DraftPayload = {
        type: 4,
        network: networkTag(m.get(0), `${P}.0`),
        subject: account(m.get(1), `${P}.1`),
        revision: uintRange(m.get(2), `${P}.2`, 0n, U64_MAX),
        timestamp: timestamp(m.get(3), `${P}.3`),
        relays: asList(m.get(4), `${P}.4`, 1, MAX_RELAY_BINDINGS).map((e, i) =>
          relayBinding(e, `${P}.4[${i}]`, allow),
        ),
        schemaVersion: schema.envelope,
        unknownFields: m.unknown,
      }
      if (m.has(8)) st.stampKey = account(m.get(8), `${P}.8`)
      if (m.has(5)) {
        st.keyTransitions = asList(m.get(5), `${P}.5`, 1, 16).map((e, i) =>
          keyTransition(e, `${P}.5[${i}]`, allow),
        )
      }
      if (m.has(6)) st.expiry = timestamp(m.get(6), `${P}.6`)
      if (m.has(7)) {
        st.recoveryAuthorities = asList(m.get(7), `${P}.7`, 1, 8).map((e, i) =>
          account(e, `${P}.7[${i}]`),
        )
      }
      return st
    }
    case TYPE_RECIPIENT_ENCRYPTED_PAYLOAD: {
      const m = fields(payload, P, [0, 1, 2, 3, 4, 5, 6, 7, 8], [], true, allow)
      return {
        type: 5,
        network: networkTag(m.get(0), `${P}.0`),
        sender: account(m.get(1), `${P}.1`),
        recipient: account(m.get(2), `${P}.2`),
        suite: u32ish(m.get(3), `${P}.3`, 0, 65535),
        nonce: bstr(m.get(4), `${P}.4`, 1, 64),
        ciphertext: bstr(m.get(5), `${P}.5`, 1, MAX_CIPHERTEXT_BYTES),
        ephemeralPoint: point(m.get(6), `${P}.6`),
        sharedPoint: point(m.get(7), `${P}.7`),
        dleqProof: proof(m.get(8), `${P}.8`),
        unknownFields: m.unknown,
      }
    }
    case TYPE_ENCRYPTED_MESSAGE_CONTENT: {
      const m = fields(payload, P, [0, 1, 2, 3], [], true, allow)
      return {
        type: 6,
        network: networkTag(m.get(0), `${P}.0`),
        messageId: bstr(m.get(1), `${P}.1`, 16, 16),
        revisionFrame: framed(m.get(2), `${P}.2`),
        contentDigest: bstr(m.get(3), `${P}.3`, 32, 32),
        unknownFields: m.unknown,
      }
    }
    case TYPE_KEY_TRANSITION_STATEMENT: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [], true, allow)
      return {
        type: 7,
        network: networkTag(m.get(0), `${P}.0`),
        subject: account(m.get(1), `${P}.1`),
        priorAuthority: account(m.get(2), `${P}.2`),
        revision: uintRange(m.get(3), `${P}.3`, 1n, U64_MAX),
        newKey: account(m.get(4), `${P}.4`),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TOPIC_POST: {
      const m = fields(payload, P, [0, 1, 3], [2], true, allow)
      const post: DraftPayload = {
        type: 9,
        network: networkTag(m.get(0), `${P}.0`),
        topic: tstr(m.get(1), `${P}.1`, 1, 512),
        body: bstr(m.get(3), `${P}.3`, 1, MAX_TOPIC_BODY_BYTES),
        unknownFields: m.unknown,
      }
      if (m.has(2)) post.parentHash = bstr(m.get(2), `${P}.2`, 32, 32)
      return post
    }
    case TYPE_TOPIC_POST_SUBMISSION: {
      const m = fields(payload, P, [0, 1, 2], [], true, allow)
      return {
        type: 10,
        network: networkTag(m.get(0), `${P}.0`),
        postFrame: framed(m.get(1), `${P}.1`),
        burnTx: bstr(m.get(2), `${P}.2`, 1, 16384),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TOPIC_VOTE_SUBMISSION: {
      const m = fields(payload, P, [0, 1, 2], [], true, allow)
      return {
        type: 11,
        network: networkTag(m.get(0), `${P}.0`),
        targetHash: bstr(m.get(1), `${P}.1`, 32, 32),
        burnTx: bstr(m.get(2), `${P}.2`, 1, 16384),
        unknownFields: m.unknown,
      }
    }
    case TYPE_MESSAGE_CONTENT_REVISION: {
      const m = fields(payload, P, [0, 1], [], true, allow)
      if (m.get(0) !== 'frank')
        throw bad(`${P}.0`, 'the type-8 domain must be the text "frank"')
      return {
        type: 8,
        items: asList(m.get(1), `${P}.1`, 1, MAX_MESSAGE_ITEMS_PER_ARRAY).map(
          (e, i) => framed(e, `${P}.1[${i}]`),
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_CONTAINER_MESSAGE_ITEM: {
      const m = fields(payload, P, [0], [], true, allow)
      return {
        type: 16,
        items: asList(m.get(0), `${P}.0`, 1, MAX_MESSAGE_ITEMS_PER_ARRAY).map(
          (e, i) => framed(e, `${P}.0[${i}]`),
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TEXT_MESSAGE_ITEM: {
      const m = fields(payload, P, [0], [], true, allow)
      return {
        type: 17,
        text: tstr(m.get(0), `${P}.0`, 0, 262144),
        unknownFields: m.unknown,
      }
    }
    default:
      throw new Error(`parseDraft: type ${typeId} has no schema`)
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.3
// ---------------------------------------------------------------------------------------------

const unsupported = (path: string, message: string) =>
  fail('unsupported', '8.3', path, message)

const ALLOCATED_KEY_TYPES = new Set([1, 2, 3])

function checkKeyType(a: AccountRef, path: string): void {
  if (!ALLOCATED_KEY_TYPES.has(a.keyType)) {
    throw unsupported(path, `unallocated key type ${a.keyType} (S2)`)
  }
}

/** S2b: algorithm / key type / signature-length pairing. */
function checkSignatureShape(
  algorithm: number,
  signer: AccountRef,
  signature: Uint8Array,
  path: string,
): void {
  let keyType: number
  let ok: boolean
  switch (algorithm) {
    case 1:
      keyType = 1
      ok = signature.length >= 8 && signature.length <= 72
      break
    case 2:
      keyType = 3
      ok = signature.length === 64
      break
    case 3:
      keyType = 1
      ok = signature.length === 64
      break
    case 16:
      keyType = 2
      ok = signature.length === 64
      break
    default:
      throw unsupported(
        path,
        `unallocated signature algorithm ${algorithm} (S2a)`,
      )
  }
  if (signer.keyType !== keyType || !ok) {
    throw unsupported(
      path,
      'algorithm/key-type/length combination is not allocated (S2b)',
    )
  }
}

/** Stage 8.3: allocated-identifier checks that need only the draft. */
export function checkAllocated(d: DraftPayload): void {
  const P = 'root/payload'
  switch (d.type) {
    case 1:
      checkKeyType(d.destination, `${P}.1`)
      break
    case 2:
      d.signatures.forEach((s, i) => {
        checkKeyType(s.signer, `${P}.1[${i}].1`)
        checkSignatureShape(s.algorithm, s.signer, s.signature, `${P}.1[${i}]`)
      })
      break
    case 3:
      checkKeyType(d.owner, `${P}.1`)
      break
    case 4:
      checkKeyType(d.subject, `${P}.1`)
      d.relays.forEach((r, i) => checkKeyType(r.identity, `${P}.4[${i}].2`))
      if (d.stampKey) checkKeyType(d.stampKey, `${P}.8`)
      d.keyTransitions?.forEach((t, i) => {
        checkKeyType(t.signer, `${P}.5[${i}].2`)
        checkSignatureShape(t.algorithm, t.signer, t.signature, `${P}.5[${i}]`)
      })
      d.recoveryAuthorities?.forEach((a, i) => checkKeyType(a, `${P}.7[${i}]`))
      break
    case 5:
      checkKeyType(d.sender, `${P}.1`)
      checkKeyType(d.recipient, `${P}.2`)
      if (d.suite !== ENCRYPTION_SUITE_PROOF) {
        throw unsupported(
          `${P}.3`,
          `encryption suite ${d.suite} is unallocated (S2c)`,
        )
      }
      break
    case 7:
      checkKeyType(d.subject, `${P}.1`)
      checkKeyType(d.priorAuthority, `${P}.2`)
      checkKeyType(d.newKey, `${P}.4`)
      break
    default:
  }
}

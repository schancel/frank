/**
 * Re-encodes the frozen (hand-authored or captured) Frank-CBOR vectors for the current type
 * identifier registry. Run through `yarn vectors:generate`; see docs/protocol/cbor/vectors/README.md.
 *
 * `docs/protocol/cbor/vectors/type-ids.json` records the identifiers the committed vectors were
 * encoded with. Every frame found in a frozen file (JSON strings, hex literals in listed sources,
 * frames nested in payloads, multipart bodies) has its type identifier mapped from that record to
 * `docs/protocol/message-types/v1.json` by type key. Values derived from changed bytes follow:
 * content and payload digests, payment commitments, directory and key-transition signatures,
 * DM crypto contexts and the suite-1 ciphertext that authenticates them. A derived value is
 * recomputed only when it was correct for the old bytes, so deliberately wrong values in reject
 * vectors stay wrong. Signatures are re-made with the fixed public test keys committed in this
 * repository (small scalars, repeated-byte scalars, and the `*_secret_test_only`/`private_hex`
 * values in the vectors themselves); a needed key that is missing is an error.
 *
 * When the record already equals the registry nothing changes, which is what `--check` asserts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3'
import { open, seal } from '../../crypto-box/src/index'
import * as codecModule from '../src/index'
import type { Encodable } from '../src/cbor'

// The codec is CommonJS TypeScript: loaded from ESM, its exports sit on `default`.
const codec =
  (codecModule as unknown as { default?: typeof codecModule }).default ??
  codecModule
const {
  commonTranscript,
  decodeCanonical,
  directorySignatureDigest,
  encodeCanonical,
  forwardingPayloadDigest,
  fromHex,
  keyTransitionSignatureDigest,
  messageContentDigest,
  paymentCommitment,
  recipientPayloadDigest,
  toHex,
  DIRECTORY_ATTESTATION,
  DIRECTORY_STATEMENT,
  DIRECT_MESSAGE_DELIVERY,
  DM_CRYPTO_CONTEXT_V1,
  ENCRYPTED_MESSAGE_CONTENT,
  FORWARDING_DELIVERY_ENVELOPE,
  FRANK_ENVELOPE,
  KEY_TRANSITION,
  PAYMENT_MEMBER,
  RECIPIENT_ENCRYPTED_PAYLOAD_V2,
  SIGNATURE_ENTRY,
} = codec

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../../..')
export const RECORD = 'docs/protocol/cbor/vectors/type-ids.json'
const REGISTRY = 'docs/protocol/message-types/v1.json'

/** Files holding frozen frames. Builder-generated corpora are not listed: their builders rewrite them. */
export const FROZEN_FILES = [
  'docs/protocol/cbor/vectors/account-registration.json',
  'docs/protocol/cbor/vectors/account-registration-values.json',
  'docs/protocol/cbor/vectors/blackjack-items.json',
  'docs/protocol/cbor/vectors/directory-preview.json',
  'docs/protocol/cbor/vectors/dm-runtime.json',
  'docs/protocol/cbor/vectors/dm-suite-1.json',
  'docs/protocol/cbor/vectors/plugin-message-item.json',
  'docs/protocol/proposals/blackjack-items/vectors.json',
  'docs/protocol/proposals/blackjack-items/README.md',
  'backend/cashweb/frank-cbor/tests/blackjack_hand.rs',
  'backend/cashweb/cashweb-registry/src/http/monad_message_cbor_tests.rs',
  'backend/cashweb/cashweb-registry/tests/test_cbor_registration.rs',
  'packages/frank-codec/browsercheck/runner.js',
  'packages/frank-codec/test/typed.jest.test.ts',
  'packages/frank-codec/test/readme-examples.jest.test.ts',
  'packages/wallet/message-item-plugins/text/plugin.jest.test.ts',
]

type V = Encodable | undefined
type CborMap = Map<bigint, Encodable>

const MAGIC = '46524e4b01'
/** Network tags a vector may sign under: the protocol chain registry's identifiers. */
const NETWORKS: string[] =
  (
    JSON.parse(
      readFileSync(resolve(ROOT, 'docs/protocol/chains/v1.json'), 'utf8'),
    ) as { chains?: { id: string }[]; networks?: { id: string }[] }
  ).chains?.map(c => c.id) ?? []
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
const sha = (b: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(b).digest())
const eq = (a: Uint8Array, b: Uint8Array) => toHex(a) === toHex(b)
const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array
const isMap = (v: unknown): v is CborMap => v instanceof Map
const k = (n: number) => BigInt(n)

function idsOf(json: {
  types: { id: number; key: string }[]
}): Map<string, number> {
  return new Map(json.types.map(t => [t.key, t.id]))
}

export function registryIds(): Map<string, number> {
  return idsOf(JSON.parse(read(REGISTRY)))
}

export function recordedIds(): Map<string, number> {
  const ids = (JSON.parse(read(RECORD)) as { ids: Record<string, number> }).ids
  return new Map(Object.entries(ids))
}

export function renderRecord(ids: Map<string, number>): string {
  const sorted = Object.fromEntries([...ids].sort((a, b) => a[1] - b[1]))
  return (
    JSON.stringify(
      {
        $comment:
          'The type identifiers the committed vectors are encoded with. Written by `yarn vectors:generate`; `yarn vectors:check` fails when it differs from docs/protocol/message-types/v1.json.',
        ids: sorted,
      },
      null,
      2,
    ) + '\n'
  )
}

// ------------------------------------------------------------------------------------------
// Test keys
// ------------------------------------------------------------------------------------------

const secrets = new Map<string, Uint8Array>()
function addSecret(secret: Uint8Array): void {
  try {
    secrets.set(toHex(secp256k1.getPublicKey(secret, true)), secret)
  } catch {
    // not a valid scalar
  }
}
const scalar = (n: number) => fromHex(n.toString(16).padStart(64, '0'))
/** Replacement signers start here: see `Renumber.replaceUnknownSigners`. */
const REPLACEMENT_BASE = 0x1001
for (let i = 1; i <= 64; i++) {
  addSecret(scalar(i))
  addSecret(new Uint8Array(32).fill(i))
  addSecret(scalar(REPLACEMENT_BASE + i - 1))
}
function collectSecrets(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    if (/secret|private/i.test(key) && /^[0-9a-f]{64}$/.test(value))
      addSecret(fromHex(value))
  } else if (Array.isArray(value)) value.forEach(v => collectSecrets(v, key))
  else if (value && typeof value === 'object')
    for (const [k2, v] of Object.entries(value)) collectSecrets(v, k2)
}
collectSecrets(
  JSON.parse(
    read('docs/protocol/proposals/message-stamp-derivation/vectors.json'),
  ),
)
for (const f of FROZEN_FILES)
  if (f.endsWith('.json')) collectSecrets(JSON.parse(read(f)))

function secretFor(publicKey: Uint8Array, why: string): Uint8Array {
  const s = secrets.get(toHex(publicKey))
  if (!s)
    throw new Error(`${why}: no committed test key for ${toHex(publicKey)}`)
  return s
}

/** The uncompressed x||y and the EVM address of a compressed key, as the vectors spell them. */
function keyForms(compressed: Uint8Array): string[] {
  const xy = secp256k1.ProjectivePoint.fromHex(compressed)
    .toRawBytes(false)
    .subarray(1)
  return [toHex(compressed), toHex(xy), toHex(keccak_256(xy).subarray(12))]
}

function verifies(
  signature: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return secp256k1.verify(
      secp256k1.Signature.fromDER(signature),
      digest,
      publicKey,
    )
  } catch {
    return false
  }
}

const sign = (digest: Uint8Array, secret: Uint8Array) =>
  secp256k1.sign(digest, secret).toDERRawBytes()

// ------------------------------------------------------------------------------------------
// The transform
// ------------------------------------------------------------------------------------------

export class Renumber {
  /** old hex → new hex for every value whose bytes changed (frames, digests, signatures). */
  readonly pairs = new Map<string, string>()
  /** Old DM crypto contexts seen in the current file, as bytes, with their transformed form. */
  contexts: { old: Uint8Array; next: Uint8Array }[] = []
  /** Signers whose signature must be re-made but whose secret is not committed (collect mode). */
  readonly unknownSigners = new Set<string>()
  /** Unknown signer key → committed replacement key. Applied to every byte string equal to it. */
  readonly keys = new Map<string, Uint8Array>()
  collecting = false
  private readonly typeKey: Map<number, string>
  private readonly next: Map<string, number>

  constructor(recorded: Map<string, number>, registry: Map<string, number>) {
    this.typeKey = new Map([...recorded].map(([key, id]) => [id, key]))
    this.next = registry
  }

  /**
   * Gives every unknown signer a committed replacement key (scalars from REPLACEMENT_BASE, in
   * sorted order) so its signatures can be re-made. The key changes wherever it appears.
   */
  replaceUnknownSigners(): void {
    const unknown = [...this.unknownSigners].sort()
    unknown.forEach((hex, i) => {
      if (i >= 64) throw new Error('more than 64 unknown signers')
      const secret = scalar(REPLACEMENT_BASE + i)
      const replacement = secp256k1.getPublicKey(secret, true)
      this.keys.set(hex, replacement)
      secrets.set(hex, secret)
      const [a, b] = [keyForms(fromHex(hex)), keyForms(replacement)]
      a.forEach((form, j) => this.pairs.set(form, b[j]))
    })
  }

  get identity(): boolean {
    return [...this.typeKey].every(([id, key]) => this.next.get(key) === id)
  }

  private keyOf(oldId: number): string | undefined {
    return this.typeKey.get(oldId)
  }

  mapId(oldId: number): number {
    const key = this.keyOf(oldId)
    if (key === undefined) {
      const clash = [...this.next].find(([, id]) => id === oldId)
      if (clash)
        throw new Error(
          `type ${oldId} was unassigned when the vectors were encoded but is now ${clash[0]}; give the vector another unassigned id`,
        )
      return oldId
    }
    const id = this.next.get(key)
    if (id === undefined) throw new Error(`type ${key} left the registry`)
    return id
  }

  private note(oldBytes: Uint8Array, newBytes: Uint8Array): void {
    if (!eq(oldBytes, newBytes))
      this.pairs.set(toHex(oldBytes), toHex(newBytes))
  }

  /** Re-derives `field` as `derive(newInput)` when it equalled `derive(oldInput)`. */
  private rederive(
    oldMap: CborMap,
    newMap: CborMap,
    field: number,
    derive: (m: CborMap) => Uint8Array | undefined,
  ): void {
    const was = oldMap.get(k(field))
    if (!isBytes(was)) return
    let before: Uint8Array | undefined, after: Uint8Array | undefined
    try {
      before = derive(oldMap)
      after = derive(newMap)
    } catch {
      return
    }
    if (before && after && eq(was, before)) {
      newMap.set(k(field), after)
      this.note(before, after)
    }
  }

  /** A whole frame, or undefined when `bytes` is not one. */
  frame(bytes: Uint8Array): Uint8Array | undefined {
    if (bytes.length < 9 || toHex(bytes.subarray(0, 5)) !== MAGIC)
      return undefined
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + 5,
      4,
    ).getUint32(0)
    if (bytes.length !== 9 + length) return this.patchHeader(bytes)
    let env: unknown
    try {
      env = decodeCanonical(bytes.subarray(9))
    } catch {
      return this.patchHeader(bytes)
    }
    if (!isMap(env)) return bytes
    const typeId = env.get(k(FRANK_ENVELOPE.typeId))
    if (typeof typeId !== 'bigint') return bytes
    const newEnv: CborMap = new Map(env)
    newEnv.set(k(FRANK_ENVELOPE.typeId), BigInt(this.mapId(Number(typeId))))
    const payload = env.get(k(FRANK_ENVELOPE.payload))
    if (isBytes(payload)) {
      let value: unknown
      try {
        value = decodeCanonical(payload)
      } catch {
        value = undefined
      }
      if (value !== undefined) {
        const key = this.keyOf(Number(typeId))
        const schema = Number(env.get(k(FRANK_ENVELOPE.schemaVersion)))
        const nextValue = this.payload(key, schema, value as Encodable)
        newEnv.set(k(FRANK_ENVELOPE.payload), encodeCanonical(nextValue))
      }
    }
    const body = encodeCanonical(newEnv)
    const out = new Uint8Array(9 + body.length)
    out.set(bytes.subarray(0, 5))
    new DataView(out.buffer).setUint32(5, body.length)
    out.set(body, 9)
    this.note(bytes, out)
    noteContentHash(this, bytes, out, this.keyOf(Number(typeId)))
    return out
  }

  /** A malformed frame keeps its bytes except a leading `a4 00 <type>` envelope type. */
  private patchHeader(bytes: Uint8Array): Uint8Array {
    if (bytes[9] !== 0xa4 || bytes[10] !== 0x00) return bytes
    const head = bytes[11]
    let oldId: number, width: number
    if (head < 0x18) [oldId, width] = [head, 1]
    else if (head === 0x18) [oldId, width] = [bytes[12], 2]
    else if (head === 0x19) [oldId, width] = [(bytes[12] << 8) | bytes[13], 3]
    else return bytes
    const id = encodeCanonical(BigInt(this.mapId(oldId)))
    if (id.length === width) {
      const out = bytes.slice()
      out.set(id, 11)
      this.note(bytes, out)
      return out
    }
    const out = new Uint8Array(bytes.length - width + id.length)
    out.set(bytes.subarray(0, 11))
    out.set(id, 11)
    out.set(bytes.subarray(11 + width), 11 + id.length)
    const view = new DataView(out.buffer)
    view.setUint32(5, view.getUint32(5) - width + id.length)
    this.note(bytes, out)
    return out
  }

  /** Any value: nested frames and canonical CBOR inside byte strings are transformed. */
  value(v: Encodable): Encodable {
    if (isBytes(v)) {
      const key = v.length === 33 ? this.keys.get(toHex(v)) : undefined
      if (key) return key
      // A 32-byte digest of a changed frame (a predecessor or statement hash) follows the frame.
      const digest = v.length === 32 ? this.pairs.get(toHex(v)) : undefined
      if (digest) return fromHex(digest)
      const f = this.frame(v)
      if (f) return f
      if (v.length > 1 && v[0] >= 0x80 && v[0] <= 0xbf) {
        let inner: unknown
        try {
          inner = decodeCanonical(v)
        } catch {
          return v
        }
        const next = this.value(inner as Encodable)
        const bytes = encodeCanonical(next)
        this.note(v, bytes)
        return bytes
      }
      return v
    }
    if (Array.isArray(v)) return v.map(x => this.value(x))
    if (isMap(v)) {
      if (
        v.get(k(DM_CRYPTO_CONTEXT_V1.domain)) === 'frank/dm-crypto-context/v1'
      )
        return this.context(v)
      return new Map([...v].map(([key, x]) => [key, this.value(x)])) as CborMap
    }
    return v
  }

  private payload(
    key: string | undefined,
    schema: number,
    value: Encodable,
  ): Encodable {
    const next = this.value(value)
    if (!isMap(value) || !isMap(next)) return next
    switch (key) {
      case 'encrypted-message-content':
        this.rederive(
          value,
          next,
          ENCRYPTED_MESSAGE_CONTENT.contentDigest,
          m => {
            const r = m.get(k(ENCRYPTED_MESSAGE_CONTENT.revisionFrame))
            return isBytes(r) ? messageContentDigest(r) : undefined
          },
        )
        break
      case 'recipient-encrypted-payload':
        if (schema >= 2) this.reseal(value, next)
        break
      case 'direct-message-delivery':
      case 'forwarding-delivery-envelope': {
        const F =
          key === 'direct-message-delivery'
            ? DIRECT_MESSAGE_DELIVERY
            : FORWARDING_DELIVERY_ENVELOPE
        const digest =
          key === 'direct-message-delivery'
            ? recipientPayloadDigest
            : forwardingPayloadDigest
        const network = value.get(k(F.network))
        if (typeof network !== 'string') break
        this.rederive(value, next, F.payloadDigest, m => {
          const p = m.get(k(F.payloadFrame))
          return isBytes(p) ? digest(network, p) : undefined
        })
        if (key === 'direct-message-delivery') this.commitments(value, next)
        break
      }
      case 'directory-attestation':
        this.attestation(value, next)
        break
      case 'directory-statement':
        this.transitions(value, next)
        break
      default:
    }
    return next
  }

  private commitments(oldMap: CborMap, newMap: CborMap): void {
    const F = DIRECT_MESSAGE_DELIVERY
    const oldDigest = oldMap.get(k(F.payloadDigest))
    const newDigest = newMap.get(k(F.payloadDigest))
    const payments = newMap.get(k(F.payments))
    const oldPayments = oldMap.get(k(F.payments))
    if (
      !isBytes(oldDigest) ||
      !isBytes(newDigest) ||
      !Array.isArray(payments) ||
      !Array.isArray(oldPayments)
    )
      return
    newMap.set(
      k(F.payments),
      payments.map((member, i) => {
        if (!isMap(member)) return member
        // Compared with the old member: the walk may already have mapped the commitment
        // through a pair noted in an earlier convergence round.
        const oldMember = oldPayments[i]
        if (!isMap(oldMember)) return member
        const index = oldMember.get(k(PAYMENT_MEMBER.childIndex))
        const was = oldMember.get(k(PAYMENT_MEMBER.commitment))
        if (!isBytes(was)) return member
        for (const child of new Set([
          typeof index === 'bigint' ? Number(index) : i,
          i,
        ])) {
          const before = paymentCommitment(oldDigest, child)
          if (eq(was, before)) {
            const after = paymentCommitment(newDigest, child)
            const m = new Map(member)
            m.set(k(PAYMENT_MEMBER.commitment), after)
            this.note(before, after)
            return m
          }
        }
        return member
      }),
    )
  }

  private attestation(oldMap: CborMap, newMap: CborMap): void {
    const oldStatement = oldMap.get(k(DIRECTORY_ATTESTATION.statementFrame))
    const newStatement = newMap.get(k(DIRECTORY_ATTESTATION.statementFrame))
    const signatures = newMap.get(k(DIRECTORY_ATTESTATION.signatures))
    if (
      !isBytes(oldStatement) ||
      !isBytes(newStatement) ||
      !Array.isArray(signatures)
    )
      return
    if (eq(oldStatement, newStatement)) return
    const network = statementNetwork(newStatement)
    if (network === undefined) return
    this.note(
      directorySignatureDigest(network, oldStatement),
      directorySignatureDigest(network, newStatement),
    )
    const oldSignatures = oldMap.get(
      k(DIRECTORY_ATTESTATION.signatures),
    ) as Encodable[]
    // A reject vector may sign the statement under another network's transcript (T5); keep
    // that network when re-signing.
    const networks = [network, ...NETWORKS.filter(n => n !== network)]
    newMap.set(
      k(DIRECTORY_ATTESTATION.signatures),
      signatures.map((entry, i) => {
        for (const n of networks) {
          const next = this.resign(
            oldSignatures[i],
            entry,
            SIGNATURE_ENTRY.signer,
            SIGNATURE_ENTRY.signature,
            directorySignatureDigest(n, oldStatement),
            directorySignatureDigest(n, newStatement),
            'directory attestation',
          )
          if (next !== entry) return next
        }
        return entry
      }),
    )
  }

  private transitions(oldMap: CborMap, newMap: CborMap): void {
    const network = oldMap.get(k(DIRECTORY_STATEMENT.network))
    const oldList = oldMap.get(k(DIRECTORY_STATEMENT.keyTransitions))
    const newList = newMap.get(k(DIRECTORY_STATEMENT.keyTransitions))
    if (
      typeof network !== 'string' ||
      !Array.isArray(oldList) ||
      !Array.isArray(newList)
    )
      return
    newMap.set(
      k(DIRECTORY_STATEMENT.keyTransitions),
      newList.map((entry, i) => {
        const before = oldList[i]
        if (!isMap(entry) || !isMap(before)) return entry
        const o = before.get(k(KEY_TRANSITION.statementFrame))
        const n = entry.get(k(KEY_TRANSITION.statementFrame))
        if (!isBytes(o) || !isBytes(n) || eq(o, n)) return entry
        const oldDigest = keyTransitionSignatureDigest(network, o)
        const newDigest = keyTransitionSignatureDigest(network, n)
        this.note(oldDigest, newDigest)
        return this.resign(
          before,
          entry,
          KEY_TRANSITION.signer,
          KEY_TRANSITION.signature,
          oldDigest,
          newDigest,
          'key transition',
        )
      }),
    )
  }

  /** Re-signs an entry whose signature verified over the old digest. */
  private resign(
    oldEntry: Encodable,
    entry: Encodable,
    signerField: number,
    signatureField: number,
    oldDigest: Uint8Array,
    newDigest: Uint8Array,
    why: string,
  ): Encodable {
    if (!isMap(entry) || !isMap(oldEntry)) return entry
    // Verify with the signer as it was: a replaced key is already swapped in `entry`.
    const signer = oldEntry.get(k(signerField))
    const signature = oldEntry.get(k(signatureField))
    const point = isMap(signer) ? signer.get(1n) : undefined
    if (!isBytes(point) || !isBytes(signature)) return entry
    if (!verifies(signature, oldDigest, point)) return entry
    if (this.collecting && !secrets.has(toHex(point))) {
      this.unknownSigners.add(toHex(point))
      return entry
    }
    const fresh = sign(newDigest, secretFor(point, why))
    this.note(signature, fresh)
    const m = new Map(entry)
    m.set(k(signatureField), fresh)
    return m
  }

  private context(v: CborMap): CborMap {
    const out: CborMap = new Map(v)
    const objectType = v.get(k(DM_CRYPTO_CONTEXT_V1.objectType))
    if (typeof objectType === 'bigint')
      out.set(
        k(DM_CRYPTO_CONTEXT_V1.objectType),
        BigInt(this.mapId(Number(objectType))),
      )
    for (const f of [
      DM_CRYPTO_CONTEXT_V1.senderStatementHash,
      DM_CRYPTO_CONTEXT_V1.recipientStatementHash,
    ]) {
      const h = v.get(k(f))
      const replaced = isBytes(h) ? this.pairs.get(toHex(h)) : undefined
      if (replaced) out.set(k(f), fromHex(replaced))
    }
    return out
  }

  /** Opens a suite-1 box under one of this file's contexts and seals the transformed plaintext. */
  private reseal(oldMap: CborMap, newMap: CborMap): void {
    const F = RECIPIENT_ENCRYPTED_PAYLOAD_V2
    const box = oldMap.get(k(F.cryptoBoxEnvelope))
    const sender = oldMap.get(k(F.sender))
    const recipient = oldMap.get(k(F.recipient))
    if (!isBytes(box) || !isMap(sender) || !isMap(recipient)) return
    const senderKey = sender.get(1n)
    const recipientKey = recipient.get(1n)
    if (!isBytes(senderKey) || !isBytes(recipientKey)) return
    for (const { old: oldContext, next: newContext } of this.contexts) {
      const ctx = decodeCanonical(oldContext) as CborMap
      const senderMessage = (
        ctx.get(k(DM_CRYPTO_CONTEXT_V1.senderMessageKey)) as CborMap | undefined
      )?.get(1n)
      const recipientMessage = (
        ctx.get(k(DM_CRYPTO_CONTEXT_V1.recipientMessageKey)) as
          | CborMap
          | undefined
      )?.get(1n)
      if (!isBytes(senderMessage) || !isBytes(recipientMessage)) continue
      const recipientSecret = secrets.get(toHex(recipientMessage))
      if (!recipientSecret) continue
      const opened = open({
        envelope: box,
        recipientPrivateKey: recipientSecret,
        senderPublicKey: senderMessage,
        context: oldContext,
      })
      if (!opened.ok) continue
      const plaintext = this.frame(opened.value) ?? opened.value
      if (eq(plaintext, opened.value) && eq(oldContext, newContext)) return
      const oldBox = decodeCanonical(box) as CborMap
      const salt = oldBox.get(3n)
      const ciphertext = oldBox.get(5n)
      const padding = isBytes(ciphertext)
        ? Math.max(0, ciphertext.length - opened.value.length - 20)
        : 0
      const sealed = seal({
        suiteId: 1,
        recipientPublicKey: recipientMessage,
        senderPublicKey: senderMessage,
        senderPrivateKey: secretFor(senderMessage, 'suite-1 sender'),
        plaintext,
        context: newContext,
        ephemeralSecret: fromHex('03'.padStart(64, '0')),
        salt: isBytes(salt) ? salt : undefined,
        padding,
        paddingBytes: new Uint8Array(padding),
      })
      if (!sealed.ok) throw new Error(`suite-1 reseal: ${sealed.error.code}`)
      this.note(box, sealed.value)
      newMap.set(k(F.cryptoBoxEnvelope), sealed.value)
      return
    }
  }
}

function statementNetwork(frame: Uint8Array): string | undefined {
  try {
    const env = decodeCanonical(frame.subarray(9)) as CborMap
    const p = decodeCanonical(
      env.get(k(FRANK_ENVELOPE.payload)) as Uint8Array,
    ) as CborMap
    const n = p.get(k(DIRECTORY_STATEMENT.network))
    return typeof n === 'string' ? n : undefined
  } catch {
    return undefined
  }
}

/** T1 of a frame under a network, for recording old→new content hashes. */
function t1(network: string, frame: Uint8Array): Uint8Array {
  return sha(commonTranscript('frank/content-hash/v1', network, frame))
}

/** Records the content hash change of a transformed frame (README T1's network rules). */
function noteContentHash(
  r: Renumber,
  oldFrame: Uint8Array,
  newFrame: Uint8Array,
  oldKey: string | undefined,
): void {
  if (eq(oldFrame, newFrame)) return
  let network: string | undefined
  try {
    const env = decodeCanonical(newFrame.subarray(9)) as CborMap
    const p = decodeCanonical(
      env.get(k(FRANK_ENVELOPE.payload)) as Uint8Array,
    ) as CborMap
    if (
      oldKey === 'message-content-revision' ||
      oldKey === 'container-message-item' ||
      oldKey === 'text-message-item'
    )
      network = 'frank'
    else if (oldKey === 'directory-attestation') {
      const s = p.get(k(DIRECTORY_ATTESTATION.statementFrame))
      network = isBytes(s) ? statementNetwork(s) : undefined
    } else {
      const n = isMap(p) ? p.get(0n) : undefined
      network = typeof n === 'string' ? n : undefined
    }
  } catch {
    return
  }
  if (network === undefined) return
  r.pairs.set(toHex(t1(network, oldFrame)), toHex(t1(network, newFrame)))
  if (oldKey === 'recipient-encrypted-payload') {
    // A standalone T3, and the T4 commitments over it, follow the payload frame even where no
    // delivery frame carries them.
    const before = recipientPayloadDigest(network, oldFrame)
    const after = recipientPayloadDigest(network, newFrame)
    r.pairs.set(toHex(before), toHex(after))
    for (let child = 0; child < COMMITTED_CHILDREN; child++)
      r.pairs.set(
        toHex(paymentCommitment(before, child)),
        toHex(paymentCommitment(after, child)),
      )
  }
}

/** Child indexes whose standalone T4 commitments are followed (vectors use only the first few). */
const COMMITTED_CHILDREN = 16

// ------------------------------------------------------------------------------------------
// Files
// ------------------------------------------------------------------------------------------

const HEX_RUN = /[0-9a-fA-F]{18,}/g

/** Transforms one hex string: a frame, a context, a multipart body, or hex holding frames. */
function hexString(r: Renumber, hex: string): string {
  if (hex.length % 2) return hex
  const lower = hex.toLowerCase()
  const bytes = fromHex(lower)
  if (lower.startsWith(MAGIC)) {
    const out = r.frame(bytes)
    if (out) return toHex(out)
  }
  if (lower.startsWith('2d2d')) return toHex(multipart(r, bytes))
  const at = lower.indexOf(MAGIC, 8)
  if (at > 0 && at % 2 === 0) {
    // A hash preimage ending in a u32-length-prefixed frame (the T1 content-hash input).
    const o = at / 2
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    const out = r.frame(bytes.subarray(o))
    if (out && view.getUint32(o - 4) === bytes.length - o) {
      const next = new Uint8Array(o + out.length)
      next.set(bytes.subarray(0, o))
      new DataView(next.buffer).setUint32(o - 4, out.length)
      next.set(out, o)
      return toHex(next)
    }
  }
  if (bytes[0] >= 0xa0 && bytes[0] <= 0xbf) {
    try {
      const v = decodeCanonical(bytes)
      return toHex(encodeCanonical(r.value(v as Encodable)))
    } catch {
      return hex
    }
  }
  return hex
}

/** A multipart/form-data body: each part's data is transformed; identities are re-derived. */
function multipart(r: Renumber, body: Uint8Array): Uint8Array {
  const buf = Buffer.from(body)
  const boundary = buf.subarray(0, buf.indexOf('\r\n'))
  const parts: Buffer[] = []
  const named: Record<string, { old: Uint8Array; next: Uint8Array }> = {}
  let offset = 0
  while (offset < buf.length) {
    const headerEnd = buf.indexOf('\r\n\r\n', offset)
    if (headerEnd < 0) {
      parts.push(buf.subarray(offset))
      break
    }
    const end = buf.indexOf(
      Buffer.concat([Buffer.from('\r\n'), boundary]),
      headerEnd + 4,
    )
    if (end < 0) throw new Error('multipart delimiter')
    const headers = buf.subarray(offset, headerEnd + 4)
    const data = new Uint8Array(buf.subarray(headerEnd + 4, end))
    const next = fromHex(hexString(r, toHex(data)))
    const name = /name="([^"]+)"/.exec(headers.toString('latin1'))?.[1]
    if (name) named[name] = { old: data, next }
    parts.push(headers, Buffer.from(next))
    offset = end
  }
  // The relay's submission identity: SHA-256 of canonical [delivery, context, transactions].
  const { delivery, context, transactions } = named
  if (delivery && context && transactions) {
    const id = (p: 'old' | 'next') =>
      sha(
        encodeCanonical([
          delivery[p],
          context[p],
          decodeCanonical(transactions[p]) as Encodable,
        ]),
      )
    r.pairs.set(toHex(id('old')), toHex(id('next')))
  }
  return new Uint8Array(Buffer.concat(parts))
}

/** Collects every DM crypto context in a JSON document (pass 1). */
function collectContexts(r: Renumber, doc: unknown): void {
  const visit = (v: unknown): void => {
    if (
      typeof v === 'string' &&
      /^b0/.test(v) &&
      /^[0-9a-f]+$/.test(v) &&
      v.length % 2 === 0
    ) {
      try {
        const m = decodeCanonical(fromHex(v))
        if (isMap(m) && m.get(0n) === 'frank/dm-crypto-context/v1') {
          const old = fromHex(v)
          if (!r.contexts.some(c => eq(c.old, old)))
            r.contexts.push({
              old,
              next: encodeCanonical(r.value(m as Encodable)),
            })
        }
      } catch {
        // not a context
      }
    } else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') Object.values(v).forEach(visit)
  }
  visit(doc)
}

/**
 * A JSON file, edited as text so its formatting survives: string values are transformed,
 * `type_id`/`typeId` numbers are mapped, and `supported_schemas` lists are re-sorted.
 */
function jsonText(r: Renumber, text: string, finalPass: boolean): string {
  let out = text.replace(
    /("(?:type_id|typeId)"\s*:\s*)(\d+)/g,
    (_, head: string, n: string) => {
      try {
        return head + String(r.mapId(Number(n)))
      } catch {
        return head + n
      }
    },
  )
  out = out.replace(
    /("supported_schemas":\s*)(\[[^\[\]]*\])/g,
    (_, head: string, block: string) => {
      // Items are flat objects; reorder their texts in place so the layout is kept.
      const items = block.match(/\{[^{}]*\}/g) ?? []
      const sorted = [...items].sort(
        (a, b) =>
          (JSON.parse(a) as { type_id: number }).type_id -
          (JSON.parse(b) as { type_id: number }).type_id,
      )
      let i = 0
      return head + block.replace(/\{[^{}]*\}/g, () => sorted[i++])
    },
  )
  return out.replace(
    /"([^"\\]*)"(\s*:)?/g,
    (whole, value: string, colon?: string) => {
      if (colon) return whole
      if (/^[0-9a-fA-F]+$/.test(value) && value.length >= 18) {
        const next = hexString(r, value)
        if (next !== value) return `"${next}"`
      }
      return finalPass && r.pairs.has(value) ? `"${r.pairs.get(value)}"` : whole
    },
  )
}

function textDoc(r: Renumber, text: string, finalPass: boolean): string {
  return text.replace(HEX_RUN, hex => {
    const out = hexString(r, hex)
    if (out !== hex) return out
    return finalPass ? r.pairs.get(hex.toLowerCase()) ?? hex : hex
  })
}

/**
 * A manifest `one_byte_mutation` pair stays one byte apart: the rejected twin is re-derived from
 * the accepted case's new bytes with the same byte flipped (counted from the end when the flip
 * is in the trailing signature, otherwise from the start).
 */
function keepMutationPairs(oldText: string, newText: string): string {
  type Case = {
    id: string
    frame_hex: string
    expectation: string
    paired_case?: string
    pair_relation?: string
  }
  const cases = (doc: string) =>
    (JSON.parse(doc) as { cases?: Case[] }).cases ?? []
  const before = new Map(cases(oldText).map(c => [c.id, c]))
  let out = newText
  for (const c of cases(newText)) {
    if (
      c.pair_relation !== 'one_byte_mutation' ||
      c.expectation === 'reject' ||
      !c.paired_case
    )
      continue
    const twin = cases(out).find(x => x.id === c.paired_case)
    const [oa, ob] = [before.get(c.id), before.get(c.paired_case)]
    if (!twin || !oa || !ob) continue
    const [a, b] = [fromHex(oa.frame_hex), fromHex(ob.frame_hex)]
    const at = a.findIndex((x: number, i: number) => x !== b[i])
    const next = fromHex(c.frame_hex)
    const pos = a.length - at <= 80 ? next.length - (a.length - at) : at
    const mutated = next.slice()
    mutated[pos] ^= a[at] ^ b[at]
    out = out.replace(`"${twin.frame_hex}"`, `"${toHex(mutated)}"`)
  }
  return out
}

/** Transforms every frozen file. Returns path → new contents for the files that change. */
export function renumberFrozen(
  recorded: Map<string, number>,
  registry: Map<string, number>,
): Map<string, string> {
  const changes = new Map<string, string>()
  // Pass 1 over everything records digest pairs (statement hashes feed contexts, contexts feed
  // ciphertexts).
  const r = new Renumber(recorded, registry)
  const docs = FROZEN_FILES.map(f => ({ f, text: read(f) }))
  const pass = () => {
    for (const { f, text } of docs) {
      if (f.endsWith('.json')) jsonText(r, text, false)
      else textDoc(r, text, false)
    }
  }
  r.collecting = true
  pass()
  r.collecting = false
  r.pairs.clear()
  r.replaceUnknownSigners()
  // Digests feed later frames (predecessor hashes, statement hashes in DM contexts, contexts in
  // ciphertexts), so pass until the old→new pairs stop changing.
  for (let round = 0; ; round++) {
    if (round === 16) throw new Error('vector renumbering does not converge')
    const before = JSON.stringify([...r.pairs])
    r.contexts = []
    for (const { f, text } of docs)
      if (f.endsWith('.json')) collectContexts(r, JSON.parse(text))
    pass()
    if (JSON.stringify([...r.pairs]) === before) break
  }
  for (const { f, text } of docs) {
    let out: string
    if (f.endsWith('.json')) out = jsonText(r, text, true)
    else out = textDoc(r, text, true)
    if (f.endsWith('.json')) out = keepMutationPairs(text, out)
    if (out !== text) changes.set(f, out)
  }
  return changes
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const check = process.argv.includes('--check')
  const recorded = recordedIds()
  const registry = registryIds()
  const changes = renumberFrozen(recorded, registry)
  const record = renderRecord(registry)
  if (check) {
    const stale = [...changes.keys()]
    if (read(RECORD) !== record) stale.unshift(RECORD)
    if (stale.length) {
      console.error(
        `vectors are not encoded with the registry's type identifiers:\n  ${stale.join(
          '\n  ',
        )}\nRun yarn vectors:generate.`,
      )
      process.exit(1)
    }
  } else {
    for (const [f, text] of changes) writeFileSync(resolve(ROOT, f), text)
    writeFileSync(resolve(ROOT, RECORD), record)
    console.log(`renumbered ${changes.size} frozen vector files`)
  }
}

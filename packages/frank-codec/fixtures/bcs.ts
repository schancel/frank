// BCS encodings of the three #131 fixture families, following the version-1 CDDL field order.
// Where a fixture holds a framed child, the child's typed content is encoded recursively as a
// BCS struct (BCS has no framing); a child of unknown type has no BCS representation in a v1
// schema, so it needs an explicit `Opaque { type_id, bytes }` enum variant.
import type {
  AccountRef,
  ChildFrame,
  FinalPayload,
  ParsedFrame,
  Timestamp,
} from '../src'
import { BcsWriter } from './mini-bcs'

const acct = (w: BcsWriter, a: AccountRef) => w.u16(a.keyType).bytes(a.keyBytes)
// BCS defines no signed integer; i64 is carried as its two's-complement u64.
const ts = (w: BcsWriter, t: Timestamp) => w.u64(t.seconds).u32(t.nanoseconds)

function child(w: BcsWriter, c: ChildFrame): void {
  // Message item enum: 0 = Text, 1 = Container, 2 = Opaque (added only to hold unknown frames).
  if (c.kind === 'retained') {
    w.uleb(2)
      .u32(c.typeId ?? 0)
      .bytes(c.frame)
    return
  }
  const t = c.typed
  if (t?.type === 17) w.uleb(0).string(t.text)
  else if (t?.type === 16) {
    w.uleb(1).uleb(t.items.length)
    for (const i of t.items) child(w, i)
  } else throw new Error('unexpected message item')
}

export function toBcs(p: ParsedFrame): Uint8Array {
  const t: FinalPayload | undefined = p.typed
  if (!t) throw new Error('typed projection required')
  const w = new BcsWriter()
  switch (t.type) {
    case 1:
      w.string(t.network)
      acct(w, t.destination)
      w.bytes(toBcs(t.payloadFrame)).fixed(t.payloadDigest)
      w.uleb(t.payments.length)
      for (const m of t.payments) {
        w.u32(m.childIndex)
          .bytes(m.transactionId)
          .fixed(m.value)
          .bytes(m.address)
          .fixed(m.commitment)
      }
      return w.toBytes()
    case 5:
      w.string(t.network)
      acct(w, t.sender)
      acct(w, t.recipient)
      w.u16(t.suite).bytes(t.nonce).bytes(t.ciphertext)
      return w.toBytes()
    case 6:
      w.string(t.network)
        .fixed(t.messageId)
        .bytes(toBcs(t.revisionFrame))
        .fixed(t.contentDigest)
      return w.toBytes()
    case 8:
      w.uleb(t.items.length)
      for (const i of t.items) child(w, i)
      return w.toBytes()
    case 2:
      w.bytes(toBcs(t.statementFrame))
      w.uleb(t.signatures.length)
      for (const s of t.signatures) {
        w.u16(s.algorithm)
        acct(w, s.signer)
        w.bytes(s.signature)
      }
      return w.toBytes()
    case 4:
      w.string(t.network)
      acct(w, t.subject)
      w.u64(t.revision)
      ts(w, t.timestamp)
      w.uleb(t.relays.length)
      for (const r of t.relays) {
        w.bytes(r.relayId).string(r.endpoint)
        acct(w, r.identity)
        ts(w, r.expiry)
      }
      // Optional fields 5-7: each is a BCS Option (0 = none).
      w.uleb(t.keyTransitions ? 1 : 0)
      if (t.keyTransitions)
        throw new Error('key transitions are not part of the fixtures')
      w.uleb(t.expiry ? 1 : 0)
      if (t.expiry) ts(w, t.expiry)
      w.uleb(t.recoveryAuthorities ? 1 : 0)
      if (t.recoveryAuthorities)
        throw new Error('authorities are not part of the fixtures')
      return w.toBytes()
    case 3:
      w.string(t.network)
      acct(w, t.owner)
      w.fixed(t.checkpointId)
      ts(w, t.timestamp)
      w.uleb(t.facts.length)
      for (const f of t.facts) {
        ts(w, f.timestamp)
        w.fixed(f.factId).u16(f.kind).bytes(f.payload)
      }
      w.uleb(t.sections ? 1 : 0)
      if (t.sections) {
        w.uleb(t.sections.length)
        for (const s of t.sections)
          w.u32(s.sectionType).u32(s.sectionSchemaVersion).bytes(s.value)
      }
      return w.toBytes()
    default:
      throw new Error(`no BCS mapping for type ${t.type}`)
  }
}

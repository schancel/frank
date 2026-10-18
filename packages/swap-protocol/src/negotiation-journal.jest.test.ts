import { secp256k1 } from '@noble/curves/secp256k1'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MonadIdentity } from '../../wallet/evm-identity'
import {
  encodeSignedSwapEvent,
  type SignedSwapEvent,
  type SwapResult,
} from './index'
import {
  buildNegotiationOffer,
  buildNegotiationResponse,
  TESTNET_NEGOTIATION_POLICY,
  type NegotiationContext,
} from './negotiation'
import {
  NegotiationJournal,
  inspectNegotiationJournalRecord,
  NegotiationJournalError,
  negotiationJournalLimits,
  type NegotiationJournalAdmission,
  type NegotiationJournalOwner,
  type NegotiationJournalStore,
} from './negotiation-journal'

const a = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
const b = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const stranger = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}03`)
const sign = (identity: MonadIdentity) => async (digest: Uint8Array) =>
  new Uint8Array(identity.signHash(Buffer.from(digest)))
function must<T>(result: SwapResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}
const context = (): NegotiationContext => ({
  swapId: Buffer.alloc(32, 0x11),
  conversationId: Buffer.alloc(16, 0x22),
  parties: [Buffer.from(a.compressedPubKey), Buffer.from(b.compressedPubKey)],
  policy: { ...TESTNET_NEGOTIATION_POLICY },
})
const owner = (): NegotiationJournalOwner => ({
  accountIncarnation: 'incarnation-a',
  localPublicKey: Buffer.from(a.compressedPubKey),
  messagingChainIdentifier: 'monad-testnet',
})
const encoded = (event: SignedSwapEvent) => must(encodeSignedSwapEvent(event))
async function offer(value = 12345n, bound = context()) {
  return encoded(
    must(
      await buildNegotiationOffer(
        bound,
        {
          xecPrincipal: value,
          evmPrincipal: 1000000000000000001n,
          expiry: 2000000000n,
        },
        sign(a),
      ),
    ),
  )
}
async function response(
  first: Uint8Array,
  decision: 'accept' | 'reject' = 'accept',
) {
  return encoded(
    must(await buildNegotiationResponse(context(), first, decision, sign(b))),
  )
}
const admission = (
  eventBytes: Uint8Array,
  role: 0 | 1 = 0,
): NegotiationJournalAdmission => ({
  eventBytes: Buffer.from(eventBytes),
  messageId: Buffer.alloc(16, 0x33),
  stampedPayloadDigest: Buffer.alloc(32, 0x44),
  authenticated: {
    direction: role === 0 ? 'outbound-replay' : 'incoming',
    localPublicKey: Buffer.from(a.compressedPubKey),
    senderPublicKey: Buffer.from((role === 0 ? a : b).compressedPubKey),
    recipientPublicKey: Buffer.from((role === 0 ? b : a).compressedPubKey),
    conversationId: Buffer.alloc(16, 0x22),
    messagingChainIdentifier: 'monad-testnet',
  },
})
/** Test-only committed string rows; the comparison and commit are one synchronous linearization. */
class MemoryCas implements NegotiationJournalStore {
  readonly rows = new Map<string, string>()
  reads = 0
  attempts = 0
  writes = 0
  async read(key: string) {
    this.reads++
    return this.rows.get(key)
  }
  async compareAndSwap(
    key: string,
    expected: string | undefined,
    next: string,
  ) {
    this.attempts++
    if (this.rows.get(key) !== expected) return false
    this.rows.set(key, next)
    this.writes++
    return true
  }
}
const journal = (
  store = new MemoryCas(),
  boundOwner = owner(),
  boundContext = context(),
) => new NegotiationJournal({ store, owner: boundOwner, context: boundContext })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function row(store: MemoryCas, engine: NegotiationJournal) {
  return JSON.parse(store.rows.get(engine.rowKey)!)
}
function overwrite(
  store: MemoryCas,
  engine: NegotiationJournal,
  change: (value: Record<string, any>) => void,
) {
  const value = row(store, engine)
  change(value)
  store.rows.set(engine.rowKey, JSON.stringify(value))
  return store.rows.get(engine.rowKey)!
}

it('limits production imports to pure existing boundaries and keeps core entry unchanged', () => {
  const source = readFileSync(join(__dirname, 'negotiation-journal.ts'), 'utf8')
  expect(
    [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]),
  ).toEqual([
    '@noble/hashes/sha256.js',
    '@noble/hashes/utils.js',
    '@frank/codec',
    '../../../docs/protocol/chains/v1.json',
    './negotiation',
  ])
  expect(readFileSync(join(__dirname, 'index.ts'), 'utf8')).not.toContain(
    './negotiation-journal',
  )
})

it('pins the independently framed row key and exact normalized record vector', async () => {
  const store = new MemoryCas(),
    engine = journal(store),
    first = await offer()
  expect(engine.rowKey).toBe(
    '0095bc9b284097d543066203c099f158ef8e800f3097f7c30dace06c4c96e1cc',
  )
  await engine.admit(admission(first))
  const expected = {
    version: 1,
    owner: {
      accountIncarnation: 'incarnation-a',
      localPublicKey:
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      messagingChainIdentifier: 'monad-testnet',
    },
    context: {
      swapId: '11'.repeat(32),
      conversationId: '22'.repeat(16),
      parties: [
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      ],
      policy: {
        name: 'xec-monad-testnet-v1',
        xecChainIdentifier: 'xec-testnet',
        evmChainIdentifier: 'monad-testnet',
      },
    },
    entries: [
      {
        eventBytes: bytesToHex(first),
        senderPublicKey:
          '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        recipientPublicKey:
          '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
        direction: 'outbound-replay',
        messageId: '33'.repeat(16),
        stampedPayloadDigest: '44'.repeat(32),
      },
    ],
  }
  expect(store.rows.get(engine.rowKey)).toBe(JSON.stringify(expected))
  expect(bytesToHex(sha256(Buffer.from(store.rows.get(engine.rowKey)!)))).toBe(
    '40af427fdb183e11152fe892c2bfeab6cfa9b0ab0aa19f3aba461fd1820de045',
  )
})

it('reads absent state without writes and reconstructs reordered offer/accept/reject evidence across reopen', async () => {
  const store = new MemoryCas(),
    engine = journal(store),
    first = await offer(),
    accepted = await response(first)
  expect(await engine.read()).toMatchObject({
    presence: 'absent',
    entries: [],
    reduction: { usableAcceptance: null },
  })
  expect(store.rows.size).toBe(0)
  expect(store.attempts).toBe(0)
  const orphan = await engine.admit(admission(accepted, 1))
  expect(orphan.reduction.buffered).toHaveLength(1)
  expect(orphan.reduction.usableAcceptance).toBeNull()
  const complete = await journal(store).admit(admission(first))
  expect(complete.reduction.usableAcceptance?.xecPrincipal).toBe(12345n)
  const raw = store.rows.get(engine.rowKey),
    writes = store.writes
  const deliveredAgain = admission(first)
  ;(deliveredAgain.messageId as Uint8Array).fill(0x55)
  ;(deliveredAgain.stampedPayloadDigest as Uint8Array).fill(0x66)
  expect((await engine.admit(deliveredAgain)).admission).toBe('duplicate')
  expect(store.rows.get(engine.rowKey)).toBe(raw)
  expect(store.writes).toBe(writes)
  expect((await engine.read()).reduction.usableAcceptance?.evmPrincipal).toBe(
    1000000000000000001n,
  )
  const rejectedStore = new MemoryCas(),
    rejected = journal(rejectedStore)
  await rejected.admit(admission(await response(first, 'reject'), 1))
  await rejected.admit(admission(first))
  expect((await journal(rejectedStore).read()).reduction).toMatchObject({
    history: { decision: 'reject' },
    usableAcceptance: null,
    violation: null,
  })
})

it('retains distinct signed decision and offer conflicts instead of overwriting or authorizing acceptance', async () => {
  for (const conflict of ['decision', 'offer']) {
    const store = new MemoryCas(),
      engine = journal(store),
      first = await offer()
    await engine.admit(admission(first))
    await engine.admit(admission(await response(first), 1))
    const additional =
      conflict === 'decision'
        ? admission(await response(first, 'reject'), 1)
        : admission(await offer(999n))
    const conflicted = await engine.admit(additional)
    expect(conflicted.entries).toHaveLength(3)
    expect(conflicted.reduction.violation).not.toBeNull()
    expect(conflicted.reduction.usableAcceptance).toBeNull()
    expect(
      row(store, engine).entries.map(
        (item: { eventBytes: string }) => item.eventBytes,
      ),
    ).toContain(bytesToHex(first))
    expect((await journal(store).read()).reduction.usableAcceptance).toBeNull()
  }
})

it('rejects wrong delivery bindings, including wrong-chain duplicates, without a write', async () => {
  const store = new MemoryCas(),
    engine = journal(store),
    first = await offer()
  await engine.admit(admission(first))
  const raw = store.rows.get(engine.rowKey),
    writes = store.writes
  const variants: Array<(value: any) => void> = [
    value => {
      value.authenticated.messagingChainIdentifier = 'xec-testnet'
    },
    value => {
      value.authenticated.localPublicKey = b.compressedPubKey
    },
    value => {
      value.authenticated.conversationId.fill(1)
    },
    value => {
      value.authenticated.senderPublicKey = b.compressedPubKey
    },
    value => {
      value.authenticated.recipientPublicKey = stranger.compressedPubKey
    },
    value => {
      value.authenticated.direction = 'incoming'
    },
    value => {
      value.authenticated.direction = undefined
    },
    value => {
      value.messageId = undefined
    },
    value => {
      value.stampedPayloadDigest = new Uint8Array(31)
    },
    value => {
      value.eventBytes = new Uint8Array(1025)
    },
  ]
  for (const change of variants) {
    const value = admission(first)
    change(value)
    await expect(engine.admit(value)).rejects.toMatchObject({
      code: 'invalid-input',
    })
    expect(store.rows.get(engine.rowKey)).toBe(raw)
  }
  const otherContext = context()
  otherContext.swapId[0] = 7
  await expect(
    engine.admit(admission(await offer(12345n, otherContext))),
  ).rejects.toMatchObject({ code: 'invalid-input' })
  const invalidSignature = Buffer.from(first)
  invalidSignature[invalidSignature.length - 1] ^= 1
  await expect(engine.admit(admission(invalidSignature))).rejects.toMatchObject(
    { code: 'invalid-input' },
  )
  expect(store.writes).toBe(writes)
})

it('validates owner/context synchronously and isolates keys across every immutable binding component', () => {
  const store = new MemoryCas(),
    original = journal(store)
  const changedOwner = [
    { ...owner(), accountIncarnation: 'incarnation-b' },
    { ...owner(), localPublicKey: b.compressedPubKey },
    { ...owner(), messagingChainIdentifier: 'xec-testnet' },
  ]
  for (const value of changedOwner)
    expect(journal(store, value).rowKey).not.toBe(original.rowKey)
  const changedContext = context()
  changedContext.swapId[0] = 3
  expect(journal(store, owner(), changedContext).rowKey).not.toBe(
    original.rowKey,
  )
  for (const value of ['', 'x'.repeat(257), '😀'.repeat(65), '\ud800'])
    expect(() =>
      journal(store, { ...owner(), accountIncarnation: value }),
    ).toThrow(NegotiationJournalError)
  expect(() =>
    journal(store, { ...owner(), messagingChainIdentifier: 'monad' }),
  ).toThrow(NegotiationJournalError)
  expect(() =>
    journal(store, { ...owner(), localPublicKey: stranger.compressedPubKey }),
  ).toThrow(NegotiationJournalError)
  const repeated = context()
  repeated.parties[1].set(repeated.parties[0])
  expect(() => journal(store, owner(), repeated)).toThrow(
    NegotiationJournalError,
  )
  expect(
    journal(store, { ...owner(), accountIncarnation: '😀'.repeat(64) }).rowKey,
  ).toHaveLength(64)
  expect(store.reads).toBe(0)
})

it('rejects malformed, unknown, oversized or changed stored bindings/metadata without repair', async () => {
  const store = new MemoryCas(),
    engine = journal(store),
    first = await offer()
  await engine.admit(admission(first))
  const valid = store.rows.get(engine.rowKey)!
  const variants: Array<(value: any) => void> = [
    value => {
      value.version = 2
    },
    value => {
      value.extra = true
    },
    value => {
      value.entries[0].extra = true
    },
    value => {
      value.owner.accountIncarnation = 'other'
    },
    value => {
      value.owner.messagingChainIdentifier = 'xec-testnet'
    },
    value => {
      value.owner.localPublicKey = bytesToHex(b.compressedPubKey)
    },
    value => {
      value.context.conversationId = '00'.repeat(16)
    },
    value => {
      value.context.swapId = '00'.repeat(32)
    },
    value => {
      value.context.parties.reverse()
    },
    value => {
      value.context.policy.name = 'other'
    },
    value => {
      value.entries[0].senderPublicKey = bytesToHex(b.compressedPubKey)
    },
    value => {
      value.entries[0].recipientPublicKey = bytesToHex(
        stranger.compressedPubKey,
      )
    },
    value => {
      value.entries[0].direction = 'incoming'
    },
    value => {
      value.entries[0].messageId = '0'.repeat(31)
    },
    value => {
      value.entries[0].stampedPayloadDigest = 'AA'.repeat(32)
    },
    value => {
      value.entries[0].eventBytes = '00'
    },
    value => {
      value.entries.push(value.entries[0])
    },
  ]
  const attempts = store.attempts
  for (const change of variants) {
    store.rows.set(engine.rowKey, valid)
    const broken = overwrite(store, engine, change)
    await expect(engine.read()).rejects.toMatchObject({
      code: 'corrupt-record',
    })
    await expect(engine.admit(admission(first))).rejects.toMatchObject({
      code: 'corrupt-record',
    })
    expect(store.rows.get(engine.rowKey)).toBe(broken)
  }
  for (const broken of [
    '{',
    'null',
    '[]',
    ' '.repeat(262145),
    '"' + '😀'.repeat(70000) + '"',
  ]) {
    store.rows.set(engine.rowKey, broken)
    await expect(engine.read()).rejects.toMatchObject({
      code: 'corrupt-record',
    })
    expect(store.rows.get(engine.rowKey)).toBe(broken)
  }
  expect(store.attempts).toBe(attempts)
})

it('merges two independent racing instances using fresh rows after a lost CAS', async () => {
  const store = new MemoryCas(),
    entered = deferred(),
    gate = deferred(),
    actual = store.compareAndSwap.bind(store)
  let count = 0
  store.compareAndSwap = async (...args) => {
    if (++count === 1) {
      entered.resolve()
      await gate.promise
    }
    return actual(...args)
  }
  const left = journal(store),
    right = journal(store),
    first = await offer()
  const pending = left.admit(admission(first))
  await entered.promise
  await right.admit(admission(await response(first), 1))
  gate.resolve()
  await pending
  expect(store.writes).toBe(2)
  expect(store.attempts).toBe(3)
  expect((await left.read()).entries).toHaveLength(2)
  expect((await right.read()).reduction.usableAcceptance).not.toBeNull()
})

it('exhausts exactly eight CAS-false attempts and propagates read/write/ambiguous failures without retry', async () => {
  const store = new MemoryCas(),
    first = await offer(),
    fail = new Error('storage unavailable')
  store.compareAndSwap = async () => {
    store.attempts++
    return false
  }
  const engine = journal(store)
  await expect(engine.admit(admission(first))).rejects.toMatchObject({
    code: 'contention',
  })
  expect(store.attempts).toBe(8)
  expect(store.reads).toBe(8)
  expect(store.rows.size).toBe(0)
  const reading = new MemoryCas()
  reading.read = async () => {
    throw fail
  }
  await expect(journal(reading).admit(admission(first))).rejects.toBe(fail)
  await expect(journal(reading).read()).rejects.toBe(fail)
  expect(reading.attempts).toBe(0)
  const writing = new MemoryCas()
  writing.compareAndSwap = async () => {
    writing.attempts++
    throw fail
  }
  await expect(journal(writing).admit(admission(first))).rejects.toBe(fail)
  expect(writing.attempts).toBe(1)
  const ambiguous = new MemoryCas(),
    commit = ambiguous.compareAndSwap.bind(ambiguous)
  ambiguous.compareAndSwap = async (...args) => {
    await commit(...args)
    throw fail
  }
  await expect(journal(ambiguous).admit(admission(first))).rejects.toBe(fail)
  const raw = ambiguous.rows.get(engine.rowKey)
  expect(raw).toBeDefined()
  expect((await journal(ambiguous).admit(admission(first))).admission).toBe(
    'duplicate',
  )
  expect(ambiguous.rows.get(engine.rowKey)).toBe(raw)
  expect(ambiguous.writes).toBe(1)
})

it('keeps all 64 signed conflicts at capacity, permits authenticated duplicates, and never evicts', async () => {
  const store = new MemoryCas(),
    engine = journal(store)
  // Construct a fully authenticated row once; insertion CAS still exercises capacity below.
  const first = await offer()
  await engine.admit(admission(first))
  const full = row(store, engine)
  for (let i = 1; i < 64; i++)
    full.entries.push({
      ...full.entries[0],
      eventBytes: bytesToHex(await offer(BigInt(12345 + i))),
    })
  store.rows.set(engine.rowKey, JSON.stringify(full))
  const raw = store.rows.get(engine.rowKey),
    writes = store.writes
  const read = await engine.read()
  expect(read.entries).toHaveLength(64)
  expect(read.reduction.usableAcceptance).toBeNull()
  expect(read.reduction.violation).not.toBeNull()
  expect((await engine.admit(admission(first))).admission).toBe('duplicate')
  await expect(
    engine.admit(admission(await offer(99999n))),
  ).rejects.toMatchObject({ code: 'capacity' })
  expect(store.rows.get(engine.rowKey)).toBe(raw)
  expect(store.writes).toBe(writes)
  full.entries.push(full.entries[0])
  store.rows.set(engine.rowKey, JSON.stringify(full))
  await expect(engine.read()).rejects.toMatchObject({ code: 'corrupt-record' })
}, 20000)

it('snapshots Buffer inputs before delayed reads/CAS and never exposes mutable persisted aliases', async () => {
  const store = new MemoryCas(),
    boundOwner = owner(),
    boundContext = context(),
    engine = journal(store, boundOwner, boundContext),
    first = await offer()
  const key = engine.rowKey
  boundOwner.localPublicKey.fill(0)
  boundContext.swapId.fill(0)
  boundContext.conversationId.fill(0)
  boundContext.parties[0].fill(0)
  ;(boundContext.policy as { xecChainIdentifier: string }).xecChainIdentifier =
    'wrong'
  expect(engine.rowKey).toBe(key)
  const started = deferred(),
    gate = deferred(),
    actualRead = store.read.bind(store)
  store.read = async name => {
    started.resolve()
    await gate.promise
    return actualRead(name)
  }
  // New instance snapshots the delayed read capability; use original untouched binding.
  const delayed = journal(store),
    input = admission(first),
    pending = delayed.admit(input)
  await started.promise
  input.eventBytes.fill(0)
  input.messageId.fill(0)
  input.stampedPayloadDigest.fill(0)
  input.authenticated.senderPublicKey.fill(0)
  input.authenticated.localPublicKey.fill(0)
  input.authenticated.conversationId.fill(0)
  ;(input.authenticated as { direction: string }).direction = 'incoming'
  gate.resolve()
  const saved = await pending
  expect(bytesToHex(saved.entries[0]!.eventBytes)).toBe(bytesToHex(first))
  expect(bytesToHex(saved.entries[0]!.messageId)).toBe('33'.repeat(16))
  expect((await engine.admit(admission(first))).admission).toBe('duplicate')
  expect(bytesToHex((await engine.read()).entries[0]!.eventBytes)).toBe(
    bytesToHex(first),
  )
  const persisted = store.rows.get(key)
  saved.entries[0]!.eventBytes.fill(0)
  saved.entries[0]!.messageId.fill(0)
  saved.reduction.history.offer!.terms.parties[0].fill(0)
  expect(store.rows.get(key)).toBe(persisted)
  expect(bytesToHex((await delayed.read()).entries[0]!.eventBytes)).toBe(
    bytesToHex(first),
  )
  const casStarted = deferred(),
    casGate = deferred(),
    actualCas = store.compareAndSwap.bind(store)
  store.compareAndSwap = async (...args) => {
    casStarted.resolve()
    await casGate.promise
    return actualCas(...args)
  }
  const second = journal(store),
    incoming = admission(await response(first), 1),
    admitting = second.admit(incoming)
  await casStarted.promise
  incoming.eventBytes.fill(0)
  incoming.authenticated.recipientPublicKey.fill(0)
  casGate.resolve()
  await admitting
  expect((await second.read()).reduction.usableAcceptance).not.toBeNull()
  expect(negotiationJournalLimits).toEqual({ rawBytes: 262144, casAttempts: 8 })
})

it('offers one strict pure inspection seam without assumed host affinity or returned aliases', async () => {
  const store = new MemoryCas(),
    engine = journal(store),
    first = await offer()
  await engine.admit(admission(first))
  const raw = store.rows.get(engine.rowKey)!,
    reads = store.reads
  const inspected = inspectNegotiationJournalRecord(raw)
  expect(inspected.rowKey).toBe(engine.rowKey)
  expect(inspected.owner.messagingChainIdentifier).toBe('monad-testnet')
  expect(inspected.context.policy).toEqual(TESTNET_NEGOTIATION_POLICY)
  inspected.owner.localPublicKey.fill(0)
  inspected.context.parties[0].fill(0)
  inspected.context.swapId.fill(0)
  inspected.entries[0]!.eventBytes.fill(0)
  inspected.reduction.history.offer!.terms.conversationId.fill(0)
  expect(inspectNegotiationJournalRecord(raw).rowKey).toBe(engine.rowKey)
  expect(
    bytesToHex(inspectNegotiationJournalRecord(raw).entries[0]!.eventBytes),
  ).toBe(bytesToHex(first))
  expect(store.reads).toBe(reads)
  for (const bad of [
    '{',
    'null',
    ' '.repeat(262145),
    JSON.stringify({ ...JSON.parse(raw), version: 2 }),
  ])
    expect(() => inspectNegotiationJournalRecord(bad)).toThrow(
      NegotiationJournalError,
    )
  const wrongLocal = JSON.parse(raw)
  wrongLocal.owner.localPublicKey = bytesToHex(stranger.compressedPubKey)
  expect(() =>
    inspectNegotiationJournalRecord(JSON.stringify(wrongLocal)),
  ).toThrow(NegotiationJournalError)
  const forgedSender = JSON.parse(raw)
  forgedSender.entries[0].senderPublicKey = bytesToHex(b.compressedPubKey)
  expect(() =>
    inspectNegotiationJournalRecord(JSON.stringify(forgedSender)),
  ).toThrow(NegotiationJournalError)
  const otherIncarnation = JSON.parse(raw)
  otherIncarnation.owner.accountIncarnation = 'other-incarnation'
  // An unbound inspector validates structure/proofs, not hostile local-store provenance.
  expect(
    inspectNegotiationJournalRecord(JSON.stringify(otherIncarnation)).rowKey,
  ).not.toBe(engine.rowKey)
})

it('retains distinct valid signature bytes while leaving semantic duplicate reduction to S5a', async () => {
  const store = new MemoryCas(),
    engine = journal(store),
    first = await offer()
  const secret = new Uint8Array(32)
  secret[31] = 1
  const alternate = encoded(
    must(
      await buildNegotiationOffer(
        context(),
        {
          xecPrincipal: 12345n,
          evmPrincipal: 1000000000000000001n,
          expiry: 2000000000n,
        },
        async digest =>
          secp256k1
            .sign(digest, secret, {
              lowS: true,
              extraEntropy: new Uint8Array(32).fill(7),
            })
            .toDERRawBytes(),
      ),
    ),
  )
  expect(bytesToHex(alternate)).not.toBe(bytesToHex(first))
  await engine.admit(admission(first))
  const result = await engine.admit(admission(alternate))
  expect(result.entries).toHaveLength(2)
  expect(result.reduction.applied).toHaveLength(1)
  expect(result.reduction.violation).toBeNull()
  expect(store.writes).toBe(2)
  const raw = store.rows.get(engine.rowKey)
  await engine.admit(admission(alternate))
  expect(store.rows.get(engine.rowKey)).toBe(raw)
})

it('admits the other local party with incoming offer and outbound response under its distinct owner row', async () => {
  const store = new MemoryCas(),
    engine = journal(store, { ...owner(), localPublicKey: b.compressedPubKey }),
    first = await offer()
  const offered = admission(first)
  const accepted = admission(await response(first), 1)
  const incoming: NegotiationJournalAdmission = {
    ...offered,
    authenticated: {
      ...offered.authenticated,
      direction: 'incoming',
      localPublicKey: b.compressedPubKey,
    },
  }
  const outbound: NegotiationJournalAdmission = {
    ...accepted,
    authenticated: {
      ...accepted.authenticated,
      direction: 'outbound-replay',
      localPublicKey: b.compressedPubKey,
    },
  }
  await engine.admit(incoming)
  const result = await engine.admit(outbound)
  expect(result.reduction.usableAcceptance?.xecPrincipal).toBe(12345n)
  expect((await journal(store).read()).presence).toBe('absent')
  expect(store.rows.size).toBe(1)
})

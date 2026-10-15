import chains from '../../../../docs/protocol/chains/v1.json'
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  buildNegotiationOffer,
  buildNegotiationResponse,
  TESTNET_NEGOTIATION_POLICY,
} from '../negotiation'
import { encodeSignedSwapEvent, type SwapResult } from '../index'
import {
  NegotiationJournal,
  inspectNegotiationJournalRecord,
  type NegotiationJournalAdmission,
  type NegotiationJournalStore,
} from '../negotiation-journal'
import {
  negotiationStorageLimits,
  type OwnedNegotiationJournalStore,
} from './negotiation-common'
const secret = (n: number) => {
  const bytes = new Uint8Array(32)
  bytes[31] = n
  return bytes
}
export const a = secp256k1.getPublicKey(secret(1), true),
  b = secp256k1.getPublicKey(secret(2), true)
export const binding = {
  hostDiscriminator: 'synthetic-host',
  accountIncarnation: 'account-é',
  localPublicKey: a,
}
export const owner = (chain = 'monad-testnet') => ({
  accountIncarnation: binding.accountIncarnation,
  localPublicKey: a,
  messagingChainIdentifier: chain,
})
export function context(index = 0) {
  const swapId = new Uint8Array(32)
  new DataView(swapId.buffer).setUint32(28, index, false)
  return {
    swapId,
    conversationId: new Uint8Array(16).fill(0x22),
    parties: [a, b] as const,
    policy: TESTNET_NEGOTIATION_POLICY,
  }
}
export function assert(
  value: unknown,
  message = 'Assertion failed',
): asserts value {
  if (!value) throw new Error(message)
}
export async function rejects(work: () => Promise<unknown>, message?: string) {
  try {
    await work()
  } catch (error) {
    if (message)
      assert(
        String(error).includes(message),
        'Unexpected rejection: ' + String(error),
      )
    return error
  }
  throw new Error('Expected rejection')
}
function must<T>(value: SwapResult<T>): T {
  if (!value.ok) throw new Error(value.error.code)
  return value.value
}
const sign = (n: number) => async (digest: Uint8Array) =>
  secp256k1.sign(digest, secret(n), { lowS: true }).toDERRawBytes()
export const engine = (
  store: NegotiationJournalStore,
  index = 0,
  chain = 'monad-testnet',
) =>
  new NegotiationJournal({
    store,
    owner: owner(chain),
    context: context(index),
  })
export async function signed(index = 0) {
  const first = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationOffer(
          context(index),
          {
            xecPrincipal: 12345n,
            evmPrincipal: 1000000000000000001n,
            expiry: 2000000000n,
          },
          sign(1),
        ),
      ),
    ),
  )
  const second = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationResponse(
          context(index),
          first,
          'accept',
          sign(2),
        ),
      ),
    ),
  )
  const admission = (
    eventBytes: Uint8Array,
    role: 0 | 1,
  ): NegotiationJournalAdmission => ({
    eventBytes,
    messageId: new Uint8Array(16).fill(0x33),
    stampedPayloadDigest: new Uint8Array(32).fill(0x44),
    authenticated: {
      direction: role === 0 ? 'outbound-replay' : 'incoming',
      localPublicKey: a,
      senderPublicKey: role === 0 ? a : b,
      recipientPublicKey: role === 0 ? b : a,
      conversationId: context(index).conversationId,
      messagingChainIdentifier: 'monad-testnet',
    },
  })
  return { offer: admission(first, 0), accept: admission(second, 1) }
}
/** Valid inspectable rows; capacity tests need no artificial limit or thousands of signatures. */
export function emptyRow(index: number, chain = 'monad-testnet') {
  const journal = engine(
      { read: async () => undefined, compareAndSwap: async () => false },
      index,
      chain,
    ),
    ctx = context(index)
  const raw = JSON.stringify({
    version: 1,
    owner: { ...owner(chain), localPublicKey: bytesToHex(a) },
    context: {
      swapId: bytesToHex(ctx.swapId),
      conversationId: bytesToHex(ctx.conversationId),
      parties: [bytesToHex(a), bytesToHex(b)],
      policy: TESTNET_NEGOTIATION_POLICY,
    },
    entries: [],
  })
  assert(inspectNegotiationJournalRecord(raw).rowKey === journal.rowKey)
  return { key: journal.rowKey, raw }
}
export async function signedCases(store: OwnedNegotiationJournalStore) {
  const events = await signed(),
    journal = engine(store)
  assert((await journal.read()).presence === 'absent')
  await journal.admit(events.accept) // Real orphan response, then its prerequisite.
  await journal.admit(events.offer)
  assert((await journal.read()).reduction.usableAcceptance !== null)
  let attempts = 0
  const counted = engine({
    read: key => store.read(key),
    compareAndSwap: (...args) => {
      attempts++
      return store.compareAndSwap(...args)
    },
  })
  assert((await counted.admit(events.offer)).admission === 'duplicate')
  assert(attempts === 0, 'Duplicate engine admission wrote storage')
  const raw = (await store.read(journal.rowKey))!
  const value = JSON.parse(raw),
    equivalent =
      JSON.stringify({
        entries: value.entries,
        context: value.context,
        owner: value.owner,
        version: value.version,
      }) + ' \n'
  assert(await store.compareAndSwap(journal.rowKey, raw, equivalent))
  assert(
    (await store.read(journal.rowKey)) === equivalent,
    'Raw JSON CAS must preserve accepted order/whitespace',
  )
  const results = await Promise.all([
    store.compareAndSwap(journal.rowKey, equivalent, raw),
    store.compareAndSwap(journal.rowKey, equivalent, raw + ' '),
  ])
  assert(
    results.filter(Boolean).length === 1,
    'Same-owner CAS lost linearizability',
  )
  return journal.rowKey
}
export async function rowCapacity(store: OwnedNegotiationJournalStore) {
  assert(await store.compareAndSwapCoverage('monad-testnet', undefined, 7))
  assert(
    negotiationStorageLimits.rows === 128 &&
      negotiationStorageLimits.rawBytes === 8388608,
  )
  const first = emptyRow(0)
  for (let i = 0; i < 127; i++) {
    const row = emptyRow(i, i % 2 ? 'xec-testnet' : 'monad-testnet')
    assert(await store.compareAndSwap(row.key, undefined, row.raw))
  }
  const left = emptyRow(127, 'xec-testnet'),
    right = emptyRow(128)
  const outcomes = await Promise.all(
    [
      store.compareAndSwap(left.key, undefined, left.raw),
      store.compareAndSwap(right.key, undefined, right.raw),
    ].map(p =>
      p.then(
        value => value,
        error => error,
      ),
    ),
  )
  assert(outcomes.filter(value => value === true).length === 1)
  assert(
    outcomes.filter(
      value => value instanceof Error && String(value).includes('capacity'),
    ).length === 1,
  )
  assert(
    await store.compareAndSwap(first.key, first.raw, first.raw + ' '),
    'Updates must remain possible at row capacity',
  )
  assert(
    !(await store.compareAndSwap(first.key, first.raw, first.raw)),
    'Comparison precedes proposed capacity refusal',
  )
  await rejects(
    () => store.compareAndSwap(emptyRow(129).key, undefined, emptyRow(129).raw),
    'capacity',
  )
  assert(
    (await store.read(first.key)) === first.raw + ' ',
    'Capacity refusal poisoned owner',
  )
  assert((await store.readCoverage('monad-testnet')) === 7)
  assert((await store.listRecords()).length === 128)
  // Real signed engine insertion updates an existing empty row at the actual row boundary.
  const events = await signed()
  await engine(store).admit(events.offer)
  assert((await engine(store).admit(events.offer)).admission === 'duplicate')
}
export async function byteCapacity(store: OwnedNegotiationJournalStore) {
  assert(await store.compareAndSwapCoverage('xec-testnet', undefined, 8))
  for (let i = 0; i < 32; i++) {
    const row = emptyRow(i, i % 2 ? 'xec-testnet' : 'monad-testnet')
    const raw = row.raw + ' '.repeat(262144 - utf8ToBytes(row.raw).length)
    assert(utf8ToBytes(raw).length === 262144)
    assert(await store.compareAndSwap(row.key, undefined, raw))
  }
  const row = emptyRow(32)
  await rejects(
    () => store.compareAndSwap(row.key, undefined, row.raw),
    'capacity',
  )
  assert((await store.readCoverage('xec-testnet')) === 8)
  const first = emptyRow(0),
    stored = (await store.read(first.key))!
  assert(
    await store.compareAndSwap(first.key, stored, first.raw),
    'Shrinking replacement must fit at byte capacity',
  )
  assert(
    await store.compareAndSwap(row.key, undefined, row.raw),
    'Capacity refusal must leave handle usable',
  )
}

/** Consumer-shaped replay: durable evidence may precede the scan consumption fact. */
export async function coverageCases(
  create: () =>
    | Promise<OwnedNegotiationJournalStore>
    | OwnedNegotiationJournalStore,
) {
  let store = await create()
  const chain = 'monad-testnet'
  assert((await store.listRecords()).length === 0)
  assert((await store.readCoverage(chain)) === undefined)
  assert(!(await store.compareAndSwapCoverage(chain, 0, 1)))
  for (const alias of ['monad', 'evm', 'MONAD-TESTNET', 'unknown'])
    await rejects(() => store.readCoverage(alias), 'Canonical')
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
    await rejects(() => store.compareAndSwapCoverage(chain, undefined, value))
  await rejects(() => store.compareAndSwapCoverage(chain, 2, 1), 'regress')
  assert(await store.compareAndSwapCoverage(chain, undefined, 0))
  assert((await store.listRecords()).length === 0)
  await store.close()
  store = await create()
  assert((await store.readCoverage(chain)) === 0)
  const events = await signed()
  const journal = engine(store)
  await journal.admit(events.offer)
  // A failed scan consumption attempt must leave evidence replayable.
  assert(!(await store.compareAndSwapCoverage(chain, undefined, 3)))
  await store.close()
  store = await create()
  assert((await store.readCoverage(chain)) === 0)
  assert((await engine(store).admit(events.offer)).admission === 'duplicate')
  assert(await store.compareAndSwapCoverage(chain, 0, 3))
  const snapshot = await store.listRecords()
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0]))
  assert(snapshot.length === 1 && snapshot[0].key === engine(store).rowKey)
  assert(snapshot[0].raw === (await store.read(snapshot[0].key)))
  const results = await Promise.all([
    store.compareAndSwapCoverage(chain, 3, 4),
    store.compareAndSwapCoverage(chain, 3, 5),
    store.compareAndSwapCoverage('xec-testnet', undefined, 9),
    store.compareAndSwapCoverage('solana-devnet', undefined, 11),
  ])
  assert(results.slice(0, 2).filter(Boolean).length === 1)
  assert(results[2] && results[3])
  const committed = (await store.readCoverage(chain))!
  assert(await store.compareAndSwapCoverage(chain, committed, committed))
  assert(
    await store.compareAndSwapCoverage(
      chain,
      committed,
      Number.MAX_SAFE_INTEGER,
    ),
  )
  await engine(store).admit(events.accept)
  assert((await store.readCoverage('xec-testnet')) === 9)
  assert(
    snapshot[0].raw !== (await store.read(snapshot[0].key)),
    'Inventory snapshot changed',
  )
  await store.close()
  store = await create()
  assert((await store.readCoverage(chain)) === Number.MAX_SAFE_INTEGER)
  assert((await store.listRecords()).length === 1)
  await store.close()
}

export const corruptCoverage = [
  '{}',
  '{"version":2,"positions":[]}',
  '{"version":1,"positions":[],"extra":0}',
  '{"version":1}',
  JSON.stringify({
    version: 1,
    positions: [{ chainIdentifier: 'monad', resumeFromInclusive: 0 }],
  }),
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1'].map(
    resumeFromInclusive =>
      JSON.stringify({
        version: 1,
        positions: [{ chainIdentifier: 'monad-testnet', resumeFromInclusive }],
      }),
  ),
  JSON.stringify({
    version: 1,
    positions: [
      { chainIdentifier: 'monad-testnet', resumeFromInclusive: 0, extra: 0 },
    ],
  }),
  JSON.stringify({
    version: 1,
    positions: [{ chainIdentifier: 'monad-testnet' }],
  }),
  JSON.stringify({
    version: 1,
    positions: [
      { chainIdentifier: 'monad-testnet', resumeFromInclusive: 0 },
      { chainIdentifier: 'monad-testnet', resumeFromInclusive: 1 },
    ],
  }),
  JSON.stringify({
    version: 1,
    positions: [
      { chainIdentifier: 'xec-testnet', resumeFromInclusive: 0 },
      { chainIdentifier: 'monad-testnet', resumeFromInclusive: 1 },
    ],
  }),
  JSON.stringify({
    version: 1,
    positions: Array.from({ length: 33 }, () => ({
      chainIdentifier: 'monad-testnet',
      resumeFromInclusive: 0,
    })),
  }),
  JSON.stringify({ version: 1, positions: [] }) + ' '.repeat(16384),
]

export async function coverageCapacity(store: OwnedNegotiationJournalStore) {
  for (const chain of chains.chains.slice(0, 32))
    assert(await store.compareAndSwapCoverage(chain.id, undefined, 0))
  await rejects(
    () => store.compareAndSwapCoverage(chains.chains[32].id, undefined, 0),
    'capacity',
  )
  assert(await store.compareAndSwapCoverage(chains.chains[0].id, 0, 1))
  const row = emptyRow(0)
  assert(await store.compareAndSwap(row.key, undefined, row.raw))
  assert((await store.readCoverage(chains.chains[32].id)) === undefined)
  assert((await store.readCoverage(chains.chains[0].id)) === 1)
}

export async function journalFirstCoverage(
  store: OwnedNegotiationJournalStore,
) {
  const rows = [emptyRow(0), emptyRow(1), emptyRow(2)]
  for (const row of rows)
    assert(await store.compareAndSwap(row.key, undefined, row.raw))
  assert((await store.readCoverage('monad-testnet')) === undefined)
  assert(await store.compareAndSwapCoverage('monad-testnet', undefined, 0))
  assert(
    JSON.stringify(await store.listRecords()) ===
      JSON.stringify(rows.sort((a, b) => (a.key < b.key ? -1 : 1))),
  )
}

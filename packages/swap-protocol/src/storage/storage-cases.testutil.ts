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
  // Real signed engine insertion updates an existing empty row at the actual row boundary.
  const events = await signed()
  await engine(store).admit(events.offer)
  assert((await engine(store).admit(events.offer)).admission === 'duplicate')
}
export async function byteCapacity(store: OwnedNegotiationJournalStore) {
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

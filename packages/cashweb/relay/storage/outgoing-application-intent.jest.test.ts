import protocol from '../../../../docs/protocol/chains/v1.json'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { LevelMessageStore } from './level-storage'
import type { MessageMetadataBackend } from './message-store-backend'
import {
  applicationClaim as claim,
  applicationCompletion as completion,
  numberedClaim,
} from './outgoing-application-intent.testutil'
import {
  outgoingApplicationClaim,
  outgoingApplicationRecord,
} from './outgoing-application-intent'

jest.setTimeout(30000)

let location: string, store: LevelMessageStore
beforeEach(async () => {
  location = await mkdtemp(join(tmpdir(), 'outgoing-app-intent-'))
  store = new LevelMessageStore(location)
  await store.Open()
})
afterEach(async () => {
  jest.restoreAllMocks()
  await store.Close()
  await rm(location, { recursive: true, force: true })
})
const backend = () =>
  Reflect.get(store, 'metadataBackend') as MessageMetadataBackend
async function reopen() {
  await store.Close()
  store = new LevelMessageStore(location)
  await store.Open()
}

it('keeps missing reads nonmutating, scopes records and returns frozen canonical copies', async () => {
  expect(await store.outgoingApplicationMessage(claim)).toBeUndefined()
  expect(await store.outgoingApplicationMessages(claim)).toEqual([])
  expect(await store.metadataDb.iterator().next()).toBeUndefined()
  const mutable = { ...claim }
  const pending = store.claimOutgoingApplicationMessage(mutable)
  mutable.intentHex = '00'
  const result = await pending
  expect(Object.isFrozen(result)).toBe(true)
  expect(result.intentHex).toBe(claim.intentHex)
  expect(await store.metadataDb.get('schemaVersion')).toBe('3')
  await expect(
    store.outgoingApplicationMessage({ ...claim, accountId: 'other' }),
  ).rejects.toThrow('account conflict')
  expect(
    await store.outgoingApplicationMessages({ accountId: 'other' }),
  ).toEqual([])
  await store.claimOutgoingApplicationMessage(numberedClaim(2))
  await store.claimOutgoingApplicationMessage(numberedClaim(1))
  expect(
    (await store.outgoingApplicationMessages(claim)).map(row => row.intentKey),
  ).toEqual([
    numberedClaim(1).intentKey,
    numberedClaim(2).intentKey,
    claim.intentKey,
  ])
})
it('durably claims one choice, resumes after interruption, completes once and reuses signed identity after history clearing', async () => {
  await expect(
    store.completeOutgoingApplicationMessage(completion),
  ).rejects.toThrow('missing')
  expect(await store.metadataDb.iterator().next()).toBeUndefined()
  const writes = jest.spyOn(store.metadataDb, 'batch')
  const results = await Promise.allSettled([
    store.claimOutgoingApplicationMessage(claim),
    store.claimOutgoingApplicationMessage({
      ...claim,
      intentHex: '6465636c696e65',
    }),
  ])
  expect(results.map(result => result.status)).toEqual([
    'fulfilled',
    'rejected',
  ])
  expect(writes).toHaveBeenCalledWith(expect.any(Array), { sync: true })
  await reopen()
  expect((await store.outgoingApplicationMessage(claim))?.phase).toBe('claimed')
  const signed = await store.completeOutgoingApplicationMessage(completion)
  expect(await store.claimOutgoingApplicationMessage(claim)).toEqual(signed)
  expect(await store.completeOutgoingApplicationMessage(completion)).toEqual(
    signed,
  )
  for (const changed of [
    { ...completion, signedPayloadHex: '00' },
    { ...completion, messageId: claim.conversationId },
  ])
    await expect(
      store.completeOutgoingApplicationMessage(changed),
    ).rejects.toThrow('conflict')
  await store.deleteMessage('synthetic-history')
  await store.suppressAndDelete(
    'synthetic-recipient',
    [],
    [{ payloadDigest: 'synthetic-history' }],
  )
  await store.clear()
  await reopen()
  expect(await store.outgoingApplicationMessage(claim)).toEqual(signed)
  expect(signed).toMatchObject({
    signedPayloadHex: completion.signedPayloadHex,
    messageId: completion.messageId,
  })
  expect(await store.metadataDb.get('schemaVersion')).toBe('3')
})
it.each([
  { accountId: 'other' },
  { signerKeyId: 'ef'.repeat(32) },
  { messagingChainIdentifier: 'solana-devnet' },
  {
    recipientPublicKey:
      '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  },
  { conversationId: completion.messageId },
  { stampValueWei: '1' },
  { intentHex: '00' },
])(
  'rejects changed immutable context %j and keeps owner usable',
  async changed => {
    await store.claimOutgoingApplicationMessage(claim)
    await expect(
      store.claimOutgoingApplicationMessage({ ...claim, ...changed }),
    ).rejects.toThrow('conflict')
    expect(
      (await store.completeOutgoingApplicationMessage(completion)).phase,
    ).toBe('signed')
  },
)
it('caps retained records per account atomically while allowing replay/completion and a separate account', async () => {
  for (let i = 0; i < 127; i++)
    await store.claimOutgoingApplicationMessage(numberedClaim(i))
  const results = await Promise.allSettled([
    store.claimOutgoingApplicationMessage(numberedClaim(127)),
    store.claimOutgoingApplicationMessage(numberedClaim(128)),
  ])
  expect(results.map(row => row.status)).toEqual(['fulfilled', 'rejected'])
  expect(await store.outgoingApplicationMessages(claim)).toHaveLength(128)
  expect(
    await store.claimOutgoingApplicationMessage(numberedClaim(127)),
  ).toMatchObject({ phase: 'claimed' })
  expect(
    (
      await store.completeOutgoingApplicationMessage({
        ...completion,
        claim: numberedClaim(127),
      })
    ).phase,
  ).toBe('signed')
  await store.claimOutgoingApplicationMessage(numberedClaim(129, 'other'))
  await expect(
    store.claimOutgoingApplicationMessage(numberedClaim(127, 'other')),
  ).rejects.toThrow('conflict')
})
it('poisons uncertain completion acknowledgment and recovers the actual committed bytes after reopen', async () => {
  await store.claimOutgoingApplicationMessage(claim)
  const owner = backend(),
    original = owner.outgoingApplicationIntent.bind(owner)
  jest
    .spyOn(owner, 'outgoingApplicationIntent')
    .mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('ack lost')
    })
  await expect(
    store.completeOutgoingApplicationMessage(completion),
  ).rejects.toMatchObject({ code: 'write-uncertain' })
  await expect(
    store.claimOutgoingApplicationMessage(numberedClaim(1)),
  ).rejects.toMatchObject({ code: 'unavailable' })
  await reopen()
  expect(await store.outgoingApplicationMessage(claim)).toMatchObject({
    ...completion.claim,
    phase: 'signed',
    signedPayloadHex: completion.signedPayloadHex,
    messageId: completion.messageId,
  })
})
it('close drains accepted claims/completion but rejects new work', async () => {
  const owner = backend(),
    original = owner.outgoingApplicationIntent.bind(owner)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  jest
    .spyOn(owner, 'outgoingApplicationIntent')
    .mockImplementationOnce(async (...args) => {
      await gate
      return original(...args)
    })
  const accepted = store.claimOutgoingApplicationMessage(claim)
  const completed = store.completeOutgoingApplicationMessage(completion)
  const closing = store.Close()
  await expect(
    store.claimOutgoingApplicationMessage(numberedClaim(1)),
  ).rejects.toMatchObject({ code: 'unavailable' })
  release()
  await Promise.all([accepted, completed, closing])
  store = new LevelMessageStore(location)
  await store.Open()
  expect(await store.outgoingApplicationMessage(claim)).toMatchObject({
    phase: 'signed',
  })
})
it('surfaces malformed rows during list and restoration without deleting them', async () => {
  await store.claimOutgoingApplicationMessage(claim)
  await store.metadataDb.put(
    'outgoingApplicationIntent:' + numberedClaim(1).intentKey,
    '{}',
  )
  await expect(
    store.outgoingApplicationMessages({ accountId: 'other' }),
  ).rejects.toThrow('Invalid')
  await store.Close()
  store = new LevelMessageStore(location)
  await expect(store.Open()).rejects.toMatchObject({ code: 'unavailable' })
  const raw = level(join(location, 'metadata'))
  expect(
    await raw.get('outgoingApplicationIntent:' + numberedClaim(1).intentKey),
  ).toBe('{}')
  await raw.close()
})
it('rejects old schema2 unchanged', async () => {
  await store.Close()
  const raw = level(join(location, 'metadata'))
  await raw.put('schemaVersion', '2')
  await raw.put('retained', 'bytes')
  await raw.close()
  store = new LevelMessageStore(location)
  await expect(store.Open()).rejects.toMatchObject({
    code: 'unsupported-schema',
  })
  const check = level(join(location, 'metadata'))
  expect(await check.get('schemaVersion')).toBe('2')
  expect(await check.get('retained')).toBe('bytes')
  await check.close()
})
it.each([
  { version: 2 },
  { extra: true },
  { intentKey: 'AB'.repeat(32) },
  { accountId: 'é'.repeat(257) },
  { signerKeyId: '00' },
  { messagingChainIdentifier: 'evm' },
  { recipientPublicKey: '02' + 'ff'.repeat(32) },
  { conversationId: completion.messageId.toUpperCase() },
  { stampValueWei: '01' },
  { stampValueWei: (1n << 256n).toString() },
  { intentHex: '' },
  { intentHex: 'a' },
  { intentHex: 'aa'.repeat(4097) },
])('rejects malformed input %j before mutation', async changed => {
  expect(() => outgoingApplicationClaim({ ...claim, ...changed })).toThrow()
  expect(await store.metadataDb.iterator().next()).toBeUndefined()
})
it('bounds signed bytes and rejects unknown/invalid phase fields', () => {
  for (const row of [
    { ...claim, phase: 'claimed', messageId: undefined },
    { ...claim, phase: 'claimed', signedPayloadHex: 'aa' },
    {
      ...claim,
      phase: 'signed',
      signedPayloadHex: 'aa'.repeat(4097),
      messageId: completion.messageId,
    },
    {
      ...claim,
      phase: 'signed',
      signedPayloadHex: 'AA',
      messageId: completion.messageId,
    },
    { ...claim, phase: 'signed', signedPayloadHex: 'aa', messageId: 'bad' },
  ])
    expect(() => outgoingApplicationRecord(row)).toThrow()
})

it('round trips every canonical registry network without family defaults', async () => {
  for (const [index, chain] of protocol.chains.entries()) {
    const request = {
      ...numberedClaim(index),
      messagingChainIdentifier: chain.id,
    }
    await store.claimOutgoingApplicationMessage(request)
    await store.completeOutgoingApplicationMessage({
      ...completion,
      claim: request,
    })
  }
  await reopen()
  expect(
    (await store.outgoingApplicationMessages(claim)).map(
      row => row.messagingChainIdentifier,
    ),
  ).toEqual(protocol.chains.map(chain => chain.id))
})
it('accepts exact byte/integer bounds and rejects inherited facts', async () => {
  const request = {
    ...claim,
    accountId: 'é'.repeat(256),
    intentHex: 'aa'.repeat(4096),
    stampValueWei: ((1n << 256n) - 1n).toString(),
  }
  await store.claimOutgoingApplicationMessage(request)
  const signed = await store.completeOutgoingApplicationMessage({
    ...completion,
    claim: request,
    signedPayloadHex: 'bb'.repeat(4096),
  })
  expect(signed.phase).toBe('signed')
  expect(() => outgoingApplicationClaim(Object.create(claim))).toThrow(
    'missing',
  )
})

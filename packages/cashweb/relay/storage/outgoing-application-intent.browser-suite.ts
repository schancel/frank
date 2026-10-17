import { LevelMessageStore } from './level-storage'
import {
  applicationClaim as claim,
  applicationCompletion as completion,
  numberedClaim,
} from './outgoing-application-intent.testutil'
import {
  messageMetadataBackend,
  type MessageMetadataBackend,
} from './message-store-backend'

let store: LevelMessageStore
const location = '/owned-outgoing-application-intents'
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}
const equal = (a: unknown, b: unknown) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    `Mismatch: ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
  )
async function rejects(operation: Promise<unknown>, part: string) {
  try {
    await operation
  } catch (error) {
    check(String(error).includes(part), String(error))
    return
  }
  throw new Error(`Expected ${part} rejection`)
}
async function open(path = location) {
  store = new LevelMessageStore(path)
  await store.Open()
}
export async function run(phase: string): Promise<unknown> {
  if (phase === 'stage') {
    await open()
    equal(await store.outgoingApplicationMessage(claim), undefined)
    equal(await store.outgoingApplicationMessages(claim), [])
    equal(await store.metadataDb.iterator().next(), undefined)
    await rejects(
      store.completeOutgoingApplicationMessage(completion),
      'missing',
    )
    equal(await store.metadataDb.iterator().next(), undefined)
    await store.claimOutgoingApplicationMessage(claim)
    equal(await store.metadataDb.get('schemaVersion'), '3')
    // Leave live handle behind: harness kills the browser before completion.
    return { claimedBeforeProcessKill: true, readOnlyMissing: true }
  }
  if (phase === 'reopen') {
    await open()
    equal((await store.outgoingApplicationMessage(claim))?.phase, 'claimed')
    const signed = await store.completeOutgoingApplicationMessage(completion)
    equal(await store.claimOutgoingApplicationMessage(claim), signed)
    await store.deleteMessage('history')
    await store.suppressAndDelete(
      'recipient',
      [],
      [{ payloadDigest: 'history' }],
    )
    await store.clear()
    await store.Close()
    await open()
    equal(await store.outgoingApplicationMessage(claim), signed)
    return {
      signedPayloadHex: signed.phase === 'signed' && signed.signedPayloadHex,
      messageId: signed.phase === 'signed' && signed.messageId,
      retainedAfterClear: true,
    }
  }
  if (phase === 'signed-reopen') {
    await open()
    equal(await store.outgoingApplicationMessage(claim), {
      ...claim,
      phase: 'signed',
      signedPayloadHex: completion.signedPayloadHex,
      messageId: completion.messageId,
    })
    await store.Close()
    return { signedBytesAndIdentityAfterProcessKill: true }
  }
  if (phase === 'seed-capacity') {
    await open('/owned-intent-capacity')
    for (let i = 0; i < 127; i++)
      await store.claimOutgoingApplicationMessage(numberedClaim(i))
    await store.Close()
    return { seeded: 127 }
  }
  if (phase === 'prepare-race' || phase === 'prepare-capacity') {
    await open(
      phase === 'prepare-race'
        ? '/owned-intent-race'
        : '/owned-intent-capacity',
    )
    return { ready: true }
  }
  if (
    phase === 'race-accept' ||
    phase === 'race-decline' ||
    phase === 'capacity-a' ||
    phase === 'capacity-b'
  ) {
    const request =
      phase === 'race-accept'
        ? claim
        : phase === 'race-decline'
        ? { ...claim, intentHex: '6465636c696e65' }
        : numberedClaim(phase === 'capacity-a' ? 127 : 128)
    try {
      const result = await store.claimOutgoingApplicationMessage(request)
      return { won: true, result }
    } catch (error) {
      check(/conflict|capacity/.test(String(error)), String(error))
      return { won: false }
    }
  }
  if (phase === 'replay' || phase === 'complete-a' || phase === 'complete-b') {
    const winner = (await store.outgoingApplicationMessage(claim))!
    const facts = { ...claim, intentHex: winner.intentHex }
    try {
      const result =
        phase === 'replay'
          ? await store.claimOutgoingApplicationMessage(facts)
          : await store.completeOutgoingApplicationMessage({
              ...completion,
              claim: facts,
              signedPayloadHex:
                phase === 'complete-a' ? completion.signedPayloadHex : '00',
            })
      return { won: true, recordPhase: result.phase }
    } catch (error) {
      check(String(error).includes('conflict'), String(error))
      return { won: false }
    }
  }
  if (phase === 'check-race') {
    const rows = await store.outgoingApplicationMessages(claim)
    equal(rows.length, 1)
    const winner = rows[0]!
    const { phase: _phase, ...facts } = winner
    equal(await store.claimOutgoingApplicationMessage(facts), winner)
    return { retainedWinner: winner.intentHex }
  }
  if (phase === 'check-capacity') {
    equal((await store.outgoingApplicationMessages(claim)).length, 128)
    const rows = await store.outgoingApplicationMessages(claim),
      winner = rows.find(
        row =>
          row.intentKey === numberedClaim(127).intentKey ||
          row.intentKey === numberedClaim(128).intentKey,
      )!
    const { phase: _phase, ...facts } = winner
    await store.completeOutgoingApplicationMessage({
      ...completion,
      claim: facts,
    })
    equal((await store.outgoingApplicationMessages(claim)).length, 128)
    return { count: 128, completionWhenFull: true }
  }
  if (phase === 'regressions') {
    await open('/owned-intent-ack')
    await store.claimOutgoingApplicationMessage(claim)
    const backend = Reflect.get(
      store,
      'metadataBackend',
    ) as MessageMetadataBackend
    const original = backend.outgoingApplicationIntent.bind(backend)
    backend.outgoingApplicationIntent = async (...args) => {
      await original(...args)
      throw new Error('lost ack')
    }
    await rejects(
      store.completeOutgoingApplicationMessage(completion),
      'write-uncertain',
    )
    await rejects(
      store.claimOutgoingApplicationMessage(numberedClaim(1)),
      'unavailable',
    )
    await store.Close()
    await open('/owned-intent-ack')
    equal(await store.outgoingApplicationMessage(claim), {
      ...claim,
      phase: 'signed',
      signedPayloadHex: completion.signedPayloadHex,
      messageId: completion.messageId,
    })
    for (const altered of [
      { accountId: 'other' },
      { signerKeyId: 'ef'.repeat(32) },
      { messagingChainIdentifier: 'solana-devnet' },
      { conversationId: completion.messageId },
      { intentHex: '00' },
      { stampValueWei: '1' },
    ])
      await rejects(
        store.claimOutgoingApplicationMessage({ ...claim, ...altered }),
        'conflict',
      )
    await rejects(
      store.outgoingApplicationMessage({ ...claim, accountId: 'other' }),
      'account conflict',
    )
    await rejects(
      store.completeOutgoingApplicationMessage({
        ...completion,
        signedPayloadHex: '00',
      }),
      'conflict',
    )
    await rejects(
      store.completeOutgoingApplicationMessage({
        ...completion,
        messageId: claim.conversationId,
      }),
      'conflict',
    )
    const signed = await store.claimOutgoingApplicationMessage(claim)
    check(Object.isFrozen(signed), 'Record was not frozen')
    const closeBackend = Reflect.get(
      store,
      'metadataBackend',
    ) as MessageMetadataBackend
    const closeOriginal =
      closeBackend.outgoingApplicationIntent.bind(closeBackend)
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    closeBackend.outgoingApplicationIntent = async (...args) => {
      await gate
      return closeOriginal(...args)
    }
    const accepted = store.claimOutgoingApplicationMessage(numberedClaim(10))
    const completed = store.completeOutgoingApplicationMessage({
      ...completion,
      claim: numberedClaim(10),
    })
    const closing = store.Close()
    await rejects(
      store.claimOutgoingApplicationMessage(numberedClaim(11)),
      'unavailable',
    )
    release()
    await Promise.all([accepted, completed, closing])
    await open('/owned-intent-ack')
    equal(
      (await store.outgoingApplicationMessage(numberedClaim(10)))?.phase,
      'signed',
    )
    // Invalid stored rows are visible on list and reopen; no reset is attempted.
    await store.metadataDb.put(
      'outgoingApplicationIntent:' + numberedClaim(1).intentKey,
      '{}',
    )
    await rejects(
      store.outgoingApplicationMessages({ accountId: 'other' }),
      'Invalid',
    )
    await store.Close()
    store = new LevelMessageStore('/owned-intent-ack')
    await rejects(store.Open(), 'unavailable')
    await store.Close()
    await open('/owned-intent-schema1')
    await store.claimOutgoingApplicationMessage(claim)
    await store.metadataDb.put('schemaVersion', '1')
    await store.Close()
    store = new LevelMessageStore('/owned-intent-schema1')
    await rejects(store.Open(), 'unsupported-schema')
    await store.Close()
    const raw = messageMetadataBackend(
      '/owned-intent-schema1/metadata',
      error => {
        if (error) throw error
      },
    )
    await raw.db.open()
    equal(await raw.db.get('schemaVersion'), '1')
    check(
      (
        await raw.db.get('outgoingApplicationIntent:' + claim.intentKey)
      ).includes(claim.intentHex),
      'Old schema was deleted',
    )
    await raw.db.close()
    return {
      closeDrainedAcceptedCompletion: true,
      oldSchemaRetainedUnchanged: true,
      lostAcknowledgmentReopen: true,
      alteredContextRejected: true,
      corruptRowObservable: true,
    }
  }
  if (phase === 'close') {
    await store.Close()
    return { closed: true }
  }
  throw new Error(`Unknown phase ${phase}`)
}

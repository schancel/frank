import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalDirectMessages,
  LevelOutgoingMessageStore,
  type CanonicalMessagingOwner,
} from './canonical-dm'

it('reads durable paid and host-bound free delivery after reopening without any effect capability', async () => {
  const location = await mkdtemp(join(tmpdir(), 'frank-dm-delivery-'))
  let store = await LevelOutgoingMessageStore.open(location)
  try {
    const states = [undefined, 'delivered', 'dead', 'delivered'] as const
    for (let index = 0; index < states.length; index++) {
      await store.put({
        version: 1,
        consumerId: `frank-dm:${index}`,
        digest: String(index + 1).repeat(64),
        recipientSubject: '02' + 'ab'.repeat(32),
        payments: [],
        createdAt: 1,
        ...(states[index] ? { outcome: states[index] } : {}),
        ...(index === 3 ? { exposurePending: true } : {}),
      })
      await store.setUnpaid(String(index), {
        digest: String(index + 5).repeat(64),
        delivery: '01',
        context: '02',
        recipientSubject: '02' + 'ab'.repeat(32),
        boundary: 'fixed',
        hostBound: true,
        ...(states[index] ? { outcome: states[index] } : {}),
        ...(index === 3 ? { exposurePending: true } : {}),
      })
    }
    await store.setUnpaid('unbound', {
      digest: '9'.repeat(64),
      delivery: '01',
      context: '02',
      recipientSubject: '02' + 'ab'.repeat(32),
      boundary: 'fixed',
    })
    await store.close()
    store = await LevelOutgoingMessageStore.open(location)
    const before = JSON.stringify(store.all())
    const put = jest.spyOn(store, 'put').mockImplementation(async () => {
      throw new Error('must not write')
    })
    const setUnpaid = jest
      .spyOn(store, 'setUnpaid')
      .mockImplementation(async () => {
        throw new Error('must not write')
      })
    // Any access to directory, signing, payer/RPC, lifecycle effects or defaults is a failure.
    const owner = new Proxy(
      { messages: store },
      {
        get(target, property) {
          if (property === 'messages') return target.messages
          throw new Error(`Unexpected effect capability: ${String(property)}`)
        },
      }
    ) as CanonicalMessagingOwner
    const client = canonicalDirectMessages(owner, async () => {
      throw new Error('must not resolve default')
    })
    const expected = ['live', 'delivered', 'dead', 'live']
    for (let index = 0; index < states.length; index++) {
      expect(
        await client.deliveryOf({
          wallet: {} as never,
          payloadDigest: String(index + 1).repeat(64),
        })
      ).toBe(expected[index])
      expect(
        await client.deliveryOf({
          wallet: {} as never,
          payloadDigest: String(index + 5).repeat(64),
        })
      ).toBe(expected[index])
    }
    expect(
      await client.deliveryOf({
        wallet: {} as never,
        payloadDigest: '9'.repeat(64),
      })
    ).toBeUndefined()
    expect(
      await client.deliveryOf({
        wallet: {} as never,
        payloadDigest: 'a'.repeat(64),
      })
    ).toBeUndefined()
    await expect(
      client.deliveryOf({
        wallet: {} as never,
        payloadDigest: '0x' + 'a'.repeat(64),
      })
    ).rejects.toThrow('canonical message payload digest')
    expect(put).not.toHaveBeenCalled()
    expect(setUnpaid).not.toHaveBeenCalled()
    expect(JSON.stringify(store.all())).toBe(before)
  } finally {
    await store.close()
    await rm(location, { recursive: true, force: true })
  }
})

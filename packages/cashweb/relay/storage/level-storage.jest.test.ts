import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { MessageWrapper } from '../../types/messages'
import {
  deserializeMessageWrapper,
  LevelMessageStore,
  serializeMessageWrapper,
} from './level-storage'

const LARGE_WEI = 123_456_789_012_345_678_901n

function wrapper(index = 'payload-digest'): MessageWrapper {
  return {
    index,
    outbound: true,
    senderAddress: 'sender',
    copartyAddress: 'recipient',
    message: {
      outbound: true,
      status: 'confirmed',
      receivedTime: 123,
      serverTime: 456,
      items: [{ type: 'text', text: 'hello' }],
      outpoints: [],
      senderAddress: 'sender',
      stampValueWei: LARGE_WEI,
      stampPayments: [
        {
          txHash: '0xabc',
          destinationAddress: '0xdef',
          valueWei: LARGE_WEI - 1n,
        },
      ],
    },
  }
}

describe('LevelMessageStore schema v2', () => {
  it('round-trips financial integers beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const encoded = serializeMessageWrapper(wrapper())

    expect(encoded).toContain(`\"stampValueWei\":\"${LARGE_WEI}\"`)
    expect(deserializeMessageWrapper(encoded)).toEqual(wrapper())
  })

  it('rejects unsafe legacy JSON numbers instead of silently changing their value', () => {
    const sample = wrapper()
    const encoded = JSON.stringify({
      ...sample,
      message: {
        ...sample.message,
        stampValueWei: Number.MAX_SAFE_INTEGER + 1,
        stampPayments: undefined,
      },
    })

    expect(() => deserializeMessageWrapper(encoded)).toThrow(
      'Stored wei value is not a safe non-negative integer',
    )
  })

  it('commits a message and its resume cursor together and keeps deletion durable', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-message-store-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(wrapper(), { advanceCursor: false })

      expect(await store.getMessage('payload-digest')).toEqual(wrapper())
      expect(await store.mostRecentMessageTime()).toBe(0)

      const inbound = wrapper('inbound-digest')
      inbound.outbound = false
      inbound.message.outbound = false
      await store.saveMessage(inbound)
      expect(await store.mostRecentMessageTime()).toBe(456)

      const persisted: MessageWrapper[] = []
      for await (const message of await store.getIterator()) {
        persisted.push(message)
      }
      expect(persisted).toEqual([inbound, wrapper()])

      await store.deleteMessage('payload-digest')
      expect(await store.getMessage('payload-digest')).toBeUndefined()
      expect(await store.mostRecentMessageTime()).toBe(456)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })
})

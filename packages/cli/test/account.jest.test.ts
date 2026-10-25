import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { sendOrResume } from '../src/account'

const TO = '0x' + '12'.repeat(20)
const ITEMS = [{ type: 'text' as const, text: 'hello' }]
const DIGEST = 'ab'.repeat(32)

describe('sendOrResume: a message is never sent twice for one request', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-account-'))
    file = join(dir, 'unconfirmed-sends.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const request = (over: Partial<Parameters<typeof sendOrResume>[0]>) =>
    sendOrResume({
      file,
      to: TO,
      items: ITEMS,
      stampValueWei: 5n,
      send: async () => {
        throw new Error('send not expected')
      },
      status: async () => {
        throw new Error('status not expected')
      },
      waitMs: 0,
      pollMs: 0,
      ...over,
    })

  /** A run whose message reached the relay and whose answer was lost, and never confirmed. */
  const interruptedRun = () =>
    request({
      send: async (_id, created) => {
        created(DIGEST)
        throw new Error('connection reset')
      },
      status: async () => 'live',
    })

  it('a delivered send leaves no record', async () => {
    const digest = await request({
      send: async (_id, created) => {
        created(DIGEST)
        return DIGEST
      },
    })
    expect(digest).toBe(DIGEST)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('a failed send keeps only its message ID, and the next run sends under that same ID', async () => {
    const ids: string[] = []
    await expect(
      request({
        send: async id => {
          ids.push(id)
          throw new Error('insufficient funds')
        },
      }),
    ).rejects.toThrow('insufficient funds')
    await expect(
      request({
        send: async id => {
          ids.push(id)
          return DIGEST
        },
      }),
    ).resolves.toBe(DIGEST)
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(ids).toEqual([ids[0], ids[0]])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  // A free message names no payment attempt: when the relay's answer is lost the run learns no
  // digest. Running it again sends under the same ID, which the wallet answers with the sealed
  // bytes it kept: one message at the relay, not two.
  it('a free send whose answer was lost is repeated under the same ID, never as a second message', async () => {
    const ids: string[] = []
    await expect(
      request({
        stampValueWei: 0n,
        send: async id => {
          ids.push(id)
          throw new Error('relay answer lost')
        },
      }),
    ).rejects.toThrow('relay answer lost')
    await expect(
      request({
        stampValueWei: 0n,
        send: async id => {
          ids.push(id)
          return DIGEST
        },
      }),
    ).resolves.toBe(DIGEST)
    expect(new Set(ids).size).toBe(1)
  })

  it('a repeat the wallet answers with the paid message it holds follows that message', async () => {
    const ids: string[] = []
    await expect(
      request({
        send: async id => {
          ids.push(id)
          throw new Error('relay answer lost')
        },
      }),
    ).rejects.toThrow()
    const asked: string[] = []
    await expect(
      request({
        send: async id => {
          ids.push(id)
          throw Object.assign(new Error('already attempted'), { payloadDigest: DIGEST })
        },
        status: async d => {
          asked.push(d)
          return 'delivered'
        },
      }),
    ).resolves.toBe(DIGEST)
    expect(new Set(ids).size).toBe(1)
    expect(asked).toEqual([DIGEST])
  })

  it('a record written by the earlier CLI is refused with its reset', async () => {
    require('fs').writeFileSync(file, JSON.stringify({ old: DIGEST }))
    await expect(request({})).rejects.toThrow(/Development reset: delete it/)
  })

  it('running the same request again resumes the unconfirmed message and sends nothing', async () => {
    await expect(interruptedRun()).rejects.toThrow(
      /Run the same command again to follow this message/,
    )
    const send = jest.fn(async () => 'cd'.repeat(32))
    const asked: string[] = []
    const digest = await request({
      send,
      status: async d => {
        asked.push(d)
        return 'delivered'
      },
    })
    expect(digest).toBe(DIGEST)
    expect(send).not.toHaveBeenCalled()
    expect(asked).toEqual([DIGEST])
    // Delivered: the next identical request is a new message.
    await request({ send })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a different request is sent while another is unconfirmed, and both are kept apart', async () => {
    await expect(interruptedRun()).rejects.toThrow()
    const other = 'ef'.repeat(32)
    await expect(
      request({
        items: [{ type: 'text', text: 'another' }],
        send: async (_id, created) => {
          created(other)
          return other
        },
      }),
    ).resolves.toBe(other)
    expect(
      Object.values(JSON.parse(readFileSync(file, 'utf8'))).map(
        entry => (entry as { digest?: string }).digest,
      ),
    ).toEqual([DIGEST])
  })

  it('a dead message is forgotten, so the next run can send anew', async () => {
    await expect(interruptedRun()).rejects.toThrow()
    await expect(request({ status: async () => 'dead' })).rejects.toThrow(
      'will never deliver',
    )
    const send = jest.fn(async () => 'cd'.repeat(32))
    await request({ send })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

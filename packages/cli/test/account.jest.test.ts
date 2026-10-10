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
      send: async created => {
        created(DIGEST)
        throw new Error('connection reset')
      },
      status: async () => 'live',
    })

  it('a delivered send leaves no record', async () => {
    const digest = await request({
      send: async created => {
        created(DIGEST)
        return DIGEST
      },
    })
    expect(digest).toBe(DIGEST)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('a send that never reached the relay fails as it is and leaves no record', async () => {
    await expect(
      request({
        send: async () => {
          throw new Error('insufficient funds')
        },
      }),
    ).rejects.toThrow('insufficient funds')
    await expect(
      request({ send: async () => DIGEST }),
    ).resolves.toBe(DIGEST)
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
        send: async created => {
          created(other)
          return other
        },
      }),
    ).resolves.toBe(other)
    expect(Object.values(JSON.parse(readFileSync(file, 'utf8')))).toEqual([DIGEST])
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

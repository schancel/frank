import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { DirectMessageReceived } from '@frank/wallet/chain/active-chain'

import * as accountModule from '../src/account'
import { inboxCommand, listenCommand } from '../src/commands/inbox'

function received(digest: string, receivedTime: number, text: string): DirectMessageReceived {
  return {
    senderAddress: { raw: '0x1111111111111111111111111111111111111111' },
    recipientAddress: { raw: '0x2222222222222222222222222222222222222222' },
    items: [{ type: 'text', text }],
    payloadDigest: digest,
    stampValueWei: 0n,
    stampPayments: [],
    receivedTime,
  } as DirectMessageReceived
}

/** The messaging account is replaced at its one seam; reading from a real relay is exercised by
 * the real-stack run, not here. */
function stubAccount(messages: DirectMessageReceived[]) {
  const account: accountModule.CliAccount = {
    address: '0x2222222222222222222222222222222222222222',
    mainAccount: '0x3333333333333333333333333333333333333333',
    send: jest.fn(async () => ''),
    receivedSince: jest.fn(async (sinceMs: number) => messages.filter(m => m.receivedTime >= sinceMs)),
    close: jest.fn(async () => {}),
  }
  jest.spyOn(accountModule, 'openCliAccount').mockResolvedValue(account)
  return account
}

describe('inbox', () => {
  let dataDir: string
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    dataDir = join(tmpdir(), `frank-cli-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(dataDir, 'account'), { recursive: true })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = 0
    rmSync(dataDir, { recursive: true, force: true })
  })

  const printed = () => JSON.parse(logSpy.mock.calls.map(call => call[0]).join('\n'))

  it('lists what the account received, oldest first, and honours --limit', async () => {
    const account = stubAccount([received('aa', 1000, 'first'), received('bb', 2000, 'second')])
    await inboxCommand({ dataDir, json: true })
    expect(printed().map((m: { text: string }) => m.text)).toEqual(['first', 'second'])
    expect(account.close).toHaveBeenCalledTimes(1)
    logSpy.mockClear()
    await inboxCommand({ dataDir, json: true, limit: '1' })
    expect(printed().map((m: { payloadDigest: string }) => m.payloadDigest)).toEqual(['bb'])
  })

  it('--unread returns each message once: the next run starts after the newest one seen', async () => {
    const messages = [received('aa', 1000, 'first')]
    const account = stubAccount(messages)
    await inboxCommand({ dataDir, json: true, unread: true })
    expect(printed()).toHaveLength(1)
    logSpy.mockClear()
    messages.push(received('bb', 2000, 'second'))
    await inboxCommand({ dataDir, json: true, unread: true })
    expect(printed().map((m: { text: string }) => m.text)).toEqual(['second'])
    expect(account.receivedSince).toHaveBeenLastCalledWith(1001)
  })

  it('listen prints what arrived in the last minute and closes the account when not following', async () => {
    const now = Date.now()
    const account = stubAccount([received('old', now - 3_600_000, 'stale'), received('new', now - 1000, 'fresh')])
    await listenCommand({ dataDir, json: true })
    const lines = logSpy.mock.calls.map(call => JSON.parse(call[0]))
    expect(lines.map((m: { text: string }) => m.text)).toEqual(['fresh'])
    expect(account.close).toHaveBeenCalledTimes(1)
  })
})

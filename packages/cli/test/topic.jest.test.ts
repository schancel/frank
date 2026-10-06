import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'

import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import * as monadIdentityModule from '@frank/wallet/monad-identity'
import * as monadTopicPostClientModule from '@frank/wallet/monad-topic-post-client'
import * as monadTopicTallyClientModule from '@frank/wallet/monad-topic-tally-client'

import { topicPostCommand, topicReadCommand } from '../src/commands/topic'
import { saveIdentity } from '../src/config'

describe('Topic Commands', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let identity: monadIdentityModule.MonadIdentity
  let mnemonic: string

  beforeEach(async () => {
    testDataDir = join(
      tmpdir(),
      `signet-topic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(testDataDir, { recursive: true })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    mnemonic = bip39.generateMnemonic()
    identity = monadIdentityModule.MonadIdentity.fromSeed({ mnemonic })

    await saveIdentity(testDataDir, {
      identity,
      mnemonic,
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    jest.restoreAllMocks()
    try {
      rmSync(testDataDir, { recursive: true, force: true })
    } catch {}
  })

  it('broadcasts topic post and outputs human-readable summary', async () => {
    jest
      .spyOn(monadTopicPostClientModule, 'quoteMonadTopicBurnGasReserve')
      .mockResolvedValue(50000n)
    jest
      .spyOn(MonadSubAccountPool.prototype, 'prepareBurnAccount')
      .mockResolvedValue({ index: 0 } as any)
    jest
      .spyOn(
        monadTopicPostClientModule.MonadTopicPostClient.prototype,
        'submitTopicPost',
      )
      .mockResolvedValue({
        payloadHashHex: '0xposthash123',
        txHash: '0xburntx123',
      } as any)

    await topicPostCommand('general', 'Hello world topic!', {
      dataDir: testDataDir,
      burn: '0.02 MON',
    })

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Topic broadcast submitted successfully:'),
    )
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('0xposthash123'),
    )
  })

  it('outputs JSON result when --json flag is provided for topic post', async () => {
    jest
      .spyOn(monadTopicPostClientModule, 'quoteMonadTopicBurnGasReserve')
      .mockResolvedValue(50000n)
    jest
      .spyOn(MonadSubAccountPool.prototype, 'prepareBurnAccount')
      .mockResolvedValue({ index: 1 } as any)
    jest
      .spyOn(
        monadTopicPostClientModule.MonadTopicPostClient.prototype,
        'submitTopicPost',
      )
      .mockResolvedValue({
        payloadHashHex: '0xposthash456',
        txHash: '0xburntx456',
      } as any)

    await topicPostCommand('news', 'Latest news announcement', {
      dataDir: testDataDir,
      json: true,
    })

    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.topic).toBe('news')
    expect(parsed.payloadHashHex).toBe('0xposthash456')
    expect(parsed.burnTxHash).toBe('0xburntx456')
    expect(parsed.author).toBe(identity.displayAddress)
    expect(parsed.status).toBe('delivered')
  })

  it('reads topic feed when empty', async () => {
    jest
      .spyOn(monadTopicTallyClientModule, 'fetchMonadTopicPostsSince')
      .mockResolvedValue([])

    await topicReadCommand('empty-topic', { dataDir: testDataDir })

    expect(logSpy).toHaveBeenCalledWith(
      'No posts found for topic "empty-topic".',
    )
  })

  it('reads topic feed with posts', async () => {
    const mockPost: any = {
      timestamp: new Date(1700000000000),
      poster: '0x1111111111111111111111111111111111111111',
      payloadDigest: '0xdigest999',
      voteWeightWei: '10000000000000000',
      entries: [{ kind: 'post', message: 'First post content!' }],
    }

    jest
      .spyOn(monadTopicTallyClientModule, 'fetchMonadTopicPostsSince')
      .mockResolvedValue([mockPost])

    await topicReadCommand('general', { dataDir: testDataDir, json: true })

    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].poster).toBe('0x1111111111111111111111111111111111111111')
    expect(parsed[0].payloadDigest).toBe('0xdigest999')
  })
})

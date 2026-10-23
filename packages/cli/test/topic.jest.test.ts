import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'

import * as monadIdentityModule from '@frank/wallet/evm-identity'
import * as configModule from '../src/config'
import { createEvmChain } from '@frank/wallet/chain/evm-chain'
import { getChainRegistryByNetworkTag } from '@frank/wallet/chain/chains-registry'
import * as topicPostClientModule from '@frank/wallet/topic-post-client'
import * as monadTopicTallyClientModule from '@frank/wallet/evm-topic-tally-client'

jest.mock('@frank/wallet/chain/evm-chain', () => {
  const actual = jest.requireActual('@frank/wallet/chain/evm-chain')
  return {
    ...actual,
    createEvmChain: jest.fn(config => {
      // Keep real registry validation; only custody and RPC effects are replaced.
      actual.createEvmChain(config)
      return { createWallet: jest.fn(async () => ({
        chainIdentifier: config.chainIdentifier ?? config.rpcChain,
        getBalanceParts: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined),
      })) }
    }),
  }
})
import { topicPostCommand, topicReadCommand } from '../src/commands/topic'
import { saveIdentity } from '../src/config'

describe('Topic Commands', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let identity: monadIdentityModule.MonadIdentity
  let mnemonic: string

  beforeEach(async () => {
    jest.mocked(createEvmChain).mockClear()
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
      .spyOn(topicPostClientModule.TopicPostClient.prototype, 'submitTopicPost')
      .mockResolvedValue({
        payloadHashHex: '0xposthash123',
        transactionHashes: ['0xburntx123'],
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
      .spyOn(topicPostClientModule.TopicPostClient.prototype, 'submitTopicPost')
      .mockResolvedValue({
        payloadHashHex: '0xposthash456',
        transactionHashes: ['0xburntx456'],
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

  it.each([
    ['MON1', 143, 'monad-mainnet'],
    ['MONT', 10143, 'monad-testnet'],
    ['MONR', 20143, 'monad-regtest'],
  ] as const)('posts on saved %s using registry policy despite conflicting environment', async (networkTag, chainId, chainIdentifier) => {
    const prior = process.env.MONAD_RPC_CHAIN
    process.env.MONAD_RPC_CHAIN = chainIdentifier === 'monad-mainnet' ? 'monad-regtest' : 'monad-mainnet'
    try {
      configModule.saveConfig(testDataDir, { ...configModule.getDefaultConfig(),
        networkTag, chainId, relayUrl: 'http://localhost:8080', rpcUrl: 'http://127.0.0.1:8545' })
      jest.spyOn(topicPostClientModule.TopicPostClient.prototype, 'submitTopicPost')
        .mockResolvedValue({ payloadHashHex: 'post', transactionHashes: ['burn'] } as any)
      await topicPostCommand('test', 'hello', { dataDir: testDataDir })
      expect(errorSpy).not.toHaveBeenCalled()
      expect(createEvmChain).toHaveBeenCalledTimes(1)
      const selected = jest.mocked(createEvmChain).mock.calls[0][0]
      const registry = getChainRegistryByNetworkTag(networkTag)!
      expect(selected).toMatchObject({
        chainIdentifier, networkId: chainIdentifier, rpcChain: chainIdentifier,
        networkTag, relayBaseUrl: 'http://localhost:8080',
        spendSpacingBlocks: registry.spendSpacingBlocks,
        reserveBalanceWei: BigInt(registry.reserveBalanceWei!),
        paymentPollIntervalMs: registry.paymentPollIntervalMs,
      })
      expect(BigInt(selected.chainId)).toBe(BigInt(chainId))
    } finally {
      if (prior === undefined) delete process.env.MONAD_RPC_CHAIN
      else process.env.MONAD_RPC_CHAIN = prior
    }
  })

  it.each([
    ['MONT', 20143], ['MONR', 10143], ['unknown', 10143], ['XECT', 10143],
  ])('rejects inconsistent or unsupported saved %s/%s before wallet effects', async (networkTag, chainId) => {
    configModule.saveConfig(testDataDir, { ...configModule.getDefaultConfig(),
      networkTag: String(networkTag), chainId: Number(chainId) })
    const loadIdentity = jest.spyOn(configModule, 'loadIdentity')
    const submit = jest.spyOn(topicPostClientModule.TopicPostClient.prototype, 'submitTopicPost')
    await topicPostCommand('test', 'hello', { dataDir: testDataDir })
    expect(errorSpy).toHaveBeenCalled()
    expect(loadIdentity).not.toHaveBeenCalled()
    expect(createEvmChain).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

})

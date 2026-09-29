import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonRpcProvider, Wallet } from 'ethers'

import { MonadTxSubmitter } from '@frank/wallet/monad-account-tx'
import {
  MonadStampedMessageProto,
  MonadStampClient,
  MonadStampPendingAttemptError,
  encodeMonadStampedMessage,
} from '@frank/wallet/monad-stamp-client'
import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import { InMemoryStampAttemptJournal } from '@frank/wallet/storage/stamp-attempt-journal'
import {
  sendDirectMessageItems,
  setUpFundedStampClient,
} from './qwen-bot-common'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>
const axiosCallMock = axios as unknown as jest.Mock

function storedMessageBytes(message: MonadStampedMessageProto): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jspb = require('google-protobuf')
  const writer = new jspb.BinaryWriter()
  writer.writeBytes(1, encodeMonadStampedMessage(message))
  writer.writeInt64(4, 1_700_000_000_000)
  writer.writeBytes(5, new TextEncoder().encode('MONT'))
  return writer.getResultBuffer()
}

describe('persistent funded stamp setup', () => {
  let root: string
  let walletJsonPath: string
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qwen-bot-wallet-test-'))
    walletJsonPath = join(root, 'main-wallet.json')
    const mainWallet = Wallet.createRandom()
    writeFileSync(
      walletJsonPath,
      JSON.stringify({
        address: mainWallet.address,
        privateKey: mainWallet.privateKey,
      }),
      { mode: 0o600 },
    )
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    axiosCallMock.mockReset()
    mockedAxios.isAxiosError.mockImplementation(
      value =>
        typeof value === 'object' &&
        value !== null &&
        'isAxiosError' in value &&
        value.isAxiosError === true,
    )
  })

  afterEach(() => {
    logSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function makeProvider(): JsonRpcProvider {
    return new JsonRpcProvider('http://127.0.0.1:1', 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
  }

  function makeHttpClient(): jest.Mocked<MonadTxSubmitter> {
    return {
      submitRawTransaction: jest.fn(),
      getTransactionReceipt: jest.fn(),
    }
  }

  function openSetup(stateRoot = join(root, 'wallet-state')) {
    return setUpFundedStampClient({
      rpcUrl: 'http://127.0.0.1:1',
      relayBaseUrl: 'https://relay.invalid',
      mainWalletJsonPath: walletJsonPath,
      stateRoot,
      stampValueWei: 10_000n,
      label: 'test',
      provider: makeProvider(),
      httpClient: makeHttpClient(),
    })
  }

  function pendingMessage(): MonadStampedMessageProto {
    return {
      stampPayments: [],
      encryptedPayload: new TextEncoder().encode('retained exact attempt'),
      payloadHash: new Uint8Array(32).fill(0x42),
    }
  }

  it('creates once, reopens the same derived accounts and every Level-backed record', async () => {
    const stateRoot = join(root, 'wallet-state')
    const first = await openSetup(stateRoot)
    first.pool.ensureUnfundedSize(2)
    await first.pool.flush()
    first.changePool.setNextUnusedIndex(4)
    await first.stampPaymentJournal.put({
      payloadHashHex: 'ab'.repeat(32),
      childIndex: 0,
      txHash: `0x${'11'.repeat(32)}`,
      address: Wallet.createRandom().address,
      valueWei: '123',
      status: 'discovered',
    })
    const firstAccounts = first.pool.records().map(record => record.address)
    await first.close()

    expect(statSync(join(stateRoot, 'hd-seed.json')).mode & 0o777).toBe(0o600)

    const reopened = await openSetup(stateRoot)
    expect(reopened.pool.records().map(record => record.address)).toEqual(
      firstAccounts,
    )
    expect(reopened.changePool.nextUnusedIndex()).toBe(4)
    expect(reopened.stampPaymentJournal.getAll()).toHaveLength(1)

    await expect(openSetup(stateRoot)).rejects.toThrow(
      `Wallet state root is already open: ${stateRoot}`,
    )
    await reopened.close()

    const reopenedAgain = await openSetup(stateRoot)
    await reopenedAgain.close()
  })

  it('replays a retained exact attempt before permitting a later send', async () => {
    const first = await openSetup()
    const message = pendingMessage()
    const encoded = encodeMonadStampedMessage(message)
    await first.stampAttemptJournal.put({
      payloadHashHex: '42'.repeat(32),
      messageBytes: Array.from(encoded),
      leaseIndices: [],
    })
    await first.close()

    const events: string[] = []
    axiosCallMock.mockImplementation(async (config: AxiosRequestConfig) => {
      events.push('replay')
      expect(new Uint8Array(config.data as Uint8Array)).toEqual(encoded)
      return {
        data: storedMessageBytes(message),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      } as AxiosResponse
    })

    const reopened = await openSetup()
    events.push('new-send-allowed')
    expect(events).toEqual(['replay', 'new-send-allowed'])
    expect(reopened.stampAttemptJournal.getAll()).toEqual([])
    await reopened.close()
  })

  it('blocks new work when startup replay remains retained and releases every store', async () => {
    const first = await openSetup()
    const message = pendingMessage()
    await first.stampAttemptJournal.put({
      payloadHashHex: '42'.repeat(32),
      messageBytes: Array.from(encodeMonadStampedMessage(message)),
      leaseIndices: [],
    })
    await first.close()

    axiosCallMock.mockRejectedValue(
      Object.assign(new Error('relay retained the exact set'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: { exact_set_retained: true },
        },
      }),
    )
    await expect(openSetup()).rejects.toBeInstanceOf(
      MonadStampPendingAttemptError,
    )
    expect(axiosCallMock).toHaveBeenCalledTimes(1)

    // The failed setup closed all four databases; a later process can retry the same state root.
    axiosCallMock.mockImplementation(
      async (config: AxiosRequestConfig) =>
        ({
          data: storedMessageBytes(message),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        }) as AxiosResponse,
    )
    const recovered = await openSetup()
    expect(recovered.stampAttemptJournal.getAll()).toEqual([])
    await recovered.close()
  })

  it('checks retained attempts before preparing or funding inventory', async () => {
    const journal = new InMemoryStampAttemptJournal()
    await journal.put({
      payloadHashHex: '42'.repeat(32),
      messageBytes: Array.from(encodeMonadStampedMessage(pendingMessage())),
      leaseIndices: [],
    })
    const resumePendingAttempts = jest.fn().mockResolvedValue([])
    const prepareStampInventory = jest.fn()

    await expect(
      sendDirectMessageItems({
        stampClient: { resumePendingAttempts } as unknown as MonadStampClient,
        stampAttemptJournal: journal,
        pool: { prepareStampInventory } as unknown as MonadSubAccountPool,
        mainAccountSigner: {} as never,
        provider: {} as never,
        fromIdentity: {} as never,
        toAddress: Wallet.createRandom().address,
        toPubKey: Buffer.alloc(33),
        items: [{ type: 'text', text: 'must not send' }],
        stampValueWei: 10_000n,
        networkTag: 'MONT',
      }),
    ).rejects.toBeInstanceOf(MonadStampPendingAttemptError)
    expect(resumePendingAttempts).toHaveBeenCalledTimes(1)
    expect(prepareStampInventory).not.toHaveBeenCalled()
  })
})

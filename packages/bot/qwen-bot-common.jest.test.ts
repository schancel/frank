import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider, Wallet } from 'ethers'

import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import { MonadTxSubmitter } from '@frank/wallet/monad-account-tx'
import { MonadStampClient } from '@frank/wallet/monad-stamp-client'

import {
  sendDirectMessageItems,
  setUpFundedStampClient,
} from './qwen-bot-common'

describe('Qwen durable stamp-wallet lifecycle', () => {
  let root: string
  let walletJsonPath: string
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qwen-wallet-lifecycle-'))
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
  })

  afterEach(() => {
    logSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function provider(): JsonRpcProvider {
    return new JsonRpcProvider('http://127.0.0.1:1', 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
  }

  function submitter(): jest.Mocked<MonadTxSubmitter> {
    return {
      submitRawTransaction: jest.fn(),
      getTransactionReceipt: jest.fn(),
    }
  }

  function open(stateRoot: string) {
    return setUpFundedStampClient({
      rpcUrl: 'http://127.0.0.1:1',
      relayBaseUrl: 'https://relay.invalid',
      mainWalletJsonPath: walletJsonPath,
      stateRoot,
      stampValueWei: 10_000n,
      label: 'test',
      provider: provider(),
      httpClient: submitter(),
    })
  }

  it('reopens the same HD accounts and excludes a concurrent process', async () => {
    const stateRoot = join(root, 'wallet-state')
    const first = await open(stateRoot)
    first.pool.ensureUnfundedSize(2)
    await first.pool.flush()
    const addresses = first.pool.records().map(record => record.address)
    await first.close()

    const reopened = await open(stateRoot)
    expect(reopened.pool.records().map(record => record.address)).toEqual(
      addresses,
    )
    await expect(open(stateRoot)).rejects.toThrow(/already open|lease/i)
    await reopened.close()

    const afterRelease = await open(stateRoot)
    await afterRelease.close()
  })

  it('reconciles durable authority before quoting, funding, or signing a message', async () => {
    const reconciliationFailure = new Error('retained authority needs audit')
    const reconcileOrThrow = jest.fn().mockRejectedValue(reconciliationFailure)
    const prepareStampInventory = jest.fn()

    await expect(
      sendDirectMessageItems({
        stampClient: { reconcileOrThrow } as unknown as MonadStampClient,
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
    ).rejects.toBe(reconciliationFailure)

    expect(reconcileOrThrow).toHaveBeenCalledTimes(1)
    expect(prepareStampInventory).not.toHaveBeenCalled()
  })
})

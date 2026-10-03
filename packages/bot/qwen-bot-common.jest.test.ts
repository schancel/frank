import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider, Wallet } from 'ethers'

import { MonadTxSubmitter } from '@frank/wallet/monad-account-tx'
import { setUpDurableFundedStampClient } from './qwen-bot-common'

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
    return setUpDurableFundedStampClient({
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

  it('reopens the same HD accounts and releases every store on close', async () => {
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
    await reopened.close()
    await reopened.close()

    const afterRelease = await open(stateRoot)
    await afterRelease.close()
  })
})

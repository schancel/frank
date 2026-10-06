import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'
import { JsonRpcProvider } from 'ethers'

import * as monadStampClientModule from '@frank/wallet/monad-stamp-client'
import * as monadIdentityModule from '@frank/wallet/monad-identity'
import { LevelStampPaymentJournal } from '@frank/wallet/storage/stamp-payment-journal'

import { balanceCommand, sweepCommand } from '../src/commands/balance'
import { saveIdentity } from '../src/config'

describe('Balance and Sweep Commands', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let identity: monadIdentityModule.MonadIdentity
  let mnemonic: string

  beforeEach(async () => {
    testDataDir = join(
      tmpdir(),
      `signet-balance-test-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
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

  it('outputs balance in human-readable and JSON format', async () => {
    jest
      .spyOn(JsonRpcProvider.prototype, 'getBalance')
      .mockResolvedValue(5000000000000000000n)

    await balanceCommand({ dataDir: testDataDir })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Wallet Balance for ${identity.displayAddress}:`),
    )
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`5.0 MON`))

    await balanceCommand({ dataDir: testDataDir, json: true })
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.address).toBe(identity.displayAddress)
    expect(parsed.eoaBalanceWei).toBe('5000000000000000000')
    expect(parsed.uncollectedStampPayments.count).toBe(0)
  })

  it('reports uncollected stamp payments in balance output', async () => {
    jest
      .spyOn(JsonRpcProvider.prototype, 'getBalance')
      .mockResolvedValue(1000000000000000000n)

    const walletDir = join(testDataDir, 'wallets', identity.displayAddress)
    const journal = new LevelStampPaymentJournal(walletDir)
    await journal.Open()
    await journal.put({
      payloadHashHex: '11'.repeat(32),
      childIndex: 0,
      address: '0x1111111111111111111111111111111111111111',
      valueWei: '10000000000000000',
      status: 'pending',
      txHash: '0xpayment1',
      recordedAtMs: Date.now(),
    })
    await journal.Close()

    await balanceCommand({ dataDir: testDataDir, json: true })
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.uncollectedStampPayments.count).toBe(1)
    expect(parsed.uncollectedStampPayments.totalValueWei).toBe(
      '10000000000000000',
    )
  })

  it('sweeps uncollected stamp payments to destination', async () => {
    const walletDir = join(testDataDir, 'wallets', identity.displayAddress)
    const journal = new LevelStampPaymentJournal(walletDir)
    await journal.Open()
    await journal.put({
      payloadHashHex: '22'.repeat(32),
      childIndex: 0,
      address: '0x2222222222222222222222222222222222222222',
      valueWei: '20000000000000000',
      status: 'confirmed',
      txHash: '0xpayment2',
      recordedAtMs: Date.now(),
    })
    await journal.Close()

    jest
      .spyOn(monadStampClientModule, 'sweepRecoveredMonadStampPayment')
      .mockResolvedValue({
        swept: true,
        txHash: '0xsweepTxHash123',
        valueWei: 19900000000000000n,
      } as any)

    const customDest = '0x9999999999999999999999999999999999999999'
    await sweepCommand({
      dataDir: testDataDir,
      destination: customDest,
      json: true,
    })

    expect(logSpy).toHaveBeenCalled()
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.destination).toBe(customDest)
    expect(parsed.sweptCount).toBe(1)
    expect(parsed.totalSweptWei).toBe('19900000000000000')
    expect(parsed.sweeps[0].txHash).toBe('0xsweepTxHash123')

    // Verify journal updated to swept
    const checkJournal = new LevelStampPaymentJournal(walletDir)
    await checkJournal.Open()
    const updated = checkJournal.getAll()
    expect(updated[0].status).toBe('swept')
    await checkJournal.Close()
  })

  it('handles sweep when no payments exist', async () => {
    await sweepCommand({
      dataDir: testDataDir,
      json: true,
    })

    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.sweptCount).toBe(0)
    expect(parsed.totalSweptWei).toBe('0')
  })
})

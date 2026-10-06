import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'

import * as monadIdentityModule from '@frank/wallet/monad-identity'
import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import * as monadStampClientModule from '@frank/wallet/monad-stamp-client'

import { sendCommand } from '../src/commands/send'
import { saveIdentity } from '../src/config'

describe('Send Command', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let mockIdentity: monadIdentityModule.MonadIdentity

  beforeEach(async () => {
    testDataDir = join(
      tmpdir(),
      `signet-send-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(testDataDir, { recursive: true })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    const mnemonic = bip39.generateMnemonic()
    mockIdentity = monadIdentityModule.MonadIdentity.fromSeed({ mnemonic })
    await saveIdentity(testDataDir, {
      identity: mockIdentity,
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

  it('submits stamped message and outputs human-readable summary', async () => {
    const recipientIdentity = monadIdentityModule.MonadIdentity.fromSeed({
      mnemonic: bip39.generateMnemonic(),
    })
    const recipientAddr = recipientIdentity.displayAddress
    const recipientPub = recipientIdentity.compressedPubKey

    jest.spyOn(monadIdentityModule, 'fetchMonadProfile').mockResolvedValueOnce({
      address: { raw: recipientAddr },
      pubKey: recipientPub,
    } as any)

    jest
      .spyOn(monadStampClientModule, 'quoteMonadStampPaymentGasReserve')
      .mockResolvedValue(50000n)
    jest
      .spyOn(
        monadStampClientModule.MonadStampClient.prototype,
        'resumePendingAttempts',
      )
      .mockResolvedValue(undefined as any)
    jest
      .spyOn(MonadSubAccountPool.prototype, 'prepareStampInventory')
      .mockResolvedValue(undefined as any)
    jest
      .spyOn(
        monadStampClientModule.MonadStampClient.prototype,
        'submitStampedMessage',
      )
      .mockResolvedValue({
        payloadHashHex: 'deadbeef1234567890abcdef',
        txHashes: ['0xtxhash111', '0xtxhash222'],
        leaseIndices: [0, 1],
        stored: {} as any,
        changeSweeps: [],
      })

    await sendCommand(recipientAddr, 'Hello Monad from CLI', {
      dataDir: testDataDir,
      stamp: '0.02 MON',
      relay: 'http://test-relay:8080',
    })

    expect(logSpy).toHaveBeenCalled()
    const allLogs = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(allLogs).toContain('Direct message sent successfully:')
    expect(allLogs).toContain('Payload Digest:  deadbeef1234567890abcdef')
    expect(allLogs).toContain(`Recipient:       ${recipientAddr}`)
    expect(allLogs).toContain('0.02 MON')
    expect(allLogs).toContain('0xtxhash111')
  })

  it('outputs JSON result when --json flag is provided', async () => {
    const recipientIdentity = monadIdentityModule.MonadIdentity.fromSeed({
      mnemonic: bip39.generateMnemonic(),
    })
    const recipientAddr = recipientIdentity.displayAddress
    const recipientPub = recipientIdentity.compressedPubKey

    jest.spyOn(monadIdentityModule, 'fetchMonadProfile').mockResolvedValueOnce({
      address: { raw: recipientAddr },
      pubKey: recipientPub,
    } as any)

    jest
      .spyOn(monadStampClientModule, 'quoteMonadStampPaymentGasReserve')
      .mockResolvedValue(50000n)
    jest
      .spyOn(
        monadStampClientModule.MonadStampClient.prototype,
        'resumePendingAttempts',
      )
      .mockResolvedValueOnce(undefined as any)
    jest
      .spyOn(MonadSubAccountPool.prototype, 'prepareStampInventory')
      .mockResolvedValueOnce(undefined as any)
    jest
      .spyOn(
        monadStampClientModule.MonadStampClient.prototype,
        'submitStampedMessage',
      )
      .mockResolvedValueOnce({
        payloadHashHex: 'abcdef123456',
        txHashes: ['0xtx333'],
        leaseIndices: [0],
        stored: {} as any,
        changeSweeps: [],
      })

    await sendCommand(recipientAddr, 'JSON message test', {
      dataDir: testDataDir,
      json: true,
    })

    expect(logSpy).toHaveBeenCalled()
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.status).toBe('delivered')
    expect(parsed.payloadDigest).toBe('abcdef123456')
    expect(parsed.recipient).toBe(recipientAddr)
    expect(parsed.txHashes).toEqual(['0xtx333'])
  })

  it('fails gracefully when recipient profile is not found', async () => {
    const recipientAddr = '0x4444444444444444444444444444444444444444'
    jest
      .spyOn(monadIdentityModule, 'fetchMonadProfile')
      .mockResolvedValueOnce(undefined)

    await sendCommand(recipientAddr, 'Message that fails', {
      dataDir: testDataDir,
      json: true,
    })

    expect(errorSpy).toHaveBeenCalled()
    const lastErr = errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastErr)
    expect(parsed.error).toContain('has no registered public key')
  })
})

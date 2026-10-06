import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'

import { buildEnvelope } from '@frank/cashweb/relay/monad-message-envelope'
import * as monadMessageFeedModule from '@frank/cashweb/relay/monad-message-feed'
import { serializeMessageItems } from '@frank/wallet/chain/monad-chain'
import * as monadIdentityModule from '@frank/wallet/monad-identity'

import { inboxCommand, listenCommand } from '../src/commands/inbox'
import { saveIdentity } from '../src/config'

describe('Inbox and Listen Commands', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let recipientIdentity: monadIdentityModule.MonadIdentity
  let senderIdentity: monadIdentityModule.MonadIdentity
  let mnemonic: string

  beforeEach(async () => {
    testDataDir = join(
      tmpdir(),
      `signet-inbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(testDataDir, { recursive: true })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    mnemonic = bip39.generateMnemonic()
    recipientIdentity = monadIdentityModule.MonadIdentity.fromSeed({ mnemonic })
    senderIdentity = monadIdentityModule.MonadIdentity.fromSeed({
      mnemonic: bip39.generateMnemonic(),
    })

    await saveIdentity(testDataDir, {
      identity: recipientIdentity,
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

  it('outputs empty inbox message when no messages are found', async () => {
    jest
      .spyOn(monadMessageFeedModule, 'fetchMonadMessagesSince')
      .mockResolvedValue([])

    await inboxCommand({ dataDir: testDataDir })

    expect(logSpy).toHaveBeenCalledWith('Inbox is empty.')
  })

  it('outputs empty JSON array when --json is provided and inbox is empty', async () => {
    jest
      .spyOn(monadMessageFeedModule, 'fetchMonadMessagesSince')
      .mockResolvedValue([])

    await inboxCommand({ dataDir: testDataDir, json: true })

    expect(logSpy).toHaveBeenCalledWith('[]')
  })

  it('decrypts and displays messages from inbox', async () => {
    const envelope = buildEnvelope({
      fromAddress: senderIdentity.displayAddress,
      fromPrivateKey: senderIdentity.toNakamotoPrivateKey(),
      toAddress: recipientIdentity.displayAddress,
      toPubKey: recipientIdentity.compressedPubKey,
      plaintext: serializeMessageItems([
        { type: 'text', text: 'Hello Signet!' },
      ]),
      networkTag: 'monad-devnet',
    })

    const fakeRecord: any = {
      timestamp: 1600000000000,
      message: {
        payloadHash: Buffer.from('payloadhash123', 'utf8'),
        encryptedPayload: envelope,
      },
    }

    jest
      .spyOn(monadMessageFeedModule, 'fetchMonadMessagesSince')
      .mockResolvedValue([fakeRecord])
    jest.spyOn(monadIdentityModule, 'fetchMonadProfile').mockResolvedValue({
      address: { raw: senderIdentity.displayAddress },
      pubKey: senderIdentity.compressedPubKey,
    } as any)

    await inboxCommand({ dataDir: testDataDir, json: true })

    expect(logSpy).toHaveBeenCalled()
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].sender).toBe(senderIdentity.displayAddress)
    expect(parsed[0].recipient).toBe(recipientIdentity.displayAddress)
    expect(parsed[0].text).toBe('Hello Signet!')
  })

  it('handles --unread flag and preserves cursor', async () => {
    const envelope = buildEnvelope({
      fromAddress: senderIdentity.displayAddress,
      fromPrivateKey: senderIdentity.toNakamotoPrivateKey(),
      toAddress: recipientIdentity.displayAddress,
      toPubKey: recipientIdentity.compressedPubKey,
      plaintext: serializeMessageItems([{ type: 'text', text: 'Unread 1' }]),
      networkTag: 'monad-devnet',
    })

    const fakeRecord: any = {
      timestamp: 1700000000000,
      message: {
        payloadHash: Buffer.from('payloadhash456', 'utf8'),
        encryptedPayload: envelope,
      },
    }

    jest
      .spyOn(monadMessageFeedModule, 'fetchMonadMessagesSince')
      .mockResolvedValue([fakeRecord])
    jest.spyOn(monadIdentityModule, 'fetchMonadProfile').mockResolvedValue({
      address: { raw: senderIdentity.displayAddress },
      pubKey: senderIdentity.compressedPubKey,
    } as any)

    await inboxCommand({ dataDir: testDataDir, unread: true, json: true })
    const parsedFirst = JSON.parse(
      logSpy.mock.calls[logSpy.mock.calls.length - 1][0],
    )
    expect(parsedFirst).toHaveLength(1)

    // Second read should filter out <= lastRead timestamp
    await inboxCommand({ dataDir: testDataDir, unread: true, json: true })
    const parsedSecond = JSON.parse(
      logSpy.mock.calls[logSpy.mock.calls.length - 1][0],
    )
    expect(parsedSecond).toHaveLength(0)
  })

  it('runs listen command once when follow is not set', async () => {
    jest
      .spyOn(monadMessageFeedModule, 'fetchMonadMessagesSince')
      .mockResolvedValue([])

    await listenCommand({ dataDir: testDataDir, follow: false })

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Listening for incoming messages on`),
    )
  })
})

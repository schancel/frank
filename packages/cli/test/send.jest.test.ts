import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import * as accountModule from '../src/account'
import { sendCommand } from '../src/commands/send'

const RECIPIENT = '0x1111111111111111111111111111111111111111'
// The generator point: a valid compressed key whose address is well known.
const RECIPIENT_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const RECIPIENT_KEY_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'

/** The messaging account is replaced at its one seam; the relay and chain behind it are
 * exercised by the real-stack run, not here. */
function stubAccount(send: accountModule.CliAccount['send']) {
  const account: accountModule.CliAccount = {
    address: '0x2222222222222222222222222222222222222222',
    mainAccount: '0x3333333333333333333333333333333333333333',
    send: jest.fn(send),
    receivedSince: jest.fn(async () => []),
    close: jest.fn(async () => {}),
  }
  const open = jest.spyOn(accountModule, 'openCliAccount').mockResolvedValue(account)
  return { account, open }
}

describe('send', () => {
  let dataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    dataDir = join(tmpdir(), `frank-cli-send-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dataDir, { recursive: true })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = 0
    rmSync(dataDir, { recursive: true, force: true })
  })

  const printed = () => JSON.parse(logSpy.mock.calls.map(call => call[0]).join('\n'))

  it('sends a text message from the account to an address, paying the stamp asked for', async () => {
    const { account, open } = stubAccount(async () => 'ab'.repeat(32))
    await sendCommand(RECIPIENT, 'hello', { dataDir, json: true, stamp: '5wei', relay: 'http://relay.test/' })
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ dataDir, relayUrl: 'http://relay.test' }))
    expect(account.send).toHaveBeenCalledWith(RECIPIENT, [{ type: 'text', text: 'hello' }], 5n)
    expect(printed()).toEqual({
      status: 'delivered',
      recipient: RECIPIENT,
      sender: account.address,
      payloadDigest: 'ab'.repeat(32),
      stampValueWei: '5',
      relayUrl: 'http://relay.test',
    })
    expect(account.close).toHaveBeenCalledTimes(1)
  })

  it('accepts a compressed public key as the recipient and a free message', async () => {
    const { account } = stubAccount(async () => 'cd'.repeat(32))
    await sendCommand(RECIPIENT_KEY, 'free', { dataDir, json: true, stamp: '0' })
    expect(account.send).toHaveBeenCalledWith(RECIPIENT_KEY_ADDRESS, [{ type: 'text', text: 'free' }], 0n)
  })

  it('refuses a malformed recipient before opening the account', async () => {
    const { open } = stubAccount(async () => '')
    await sendCommand('not-an-address', 'x', { dataDir, json: true })
    expect(open).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0][0]).toContain('Recipient must be')
  })

  it('says which address to fund when a paid message cannot be sent, and still closes the account', async () => {
    const { account } = stubAccount(async () => {
      throw new Error('insufficient balance')
    })
    await sendCommand(RECIPIENT, 'paid', { dataDir, json: true, stamp: '7wei' })
    const message = JSON.parse(errorSpy.mock.calls[0][0]).error as string
    expect(message).toContain('insufficient balance')
    expect(message).toContain(account.mainAccount)
    expect(message).toContain('--stamp 0')
    expect(account.close).toHaveBeenCalledTimes(1)
  })
})

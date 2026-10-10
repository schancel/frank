import axios from 'axios'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import * as accountModule from '../src/account'
import { mailSendCommand } from '../src/commands/mail'
import { saveConfig } from '../src/config'

jest.mock('axios')

describe('mail send', () => {
  let dataDir: string
  let post: jest.Mock
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-mail-'))
    saveConfig(dataDir, { gatewayUrl: 'https://gateway.example' })
    post = (axios.post as jest.Mock).mockResolvedValue({
      data: { ok: true, rfc822MessageId: '<id@example>', grantedReplyAllowance: 1 },
    })
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    post.mockReset()
    rmSync(dataDir, { recursive: true, force: true })
    process.exitCode = 0
  })

  it('gives the gateway the messaging account, the address inbox reads', async () => {
    mkdirSync(join(dataDir, 'account'), { recursive: true })
    writeFileSync(join(dataDir, 'account', 'account-root.hex'), '11'.repeat(32))
    const open = jest.spyOn(accountModule, 'openCliAccount')

    await mailSendCommand('someone@example.com', 'hello', { dataDir, json: true })

    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][1].senderFrankAddress).toBe(
      accountModule.cliAccountAddresses(dataDir)!.address,
    )
    // The account already exists: nothing is opened or published.
    expect(open).not.toHaveBeenCalled()
  })

  it('creates and publishes the messaging account first when there is none', async () => {
    const close = jest.fn(async () => undefined)
    const open = jest.spyOn(accountModule, 'openCliAccount').mockResolvedValue({
      address: '0x' + '34'.repeat(20),
      mainAccount: '0x' + '56'.repeat(20),
      send: jest.fn(),
      receivedSince: jest.fn(),
      close,
    })

    await mailSendCommand('someone@example.com', 'hello', { dataDir, json: true })

    expect(open).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][1].senderFrankAddress).toBe('0x' + '34'.repeat(20))
  })
})

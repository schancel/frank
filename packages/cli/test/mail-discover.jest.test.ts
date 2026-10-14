import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { mailDiscoverCommand } from '../src/commands/mail-discover'
import { createProgram } from '../src/cli'
import * as account from '../src/account'
import * as config from '../src/config'

const address = '0xAb22222222222222222222222222222222222222'
const relay = 'https://relay.example.test'
const info = {
  network: 'monad-testnet',
  endpoint: relay,
  emailGateway: { address, domain: 'mail.example.test' },
}

describe('read-only mail discovery through the actual CLI', () => {
  let dir: string
  let fetchMock: jest.SpyInstance
  let output: jest.SpyInstance
  let openAccount: jest.SpyInstance
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frank-mail-discover-'))
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => info } as Response)
    output = jest.spyOn(console, 'log').mockImplementation(() => {})
    openAccount = jest
      .spyOn(account, 'openCliAccount')
      .mockImplementation(async () => {
        throw new Error('must not open account')
      })
  })
  afterEach(() => {
    expect(openAccount).not.toHaveBeenCalled()
    jest.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  async function run(...args: string[]) {
    const program = createProgram().exitOverride()
    const mail = program.commands.find(command => command.name() === 'mail')!
    mail.commands.find(command => command.name() === 'discover')!.exitOverride()
    await program.parseAsync(['node', 'signet', '--data-dir', dir, ...args])
  }
  it('uses configured relay, preserves gateway casing, and changes no files', async () => {
    const raw = JSON.stringify({
      relayUrl: relay,
      activeIdentity: 'do-not-open',
    })
    writeFileSync(join(dir, 'config.json'), raw)
    const identity = jest
      .spyOn(config, 'loadIdentity')
      .mockImplementation(async () => {
        throw new Error('must not open identity')
      })
    const layout = jest
      .spyOn(config, 'ensureStorageLayout')
      .mockImplementation(() => {
        throw new Error('must not create storage')
      })
    const load = jest.spyOn(config, 'loadConfig').mockImplementation(() => {
      throw new Error('must not initialize storage')
    })
    await run('--json', 'mail', 'discover', '--chain', 'monad-testnet')
    expect(output).toHaveBeenCalledWith(JSON.stringify(info.emailGateway))
    expect(fetchMock).toHaveBeenCalledWith(`${relay}/relay/v1/info`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    expect(load).not.toHaveBeenCalled()
    expect(identity).not.toHaveBeenCalled()
    expect(layout).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual(['config.json'])
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(raw)
  })
  it('uses override and does not create a missing data directory', async () => {
    const parent = dir
    dir = join(dir, 'absent')
    await run('mail', 'discover', '--chain', 'monad-testnet', '--relay', relay)
    expect(output).toHaveBeenCalledWith(
      `Email gateway: ${address}\nDomain: mail.example.test`,
    )
    expect(existsSync(dir)).toBe(false)
    dir = parent
  })
  it.each(['monad', 'evm', '10143', 'MONAD-TESTNET', 'unknown'])(
    'rejects noncanonical chain %s before probing',
    async chain => {
      await expect(
        run('mail', 'discover', '--chain', chain, '--relay', relay),
      ).rejects.toThrow('canonical chain identifier')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(readdirSync(dir)).toEqual([])
    },
  )
  it('rejects missing chain at the command function boundary', async () => {
    await expect(mailDiscoverCommand({ relay })).rejects.toThrow(
      'canonical chain identifier',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('requires explicit chain before probing', async () => {
    await expect(run('mail', 'discover', '--relay', relay)).rejects.toThrow(
      '--chain',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['ethereum-sepolia', 'solana-mainnet', 'xec-mainnet'])(
    'accepts registry network %s without inferring family identity',
    async chain => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ...info, network: chain }),
      })
      await run('mail', 'discover', '--chain', chain, '--relay', relay)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
  it.each([undefined, null])(
    'prints explicit absent advertisement %s',
    async emailGateway => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ...info, emailGateway }),
      })
      await run(
        'mail',
        'discover',
        '--chain',
        'monad-testnet',
        '--relay',
        relay,
      )
      expect(output).toHaveBeenCalledWith('No email gateway advertised')
      await run(
        '--json',
        'mail',
        'discover',
        '--chain',
        'monad-testnet',
        '--relay',
        relay,
      )
      expect(output).toHaveBeenCalledWith('null')
    },
  )
  it('surfaces failed discovery without account or filesystem mutation', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    await expect(
      run('mail', 'discover', '--chain', 'monad-testnet', '--relay', relay),
    ).rejects.toThrow('network down')
    expect(readdirSync(dir)).toEqual([])
  })
  it('keeps one pure transport owner used directly by both consumers', () => {
    const root = resolve(__dirname, '../../..')
    const shared = readFileSync(
      join(root, 'packages/cashweb/relay/email-gateway-discovery.ts'),
      'utf8',
    )
    expect(shared).not.toMatch(/\bimport\b|\brequire\s*\(/)
    for (const consumer of [
      'app/src/stores/settings.ts',
      'packages/cli/src/commands/mail-discover.ts',
    ])
      expect(readFileSync(join(root, consumer), 'utf8')).toContain(
        "from '@frank/cashweb/relay/email-gateway-discovery'",
      )
    expect(
      existsSync(join(root, 'app/src/utils/email-gateway-discovery.ts')),
    ).toBe(false)
  })
})

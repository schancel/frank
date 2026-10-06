import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import * as monadIdentityModule from '@frank/wallet/monad-identity'

import {
  createIdentityCommand,
  showIdentityCommand,
} from '../src/commands/identity'
import { loadConfig } from '../src/config'

describe('Identity Commands', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    testDataDir = join(
      tmpdir(),
      `signet-id-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(testDataDir, { recursive: true })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    try {
      rmSync(testDataDir, { recursive: true, force: true })
    } catch {}
  })

  it('creates a new identity with human-readable output', async () => {
    await createIdentityCommand({ dataDir: testDataDir })

    expect(logSpy).toHaveBeenCalled()
    const allLogs = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(allLogs).toContain('Generated new identity:')
    expect(allLogs).toContain('Public Address:         0x')
    expect(allLogs).toContain('Encryption Public Key:')
    expect(allLogs).toContain('Mnemonic Seed:')

    const config = loadConfig(testDataDir)
    expect(config.activeIdentity).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('creates a new identity with JSON output', async () => {
    await createIdentityCommand({ dataDir: testDataDir, json: true })

    expect(logSpy).toHaveBeenCalled()
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(parsed.encryptionPublicKey).toMatch(/^[0-9a-f]{66}$/)
    expect(typeof parsed.mnemonic).toBe('string')
    expect(parsed.mnemonic.split(' ').length).toBe(12)
  })

  it('shows active identity with registered profile', async () => {
    // Create an identity first
    await createIdentityCommand({ dataDir: testDataDir, json: true })
    const created = JSON.parse(
      logSpy.mock.calls[logSpy.mock.calls.length - 1][0],
    )

    // Mock fetchMonadProfile
    jest.spyOn(monadIdentityModule, 'fetchMonadProfile').mockResolvedValueOnce({
      address: { raw: created.address },
      pubKey: Buffer.from(created.encryptionPublicKey, 'hex'),
      name: 'Alice',
      bio: 'Frank tester',
      bot: false,
    } as any)

    await showIdentityCommand({ dataDir: testDataDir })

    const allLogs = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(allLogs).toContain(`Address:                ${created.address}`)
    expect(allLogs).toContain('Relay Profile:          Registered')
    expect(allLogs).toContain('Name:                 Alice')
    expect(allLogs).toContain('Bio:                  Frank tester')
  })

  it('shows active identity with JSON output', async () => {
    await createIdentityCommand({ dataDir: testDataDir, json: true })
    const created = JSON.parse(
      logSpy.mock.calls[logSpy.mock.calls.length - 1][0],
    )

    jest
      .spyOn(monadIdentityModule, 'fetchMonadProfile')
      .mockResolvedValueOnce(undefined)

    await showIdentityCommand({ dataDir: testDataDir, json: true })

    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastCall)
    expect(parsed.address).toBe(created.address)
    expect(parsed.encryptionPublicKey).toBe(created.encryptionPublicKey)
    expect(parsed.registered).toBe(false)
    expect(parsed.profile).toBeNull()
  })

  it('reports error when showing identity but none exists', async () => {
    await showIdentityCommand({ dataDir: testDataDir, json: true })
    expect(errorSpy).toHaveBeenCalled()
    const lastErr = errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0]
    const parsed = JSON.parse(lastErr)
    expect(parsed.error).toContain('No identity found')
  })
})

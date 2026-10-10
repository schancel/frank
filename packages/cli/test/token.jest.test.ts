/**
 * Integration Tests for Signet CLI Token Commands (Tickets #1152, #1153, #1155).
 *
 * Verifies:
 * - Token listing and filtering across chains
 * - Local LevelDB TokenUtxoStore recording and zero-RPC balance queries
 * - Encrypted Type 6 DM transfers with coin selection and HD change UTXO creation
 * - Command dispatch via Commander CLI
 */

import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'
import { parseUnits } from 'ethers'

import * as monadIdentityModule from '@frank/wallet/monad-identity'
import { TokenUtxoStore } from '@frank/wallet/token-utxo-store'
import { tokenRegistry } from '@frank/wallet/token-registry'

import { createProgram } from '../src/cli'
import { saveIdentity } from '../src/config'
import {
  tokenBalanceCommand,
  tokenListCommand,
  tokenRecordCommand,
  tokenSendCommand,
} from '../src/commands/token'

describe('CLI Token Commands & Local LevelDB UTXO Integration', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let identity: monadIdentityModule.MonadIdentity
  let mnemonic: string
  let walletDir: string

  beforeEach(async () => {
    testDataDir = join(
      tmpdir(),
      `signet-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(testDataDir, { recursive: true })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    mnemonic = bip39.generateMnemonic()
    identity = monadIdentityModule.MonadIdentity.fromSeed({ mnemonic })
    walletDir = join(testDataDir, 'wallets', identity.displayAddress)

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

  describe('token list', () => {
    it('lists all supported tokens in TokenRegistry in human and JSON format', async () => {
      await tokenListCommand()
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Supported Whitelisted Tokens'),
      )
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('USDC'))
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('AVU'))

      await tokenListCommand({ json: true })
      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.count).toBeGreaterThanOrEqual(8)
      expect(parsed.tokens.some((t: any) => t.symbol === 'USDC')).toBe(true)
      expect(parsed.tokens.some((t: any) => t.symbol === 'AVU')).toBe(false)
    })

    it('filters tokens by chain identifier', async () => {
      await tokenListCommand({ chain: 'solana', json: true })
      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.chain).toBe('solana')
      expect(parsed.tokens.every((t: any) => t.chainId === 'solana')).toBe(true)
      expect(parsed.tokens.some((t: any) => t.symbol === 'SOL')).toBe(true)
    })
  })

  describe('token record and token balance', () => {
    it('records unspent token UTXO notes and queries balance without RPC calls', async () => {
      // 1. Initial balance is empty
      await tokenBalanceCommand({ dataDir: testDataDir, json: true })
      let lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      let parsed = JSON.parse(lastCall)
      expect(parsed.tokenCount).toBe(0)

      // 2. Record 250 USDC
      await tokenRecordCommand('250', 'USDC', {
        dataDir: testDataDir,
        chain: 'monad',
        txHash: '0xtesttx1',
        json: true,
      })
      lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      parsed = JSON.parse(lastCall)
      expect(parsed.status).toBe('recorded')
      expect(parsed.token).toBe('USDC')
      expect(parsed.amount).toBe('250000000') // 250 * 10^6
      expect(parsed.totalBalance).toBe('250000000')

      // 3. Record another 50.5 USDC
      await tokenRecordCommand('50.5', 'USDC', {
        dataDir: testDataDir,
        chain: 'monad',
        txHash: '0xtesttx2',
        json: true,
      })

      // 4. Query specific token balance
      await tokenBalanceCommand({
        dataDir: testDataDir,
        token: 'USDC',
        json: true,
      })
      lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      parsed = JSON.parse(lastCall)
      expect(parsed.symbol).toBe('USDC')
      expect(parsed.balance).toBe('300500000') // 300.5 USDC
      expect(parsed.balanceFormatted).toBe('300.5')
      expect(parsed.unspentCount).toBe(2)
      expect(parsed.notes.length).toBe(2)

      // 5. Query all tokens summary
      await tokenBalanceCommand({ dataDir: testDataDir, json: true })
      lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      parsed = JSON.parse(lastCall)
      expect(parsed.tokenCount).toBe(1)
      expect(parsed.tokens[0].symbol).toBe('USDC')
      expect(parsed.tokens[0].totalFormatted).toBe('300.5')
    })

    it('rejects invalid or non-positive record amounts', async () => {
      await tokenRecordCommand('-10', 'USDC', {
        dataDir: testDataDir,
        json: true,
      })
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Amount must be greater than zero'),
      )
    })
  })

  describe('token send with coin selection and change derivation', () => {
    it('rejects token send when balance is insufficient', async () => {
      // Record 10 USDC
      await tokenRecordCommand('10', 'USDC', {
        dataDir: testDataDir,
        chain: 'monad',
        json: true,
      })

      // Attempt to send 50 USDC
      const recipient = '0x1234567890123456789012345678901234567890'
      await tokenSendCommand(recipient, '50', 'USDC', {
        dataDir: testDataDir,
        chain: 'monad',
        json: true,
      })

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Insufficient local token balance'),
      )
    })

    it('prepares token transfer, spends notes, and derives HD change address', async () => {
      // Record note of 100 USDC
      await tokenRecordCommand('100', 'USDC', {
        dataDir: testDataDir,
        chain: 'monad',
        json: true,
      })

      const recipient = '0x2222222222222222222222222222222222222222'
      await tokenSendCommand(recipient, '35', 'USDC', {
        dataDir: testDataDir,
        chain: 'monad',
        memo: 'Test invoice settlement',
        json: true,
      })

      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.status).toBe('prepared')
      expect(parsed.amountFormatted).toBe('35 USDC')
      expect(parsed.recipient).toBe(recipient)
      expect(parsed.consumedNotes.length).toBe(1)
      expect(parsed.changeCreated).toBeDefined()
      expect(parsed.changeCreated.amountFormatted).toBe('65.0 USDC')
      expect(parsed.type6FrameLength).toBeGreaterThan(0)
      expect(parsed.envelopeLength).toBeGreaterThan(0)

      // Verify LevelDB store reflects spent note and new change note
      const store = new TokenUtxoStore(walletDir)
      await store.open()
      const unspent = await store.listUnspentByToken(
        'monad',
        parsed.contractAddress,
      )
      expect(unspent.length).toBe(1)
      expect(unspent[0].amount).toBe(parseUnits('65', 6))
      expect(unspent[0].recipientAddress).toBe(parsed.changeCreated.address)
      await store.close()
    })
  })

  describe('Commander CLI Dispatch', () => {
    it('executes signet token list via CLI program', async () => {
      const program = createProgram()
      await program.parseAsync([
        'node',
        'signet',
        'token',
        'list',
        '--data-dir',
        testDataDir,
        '--json',
      ])

      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.tokens).toBeDefined()
      expect(parsed.count).toBeGreaterThan(0)
    })

    it('executes signet token record and balance via CLI program', async () => {
      const program = createProgram()
      await program.parseAsync([
        'node',
        'signet',
        'token',
        'record',
        '42',
        'USDT',
        '--data-dir',
        testDataDir,
        '--json',
      ])

      await program.parseAsync([
        'node',
        'signet',
        'token',
        'balance',
        '--token',
        'USDT',
        '--data-dir',
        testDataDir,
        '--json',
      ])

      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.symbol).toBe('USDT')
      expect(parsed.balanceFormatted).toBe('42.0')
      expect(parsed.unspentCount).toBe(1)
    })
  })
})

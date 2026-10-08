/**
 * Integration Tests for Signet CLI Swap Commands & dApp Plugin Host (Tickets #1154, #1155).
 *
 * Verifies:
 * - Plugin listing across EVM, Solana, and multi-chain
 * - High-precision quote computation with exact 8.75 bps (0.0875%) protocol fee deduction
 * - Transaction construction settling directly into recoverable BIP-44 / SLIP-0010 HD change addresses
 * - Invariant verification: calldata and instructions encode HD change address as swap output recipient
 * - Command dispatch via Commander CLI
 */

import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'

import * as monadIdentityModule from '@frank/wallet/monad-identity'
import { EvmChangeKeyring } from '@frank/wallet/secp256k1-hd-keyring'
import { SolanaChangeKeyring } from '@frank/wallet/ed25519-hd-keyring'
import { UniswapDAppPlugin } from '@frank/wallet/plugins'

import { createProgram } from '../src/cli'
import { saveIdentity } from '../src/config'
import {
  swapBuildCommand,
  swapPluginsCommand,
  swapQuoteCommand,
} from '../src/commands/swap'

describe('CLI Swap Commands & dApp Plugin Integration', () => {
  let testDataDir: string
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let identity: monadIdentityModule.MonadIdentity
  let mnemonic: string

  beforeEach(async () => {
    testDataDir = join(
      tmpdir(),
      `signet-swap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  describe('swap plugins', () => {
    it('lists registered reference dApp plugins in human and JSON format', async () => {
      await swapPluginsCommand()
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Registered dApp Plugins'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('uniswap-universal-router'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('jupiter-aggregator'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('prediction-escrow'),
      )

      await swapPluginsCommand({ json: true })
      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.count).toBe(3)
      expect(parsed.plugins.map((p: any) => p.id)).toEqual([
        'uniswap-universal-router',
        'jupiter-aggregator',
        'prediction-escrow',
      ])
    })
  })

  describe('swap quote', () => {
    it('calculates EVM quote with exact 8.75 bps protocol convenience fee deduction', async () => {
      // 1000 USDC -> MON
      await swapQuoteCommand('USDC', 'MON', '1000', { json: true })
      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)

      expect(parsed.pluginId).toBe('uniswap-universal-router')
      expect(parsed.inputToken).toBe('USDC')
      expect(parsed.outputToken).toBe('MON')
      expect(parsed.inputAmount).toBe('1000000000') // 1000 * 10^6
      expect(parsed.feeBps).toBe(8.75)
      expect(parsed.feePercentage).toBe('0.0875%')

      // 8.75 bps of 1000 USDC = 0.875 USDC = 875,000 base units
      expect(parsed.feeAmount).toBe('875000')
      expect(parsed.netInputAmount).toBe('999125000')
      expect(BigInt(parsed.expectedOutputAmount)).toBeGreaterThan(0n)
      expect(BigInt(parsed.minOutputAmount)).toBeLessThan(
        BigInt(parsed.expectedOutputAmount),
      )
    })

    it('auto-selects Jupiter aggregator for Solana token pairs', async () => {
      // 5 SOL -> USDC
      await swapQuoteCommand('SOL', 'USDC', '5', { json: true })
      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)

      expect(parsed.pluginId).toBe('jupiter-aggregator')
      expect(parsed.chainType).toBe('solana')
      expect(parsed.inputToken).toBe('SOL')
      expect(parsed.outputToken).toBe('USDC')
      expect(parsed.inputAmount).toBe('5000000000') // 5 * 10^9
      expect(parsed.feeBps).toBe(8.75)
    })

    it('formats human readable quote with route and gas breakdown', async () => {
      await swapQuoteCommand('USDC', 'AVU', '100')
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Swap Quote via Uniswap Universal Router:'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Protocol Fee (8.75 bps)'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Guaranteed Minimum'),
      )
    })
  })

  describe('swap build', () => {
    it('builds EVM swap settling into next derived HD change address m/44/60/0/1/0', async () => {
      const changeKeyring = EvmChangeKeyring.fromMnemonic(mnemonic)
      const expectedChangeAccount = changeKeyring.deriveChangeAccount(0)
      const expectedPath = changeKeyring.subAccountPath(0)

      await swapBuildCommand('USDC', 'MON', '500', {
        dataDir: testDataDir,
        json: true,
      })

      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)

      expect(parsed.pluginId).toBe('uniswap-universal-router')
      expect(parsed.destinationChangeAddress).toBe(
        expectedChangeAccount.address,
      )
      expect(parsed.derivationPath).toBe(expectedPath)
      expect(parsed.transaction.to).toBe(
        '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      )
      expect(parsed.transaction.data).toMatch(/^0x/)

      // Verify that the encoded execute() calldata has swapRecipient set to expectedChangeAccount.address
      const uniswap = new UniswapDAppPlugin()
      const decoded = uniswap.decodeExecuteCalldata(parsed.transaction.data)
      expect(decoded.swapRecipient?.toLowerCase()).toBe(
        expectedChangeAccount.address.toLowerCase(),
      )
      expect(decoded.feeBps).toBe(8.75)
    })

    it('builds Solana swap settling into derived SLIP-0010 HD change address', async () => {
      const changeKeyring = await SolanaChangeKeyring.fromMnemonic(mnemonic)
      const expectedChangeAccount = await changeKeyring.deriveChangeAccount(0)

      await swapBuildCommand('SOL', 'USDC', '2.5', {
        dataDir: testDataDir,
        json: true,
      })

      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)

      expect(parsed.pluginId).toBe('jupiter-aggregator')
      expect(parsed.chainType).toBe('solana')
      expect(parsed.destinationChangeAddress).toBe(
        expectedChangeAccount.address,
      )
      expect(parsed.derivationPath).toBe(expectedChangeAccount.path)
      expect(parsed.transaction.instructionCount).toBeGreaterThanOrEqual(2)
    })

    it('supports custom change index and destination address overrides', async () => {
      const changeKeyring = EvmChangeKeyring.fromMnemonic(mnemonic)
      const changeIndex3 = changeKeyring.deriveChangeAccount(3)

      await swapBuildCommand('USDC', 'MON', '100', {
        dataDir: testDataDir,
        changeIndex: 3,
        json: true,
      })

      let lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      let parsed = JSON.parse(lastCall)
      expect(parsed.destinationChangeAddress).toBe(changeIndex3.address)
      expect(parsed.derivationPath).toBe(changeKeyring.subAccountPath(3))

      const customDest = '0x8888888888888888888888888888888888888888'
      await swapBuildCommand('USDC', 'MON', '100', {
        dataDir: testDataDir,
        destination: customDest,
        json: true,
      })

      lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      parsed = JSON.parse(lastCall)
      expect(parsed.destinationChangeAddress).toBe(customDest)
      expect(parsed.derivationPath).toBe('custom-destination')
    })
  })

  describe('Commander CLI Dispatch', () => {
    it('executes signet swap plugins via CLI program', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'signet', 'swap', 'plugins', '--json'])

      const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.plugins.length).toBe(3)
    })

    it('executes signet swap quote and build via CLI program', async () => {
      const program = createProgram()
      await program.parseAsync([
        'node',
        'signet',
        'swap',
        'quote',
        'USDC',
        'MON',
        '100',
        '--json',
      ])

      let lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      let parsed = JSON.parse(lastCall)
      expect(parsed.feeBps).toBe(8.75)

      await program.parseAsync([
        'node',
        'signet',
        'swap',
        'build',
        'USDC',
        'MON',
        '100',
        '--data-dir',
        testDataDir,
        '--json',
      ])

      lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0]
      parsed = JSON.parse(lastCall)
      expect(parsed.destinationChangeAddress).toMatch(/^0x/)
      expect(parsed.transaction.data).toMatch(/^0x/)
    })
  })
})

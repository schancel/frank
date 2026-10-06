import { existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as bip39 from 'bip39'

import { MonadIdentity } from '@frank/wallet/monad-identity'

import {
  ensureStorageLayout,
  getDefaultConfig,
  listIdentities,
  loadConfig,
  loadIdentity,
  resolveDataDir,
  saveConfig,
  saveIdentity,
} from '../src/config'

describe('CLI State Storage and Configuration', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = join(
      tmpdir(),
      `signet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(testDataDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testDataDir, { recursive: true, force: true })
    } catch {}
  })

  describe('resolveDataDir', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      process.env = { ...originalEnv }
    })

    it('prefers explicit override', () => {
      process.env.SIGNET_HOME = '/env/home'
      expect(resolveDataDir('/custom/path')).toBe(
        resolveDataDir('/custom/path'),
      )
    })

    it('uses SIGNET_HOME if set', () => {
      delete process.env.SIGNET_DATA_DIR
      delete process.env.MONAD_WALLET_STORAGE_LOCATION
      process.env.SIGNET_HOME = '/env/signet/home'
      expect(resolveDataDir()).toContain('signet/home')
    })

    it('uses SIGNET_DATA_DIR if set', () => {
      delete process.env.SIGNET_HOME
      delete process.env.MONAD_WALLET_STORAGE_LOCATION
      process.env.SIGNET_DATA_DIR = '/env/signet/data'
      expect(resolveDataDir()).toContain('signet/data')
    })

    it('falls back to MONAD_WALLET_STORAGE_LOCATION', () => {
      delete process.env.SIGNET_HOME
      delete process.env.SIGNET_DATA_DIR
      process.env.MONAD_WALLET_STORAGE_LOCATION = '/legacy/location'
      expect(resolveDataDir()).toContain('legacy/location')
    })

    it('defaults to ~/.signet', () => {
      delete process.env.SIGNET_HOME
      delete process.env.SIGNET_DATA_DIR
      delete process.env.MONAD_WALLET_STORAGE_LOCATION
      expect(resolveDataDir()).toContain('.signet')
    })
  })

  describe('ensureStorageLayout', () => {
    it('creates config, identities, and wallets directories', () => {
      const layout = ensureStorageLayout(testDataDir)
      expect(existsSync(layout.dataDir)).toBe(true)
      expect(existsSync(layout.identitiesDir)).toBe(true)
      expect(existsSync(layout.walletsDir)).toBe(true)
    })
  })

  describe('loadConfig and saveConfig', () => {
    it('returns default config when no config.json exists', () => {
      const config = loadConfig(testDataDir)
      const defaults = getDefaultConfig()
      expect(config.rpcUrl).toBe(defaults.rpcUrl)
      expect(config.networkTag).toBe(defaults.networkTag)
      expect(config.chainId).toBe(defaults.chainId)
    })

    it('saves and reloads custom configuration', () => {
      const custom = {
        rpcUrl: 'http://custom-rpc:8545',
        relayUrl: 'http://custom-relay:8080',
        networkTag: 'MON1',
        chainId: 143,
        stampBurnAddress: '0x0000000000000000000000000000000000000001',
        activeIdentity: '0x1111111111111111111111111111111111111111',
      }
      saveConfig(testDataDir, custom)
      const reloaded = loadConfig(testDataDir)
      expect(reloaded).toEqual(custom)
    })
  })

  describe('saveIdentity and loadIdentity', () => {
    it('saves an identity and initializes wallet LevelDB bundle and journals', async () => {
      const mnemonic = bip39.generateMnemonic()
      const identity = MonadIdentity.fromSeed({ mnemonic })

      const savedPath = await saveIdentity(testDataDir, {
        identity,
        mnemonic,
      })

      expect(existsSync(savedPath)).toBe(true)
      const walletDir = join(
        testDataDir,
        'wallets',
        identity.displayAddress.toLowerCase(),
      )
      expect(existsSync(walletDir)).toBe(true)
      expect(existsSync(join(walletDir, 'wallet-manifest'))).toBe(true)
      expect(existsSync(join(walletDir, 'sub-account-pool'))).toBe(true)
      expect(existsSync(join(walletDir, 'change-pool'))).toBe(true)
      expect(existsSync(join(walletDir, 'stamp-attempt-journal'))).toBe(true)
      expect(existsSync(join(walletDir, 'stamp-payment-journal'))).toBe(true)

      // Automatically sets activeIdentity in config.json
      const config = loadConfig(testDataDir)
      expect(config.activeIdentity?.toLowerCase()).toBe(
        identity.displayAddress.toLowerCase(),
      )

      // Reload identity
      const loaded = await loadIdentity(testDataDir)
      expect(loaded.address.toLowerCase()).toBe(
        identity.displayAddress.toLowerCase(),
      )
      expect(loaded.mnemonic).toBe(mnemonic)
      expect(loaded.encryptionPublicKey).toBe(
        identity.compressedPubKey.toString('hex'),
      )
      expect(loaded.identity.displayAddress.toLowerCase()).toBe(
        identity.displayAddress.toLowerCase(),
      )
    })

    it('encrypts with password and decrypts correctly', async () => {
      const mnemonic = bip39.generateMnemonic()
      const identity = MonadIdentity.fromSeed({ mnemonic })
      const password = 'super-secret-password-123'

      await saveIdentity(testDataDir, {
        identity,
        mnemonic,
        password,
      })

      // Fails without password
      await expect(
        loadIdentity(testDataDir, identity.displayAddress, ''),
      ).rejects.toThrow()

      // Succeeds with correct password
      const loaded = await loadIdentity(
        testDataDir,
        identity.displayAddress,
        password,
      )
      expect(loaded.mnemonic).toBe(mnemonic)
      expect(loaded.address.toLowerCase()).toBe(
        identity.displayAddress.toLowerCase(),
      )
    })

    it('lists identities', async () => {
      expect(listIdentities(testDataDir)).toEqual([])
      const mnemonic = bip39.generateMnemonic()
      const identity = MonadIdentity.fromSeed({ mnemonic })

      await saveIdentity(testDataDir, { identity, mnemonic })
      const list = listIdentities(testDataDir)
      expect(list.length).toBe(1)
      expect(list[0].toLowerCase()).toBe(identity.displayAddress.toLowerCase())
    })
  })
})

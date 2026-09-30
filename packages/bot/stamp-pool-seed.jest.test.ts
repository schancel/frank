import {
  chmodSync,
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import * as bip39 from 'bip39'

// The provider is only constructed, never called, by setUpFundedStampClient without a poolSize;
// stub it so no socket or retry timer is ever opened.
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers')
  class FakeProvider {
    constructor(public url: string) {}
    destroy() {}
  }
  return { ...actual, JsonRpcProvider: FakeProvider }
})

import { setUpFundedStampClient } from './qwen-bot-common'
import {
  assertOwnedAndPrivate,
  loadOrCreatePoolMnemonic,
  openPersistentStampPool,
  POOL_META_FILE,
  POOL_SEED_FILE,
} from './stamp-pool-seed'

const DUMMY_WALLET = { address: `0x${'22'.repeat(20)}`, privateKey: `0x${'11'.repeat(32)}` }

describe('stamp pool seed persistence (#313)', () => {
  let dir: string
  let logs: string[]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pool-seed-'))
    logs = []
    for (const m of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '))
      })
    }
  })
  afterEach(() => {
    jest.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  async function firstSubAccount(stateDir: string): Promise<string> {
    const { pool, close } = await openPersistentStampPool(stateDir, 'test')
    pool.ensureSize(1)
    const address = pool.records()[0].address
    await close()
    return address
  }

  it('a restart against the same state dir yields the same first sub-account address', async () => {
    const first = await firstSubAccount(dir)
    const second = await firstSubAccount(dir)
    expect(second).toBe(first)
  })

  it('a different state dir gets a different pool', async () => {
    const other = mkdtempSync(join(tmpdir(), 'pool-seed-other-'))
    try {
      expect(await firstSubAccount(other)).not.toBe(await firstSubAccount(dir))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('a restart does not reuse a sub-account that was already spent (records persist too)', async () => {
    const first = await openPersistentStampPool(dir, 'test')
    first.pool.ensureSize(2)
    const [a, b] = first.pool.records()
    first.pool.records() // records are the persisted view
    // Mark the first account spent the way the lease manager does.
    const store = (first.pool as any).store
    store.put({ ...a, status: 'spent' })
    await first.close()

    const second = await openPersistentStampPool(dir, 'test')
    second.pool.ensureSize(2)
    const records = second.pool.records()
    expect(records[0]).toMatchObject({ address: a.address, status: 'spent' })
    expect(records[1].address).toBe(b.address)
    await second.close()
  })

  it('stores the seed as a valid mnemonic in a 0600 file inside a 0700 dir', () => {
    const state = join(dir, 'nested', 'state')
    const mnemonic = loadOrCreatePoolMnemonic(state, 'test')
    expect(bip39.validateMnemonic(mnemonic)).toBe(true)
    const file = join(state, POOL_SEED_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(state).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, mnemonic })
    expect(loadOrCreatePoolMnemonic(state, 'test')).toBe(mnemonic)
  })

  it('never logs the seed', async () => {
    const mnemonic = loadOrCreatePoolMnemonic(dir, 'test')
    chmodSync(join(dir, POOL_SEED_FILE), 0o644) // provokes the tighten-permissions warning
    loadOrCreatePoolMnemonic(dir, 'test')
    await firstSubAccount(dir)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(mnemonic)
    // Nor any 3-word run of it.
    const words = mnemonic.split(' ')
    for (let i = 0; i + 3 <= words.length; i++) {
      expect(logs.join('\n')).not.toContain(words.slice(i, i + 3).join(' '))
    }
  })

  it('tightens a group/world-readable seed file to 0600', () => {
    loadOrCreatePoolMnemonic(dir, 'test')
    const file = join(dir, POOL_SEED_FILE)
    chmodSync(file, 0o644)
    loadOrCreatePoolMnemonic(dir, 'test')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['garbage', 'not json'],
    ['wrong version', JSON.stringify({ version: 2, mnemonic: 'x' })],
    ['invalid mnemonic', JSON.stringify({ version: 1, mnemonic: 'abandon abandon abandon' })],
  ])('refuses a %s seed file instead of generating a new seed', (_n, content) => {
    const file = join(dir, POOL_SEED_FILE)
    writeFileSync(file, content, { mode: 0o600 })
    expect(() => loadOrCreatePoolMnemonic(dir, 'test')).toThrow(/Refusing to continue/)
    expect(readFileSync(file, 'utf8')).toBe(content) // untouched
  })

  it('refuses a symlinked seed file', () => {
    const real = join(dir, 'real.json')
    writeFileSync(real, JSON.stringify({ version: 1, mnemonic: bip39.generateMnemonic() }))
    symlinkSync(real, join(dir, POOL_SEED_FILE))
    expect(() => loadOrCreatePoolMnemonic(dir, 'test')).toThrow(/not a regular file/)
  })

  it('an existing bot (identity and state files, no seed yet) keeps working and gains a seed', async () => {
    writeFileSync(join(dir, 'identity.json'), '{"privateKeyHex":"aa"}')
    writeFileSync(join(dir, 'other-state'), 'x')
    const address = await firstSubAccount(dir)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(readFileSync(join(dir, 'identity.json'), 'utf8')).toBe('{"privateKeyHex":"aa"}')
    expect(await firstSubAccount(dir)).toBe(address)
  })

  it('setUpFundedStampClient with a stateDir reuses the pool across restarts, and without one does not', async () => {
    const walletPath = join(dir, 'wallet.json')
    writeFileSync(walletPath, JSON.stringify(DUMMY_WALLET))
    const base = {
      rpcUrl: 'http://127.0.0.1:1',
      relayBaseUrl: 'http://127.0.0.1:2',
      mainWalletJsonPath: walletPath,
      stampValueWei: 1n,
      label: 'test',
    }
    const addr = async (stateDir?: string) => {
      const setup = await setUpFundedStampClient({ ...base, stateDir })
      setup.pool.ensureSize(1)
      const a = setup.pool.records()[0].address
      await setup.closePool()
      return a
    }
    const state = join(dir, 'state')
    const first = await addr(state)
    expect(await addr(state)).toBe(first)
    expect(await addr()).not.toBe(await addr()) // in-memory: fresh every time
  })
})

describe('stamp pool seed hardening (#313 review)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pool-seed-hard-'))
    for (const m of ['log', 'warn', 'error'] as const) jest.spyOn(console, m).mockImplementation(() => {})
  })
  afterEach(() => {
    jest.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('owner and mode checks', () => {
    it('refuses a file or directory owned by another user, and one writable by group or others', () => {
      const ok = { uid: 1000, mode: 0o100600 }
      expect(() => assertOwnedAndPrivate(ok, 1000, '/x', 'file')).not.toThrow()
      expect(() => assertOwnedAndPrivate({ ...ok, uid: 0 }, 1000, '/x', 'file')).toThrow(/owned by another user/)
      expect(() => assertOwnedAndPrivate({ ...ok, uid: 4242 }, 1000, '/x', 'directory')).toThrow(/directory \/x is owned by another user/)
      expect(() => assertOwnedAndPrivate({ ...ok, mode: 0o100620 }, 1000, '/x', 'file')).toThrow(/writable by group or others/)
      expect(() => assertOwnedAndPrivate({ ...ok, mode: 0o040777 }, 1000, '/x', 'directory')).toThrow(/writable by group or others/)
      // Readable by others is tightened elsewhere, not refused; no uids (Windows): owner check skipped.
      expect(() => assertOwnedAndPrivate({ uid: 1, mode: 0o100644 }, undefined, '/x', 'file')).not.toThrow()
    })

    it('refuses a pre-existing state directory that belongs to someone else, planted seed and all', () => {
      const mnemonic = loadOrCreatePoolMnemonic(dir, 'test') // a "planted" but valid seed
      jest.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
      let message = ''
      try {
        loadOrCreatePoolMnemonic(dir, 'test')
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/owned by another user/)
      expect(message).not.toContain(mnemonic)
    })

    it('refuses a pre-existing group/world-writable state directory', () => {
      chmodSync(dir, 0o777)
      expect(() => loadOrCreatePoolMnemonic(dir, 'test')).toThrow(/writable by group or others/)
      expect(existsSync(join(dir, POOL_SEED_FILE))).toBe(false)
    })

    it('refuses a state directory that is a symlink', () => {
      const real = join(dir, 'real')
      mkdirSync(real, { mode: 0o700 })
      symlinkSync(real, join(dir, 'link'))
      expect(() => loadOrCreatePoolMnemonic(join(dir, 'link'), 'test')).toThrow(/not a directory/)
    })

    it('tightens a directory it creates to 0700 even under a permissive umask', () => {
      const old = process.umask(0)
      try {
        const state = join(dir, 'fresh')
        loadOrCreatePoolMnemonic(state, 'test')
        expect(statSync(state).mode & 0o777).toBe(0o700)
      } finally {
        process.umask(old)
      }
    })
  })

  describe('records marker', () => {
    it('refuses a surviving seed whose records directory vanished after records existed', async () => {
      const first = await openPersistentStampPool(dir, 'test')
      first.pool.ensureSize(1)
      await first.close()
      expect(existsSync(join(dir, POOL_META_FILE))).toBe(true)
      expect(readFileSync(join(dir, POOL_META_FILE), 'utf8')).not.toMatch(/mnemonic|abandon/)
      rmSync(join(dir, 'sub-account-pool'), { recursive: true })
      await expect(openPersistentStampPool(dir, 'test')).rejects.toThrow(/records directory .* is missing/)
    })

    it('a corrupt or unreadable marker counts as "records existed" (fails closed)', async () => {
      const first = await openPersistentStampPool(dir, 'test')
      await first.close()
      writeFileSync(join(dir, POOL_META_FILE), '{not json')
      rmSync(join(dir, 'sub-account-pool'), { recursive: true })
      await expect(openPersistentStampPool(dir, 'test')).rejects.toThrow(/records directory .* is missing/)
      writeFileSync(join(dir, POOL_META_FILE), JSON.stringify({ version: 2 }))
      await expect(openPersistentStampPool(dir, 'test')).rejects.toThrow(/records directory .* is missing/)
    })

    it('also guards the change-pool records directory', async () => {
      const first = await openPersistentStampPool(dir, 'test')
      await first.close()
      rmSync(join(dir, 'change-pool'), { recursive: true })
      await expect(openPersistentStampPool(dir, 'test')).rejects.toThrow(/change-pool is missing/)
    })

    it('a fresh directory, or one whose marker was deliberately deleted, starts normally', async () => {
      const first = await openPersistentStampPool(dir, 'test')
      await first.close()
      rmSync(join(dir, 'sub-account-pool'), { recursive: true })
      rmSync(join(dir, POOL_META_FILE))
      const again = await openPersistentStampPool(dir, 'test')
      await again.close()
    })

    it('a seed created but never opened as a pool (no marker) is not refused', async () => {
      loadOrCreatePoolMnemonic(dir, 'test')
      const pool = await openPersistentStampPool(dir, 'test')
      await pool.close()
    })
  })

  describe('durable creation', () => {
    it('removes only OLD orphaned seed temp files; decoys and young temps stay', () => {
      const old = join(dir, `${POOL_SEED_FILE}.999.111.tmp`)
      const young = join(dir, `${POOL_SEED_FILE}.998.222.tmp`)
      const decoys = [
        `${POOL_SEED_FILE}.tmp`,
        `${POOL_SEED_FILE}.backup.tmp`,
        `${POOL_SEED_FILE}.123.tmp`,
        `${POOL_SEED_FILE}.1.2.3.tmp`,
        `x${POOL_SEED_FILE}.1.2.tmp`,
        `${POOL_SEED_FILE}.1.2.tmp.bak`,
      ]
      for (const f of [old, young, ...decoys.map(d => join(dir, d))]) {
        writeFileSync(f, '{"version":1,"mnemonic":"x"}', { mode: 0o600 })
      }
      const longAgo = new Date(Date.now() - 10 * 60 * 1000)
      for (const f of [old, ...decoys.map(d => join(dir, d))]) utimesSync(f, longAgo, longAgo)
      writeFileSync(join(dir, 'identity.json'), '{}')
      loadOrCreatePoolMnemonic(dir, 'test')
      expect(existsSync(old)).toBe(false)
      expect(existsSync(young)).toBe(true) // may be a concurrent first start's in-flight write
      for (const d of decoys) expect(existsSync(join(dir, d))).toBe(true)
      expect(existsSync(join(dir, 'identity.json'))).toBe(true)
    })

    it('fsyncs the directory as well as the file when it creates the seed', () => {
      const fs = require('fs')
      const spy = jest.spyOn(fs, 'fsyncSync')
      loadOrCreatePoolMnemonic(dir, 'test')
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })
})

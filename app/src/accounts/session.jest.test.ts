// Load the pinned SDK's real embedded WASM in Jest/CommonJS. Only the unused async
// URL loader needs import.meta removal; initSync and every cryptographic export stay real.
jest.mock('ecash-lib/dist/ffi/ecash_lib_wasm_browser.js', () => {
  const fs = jest.requireActual('node:fs')
  const ts = jest.requireActual('typescript')
  const source = fs
    .readFileSync(
      require.resolve('ecash-lib/dist/ffi/ecash_lib_wasm_browser.js'),
      'utf8',
    )
    .replace('import.meta.url', "'file:///unused-jest-wasm-loader'")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function('exports', compiled)(exports)
  return exports
})
jest.mock('ecash-lib/dist/ffi/ecash_lib_wasm_bg_browser.js', () => {
  const fs = jest.requireActual('node:fs')
  const source = fs.readFileSync(
    require.resolve('ecash-lib/dist/ffi/ecash_lib_wasm_bg_browser.js'),
    'utf8',
  )
  return { ECASH_LIB_WASM_BASE64: source.match(/`([\s\S]*?)`/)[1] }
})
import * as ecashSeedBoundary from '@frank/wallet/ecash-seed-boundary'
import type { EcashStealthCustody } from '@frank/wallet/ecash-stealth'
import { secp256k1 } from '@noble/curves/secp256k1'
import { lockingScript, parseTransaction } from '@frank/nakamoto'
import { BIP39_RECOVERY_FORMAT } from '@frank/account-vault'
import { createUtxoChain } from '@frank/wallet/chain/utxo-chain'
import type { RelayUtxoChain } from '@frank/wallet/chain/utxo-family'
import {
  UtxoWallet,
  UTXO_NETWORKS,
  memoryUtxoWalletStore,
  parseUtxoAddress,
  type IndexedOutput,
  type UtxoIndexer,
} from '@frank/wallet/utxo-wallet'
import {
  deriveUtxoStealthDestination,
  type UtxoStealthCustody,
  type UtxoStealthDerivation,
} from '@frank/wallet/utxo-stealth'
import { activeChain, EvmNativeJournalError } from '@frank/wallet/chain'
import {
  AccountBackupUnavailableError,
  accountSession,
  createAccountSession,
  importBip39Wallet,
  resetAccountStorage,
  type RuntimeWallet,
} from './session'
import { watch } from 'vue'
import { importBip39Wallet as legacyImport } from './legacy'
import {
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type PublicAccount,
} from './custody'
import {
  DOMAIN_PURPOSES,
  DERIVATION_REGISTRY_ID,
  type DomainRoot,
} from '@frank/domain-roots'
import { MonadIdentity } from '@frank/wallet/monad-identity'

jest.mock('@frank/wallet/chain', () => {
  const actual = jest.requireActual('@frank/wallet/chain')
  return {
    ...actual,
    activeChain: {
      createWallet: jest.fn(),
      isTestnet: true,
      chainIdentifier: 'monad-testnet',
      addressToString: (address: { raw: string }) => address.raw,
    },
  }
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  const account = {
    displayName: 'Fixture',
    descriptor: 'public',
    receipt: { operationId: 'attempt-a', context: { accountId: 'a' } },
  } as PublicAccount
  let snapshot: CustodySnapshot = {
    schema: 1,
    revision: 1,
    active: account,
    pending: null,
  }
  const owned = DOMAIN_PURPOSES.map((purpose, i) => ({
    registry: DERIVATION_REGISTRY_ID,
    purpose,
    bytes: new Uint8Array(32).fill(i + 1),
  }))
  const capability = {
    account,
    takeRoots: jest.fn(() => owned),
    close: jest.fn(),
  }
  const custody = {
    snapshot: jest.fn(async () => snapshot),
    reconcile: jest.fn(async () => 'ready'),
    openActive: jest.fn(async () => capability),
    openPending: jest.fn(async () =>
      DOMAIN_PURPOSES.map((purpose, i) => ({
        registry: DERIVATION_REGISTRY_ID,
        purpose,
        bytes: new Uint8Array(32).fill(i + 1),
      })),
    ),
    stage: jest.fn(),
    activate: jest.fn(),
    cancel: jest.fn(),
    close: jest.fn(),
  } as unknown as jest.Mocked<AccountCustody>
  const wallet = {
    chainIdentifier: 'monad-testnet',
    close: jest.fn(async () => undefined),
    identity: {
      compressedPubKey: new Uint8Array(33).fill(0x02),
    },
  } as unknown as RuntimeWallet
  const createWallet = jest.fn(async () => wallet)
  let invalidate!: () => void
  const unlisten = jest.fn()
  const session = createAccountSession({
    listen: callback => {
      invalidate = callback
      return unlisten
    },
    open: async () => custody,
    createWallet,
  })
  return {
    session,
    custody,
    createWallet,
    owned,
    capability,
    wallet,
    invalidate: () => invalidate(),
    unlisten,
    set: (next: CustodySnapshot) => {
      snapshot = next
    },
    account,
  }
}
test('opens the active capability once, maps typed roots, wipes copies and revalidates acquisitions of one owned wallet', async () => {
  const f = fixture()
  await Promise.all([f.session.initialize(), f.session.initialize()])
  expect(f.capability.takeRoots).toHaveBeenCalledTimes(1)
  expect(f.createWallet.mock.calls[0][0]).toMatchObject({
    evm: { purpose: 'evm-wallet' },
    authentication: { purpose: 'identity-authentication' },
    messaging: { purpose: 'messaging-encryption' },
  })
  expect(f.owned.every(root => root.bytes.every(byte => byte === 0))).toBe(true)
  expect(await f.session.getWallet()).toBe(await f.session.getWallet())
  expect(await f.session.getWallet()).toBe(f.wallet)
  expect(JSON.stringify(f.session.state)).not.toMatch(
    /bytes|roots|private|mnemonic/,
  )
  await f.session.close()
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
})
test('a synchronous status watcher cannot reacquire before retired-wallet teardown completes', async () => {
  const f = fixture(),
    teardown = deferred<void>()
  await f.session.initialize()
  const next = {
    ...f.account,
    receipt: {
      ...f.account.receipt,
      context: { ...f.account.receipt.context, accountId: 'b' },
    },
  }
  f.set({ schema: 1, revision: 2, active: next, pending: null })
  f.capability.account = next
  jest.mocked(f.wallet.close).mockReturnValue(teardown.promise)
  const replacement = {
    close: jest.fn(async () => undefined),
  } as unknown as RuntimeWallet
  f.createWallet.mockResolvedValue(replacement)
  let acquiring: Promise<RuntimeWallet> | undefined
  const unwatch = watch(
    () => f.session.state.status,
    status => {
      if (status === 'loading') acquiring = f.session.getWallet()
    },
    { flush: 'sync' },
  )
  f.invalidate()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(f.createWallet).toHaveBeenCalledTimes(1)
  teardown.resolve()
  expect(await acquiring).toBe(replacement)
  unwatch()
})
test('pending readable material stays pending across initialization and does not construct a wallet or activate', async () => {
  const f = fixture()
  f.set({
    schema: 1,
    revision: 0,
    active: null,
    pending: {
      status: 'staging',
      account: f.account,
      expectedActive: { revision: 0, accountId: null },
    },
  })
  await f.session.initialize()
  expect(f.session.state.status).toBe('pending')
  expect(f.session.state.pendingReady).toBe(true)
  // The identity that Activate would open is published, read from the staged material.
  const staged = (await f.custody.openPending('attempt-a')).find(
    root => root.purpose === 'identity-authentication',
  )
  expect(f.session.state.pendingIdentityAddress).toBe(
    MonadIdentity.fromDomainRoot(
      staged as DomainRoot<'identity-authentication'>,
    ).displayAddress,
  )
  expect(f.createWallet).not.toHaveBeenCalled()
  expect(f.custody.activate).not.toHaveBeenCalled()
})
test('an attempt whose identity cannot be read is not offered for activation', async () => {
  const f = fixture()
  f.set({
    schema: 1,
    revision: 0,
    active: null,
    pending: {
      status: 'staging',
      account: f.account,
      expectedActive: { revision: 0, accountId: null },
    },
  })
  f.custody.openPending.mockRejectedValue(new CustodyError('locked'))
  await f.session.initialize()
  expect(f.session.state.status).toBe('pending')
  expect(f.session.state.pendingReady).toBe(false)
  expect(f.session.state.pendingIdentityAddress).toBeNull()
  expect(f.session.state.pendingError).toBe('locked')
})
test('locked or missing staged material is never interpreted as a fresh account', async () => {
  const f = fixture()
  f.set({
    schema: 1,
    revision: 0,
    active: null,
    pending: {
      status: 'staging',
      account: f.account,
      expectedActive: { revision: 0, accountId: null },
    },
  })
  f.custody.reconcile.mockResolvedValue('incomplete')
  await f.session.initialize()
  expect(f.session.state.status).toBe('pending')
  expect(f.session.state.pendingReady).toBe(false)
  f.custody.reconcile.mockRejectedValue(new CustodyError('locked'))
  await f.session.retry()
  expect(f.session.state.status).toBe('pending')
  expect(f.session.state.pendingError).toBe('locked')
  expect(f.session.state.pending).not.toBeNull()
  expect(f.createWallet).not.toHaveBeenCalled()
})
test('a close while wallet construction is suspended closes the stale candidate and wipes all roots', async () => {
  const f = fixture(),
    ready = deferred<RuntimeWallet>()
  f.createWallet.mockReturnValue(ready.promise)
  const opening = f.session.initialize()
  for (let n = 0; n < 10; n++) await Promise.resolve()
  expect(f.createWallet).toHaveBeenCalledTimes(1)
  const closing = f.session.close()
  ready.resolve(f.wallet)
  await Promise.all([opening, closing])
  await expect(f.session.getWallet()).rejects.toThrow()
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
  expect(f.owned.every(root => root.bytes.every(byte => byte === 0))).toBe(true)
})
test('an active pointer changed during wallet construction prevents stale publication', async () => {
  const f = fixture(),
    ready = deferred<RuntimeWallet>()
  f.createWallet.mockReturnValue(ready.promise)
  const opening = f.session.initialize()
  for (let n = 0; n < 10; n++) await Promise.resolve()
  f.set({
    schema: 1,
    revision: 2,
    active: {
      ...f.account,
      receipt: {
        ...f.account.receipt,
        context: { ...f.account.receipt.context, accountId: 'b' },
      },
    },
    pending: null,
  })
  ready.resolve(f.wallet)
  await opening
  expect(f.session.state.status).toBe('locked')
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
  await expect(f.session.getWallet()).rejects.toThrow()
})
test('failed activation preserves the old active account and reopens its wallet', async () => {
  const f = fixture()
  const pendingAccount = {
    ...f.account,
    receipt: {
      ...f.account.receipt,
      operationId: 'attempt-b',
      context: { ...f.account.receipt.context, accountId: 'b' },
    },
  }
  f.set({
    schema: 1,
    revision: 1,
    active: f.account,
    pending: {
      status: 'staging',
      account: pendingAccount,
      expectedActive: { revision: 1, accountId: 'a' },
    },
  })
  await f.session.initialize()
  f.custody.activate.mockRejectedValue(new CustodyError('storage-failed'))
  await expect(
    f.session.activatePending('attempt-b', { revision: 1, accountId: 'a' }),
  ).rejects.toThrow()
  expect(f.session.state.account?.receipt.context.accountId).toBe('a')
  expect(f.session.state.status).toBe('ready')
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
  expect(f.createWallet).toHaveBeenCalledTimes(2)
})
test('closing during a staged write prevents its late public snapshot from publishing', async () => {
  const f = fixture()
  await f.session.initialize()
  const write = deferred<CustodySnapshot>()
  f.custody.stage.mockReturnValue(write.promise)
  const staging = f.session.stage({} as never)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const closing = f.session.close()
  write.resolve({ schema: 1, revision: 999, active: f.account, pending: null })
  await expect(staging).rejects.toThrow()
  await closing
  expect(f.session.state.revision).toBe(1)
  expect(f.session.state.status).toBe('locked')
  expect(f.custody.close).toHaveBeenCalledTimes(1)
})
test('custody closes even if runtime teardown fails', async () => {
  const f = fixture()
  await f.session.initialize()
  jest
    .mocked(f.wallet.close)
    .mockRejectedValue(new Error('teardown unavailable'))
  await expect(f.session.close()).rejects.toThrow()
  expect(f.custody.close).toHaveBeenCalledTimes(1)
  await expect(f.session.getWallet()).rejects.toThrow()
})
test('ordinary acquisition detects an external replacement and closes the old wallet before returning the new one', async () => {
  const f = fixture()
  await f.session.initialize()
  const next = {
    ...f.account,
    receipt: {
      ...f.account.receipt,
      context: { ...f.account.receipt.context, accountId: 'b' },
    },
  }
  f.set({ schema: 1, revision: 2, active: next, pending: null })
  f.capability.account = next
  const replacement = {
    close: jest.fn(async () => undefined),
  } as unknown as RuntimeWallet
  f.createWallet.mockResolvedValue(replacement)
  expect(await f.session.getWallet()).toBe(replacement)
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
  expect(f.session.state.revision).toBe(2)
})
test('cross-context invalidation revokes immediately and fences a suspended old constructor', async () => {
  const f = fixture(),
    ready = deferred<RuntimeWallet>()
  f.createWallet.mockReturnValueOnce(ready.promise)
  const opening = f.session.initialize()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  f.set({ schema: 1, revision: 2, active: null, pending: null })
  f.invalidate()
  expect(f.session.state.status).toBe('loading')
  ready.resolve(f.wallet)
  await opening
  await f.session.retry()
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
  expect(f.session.state.status).toBe('fresh')
  await expect(f.session.getWallet()).rejects.toThrow()
  await f.session.close()
  expect(f.unlisten).toHaveBeenCalledTimes(1)
})
test('failed pending cleanup leaves independently authenticated active account usable and retry clears the pending error', async () => {
  const f = fixture()
  await f.session.initialize()
  f.set({
    schema: 1,
    revision: 1,
    active: f.account,
    pending: {
      status: 'discarding',
      account: f.account,
      expectedActive: { revision: 1, accountId: 'a' },
    },
  })
  f.custody.reconcile.mockRejectedValueOnce(new CustodyError('storage-failed'))
  await f.session.retry()
  expect(f.session.state.status).toBe('ready')
  expect(f.session.state.pendingError).toBe('storage-failed')
  expect(f.custody.openActive).toHaveBeenCalledTimes(2)
  expect(f.wallet.close).not.toHaveBeenCalled()
  await f.session.retry()
  expect(f.session.state.pendingError).toBeNull()
})

test('an unchanged account keeps its published identity across wallet acquisitions, and a replacement changes it', async () => {
  const f = fixture()
  // Real custody builds a new snapshot object on every read.
  const fresh = (revision: number, accountId: string): CustodySnapshot => ({
    schema: 1,
    revision,
    active: {
      ...f.account,
      receipt: { operationId: 'attempt-' + accountId, context: { accountId } },
    } as PublicAccount,
    pending: null,
  })
  f.custody.snapshot.mockImplementation(async () => fresh(1, 'a'))
  await f.session.initialize()
  const account = f.session.state.account,
    revision = f.session.state.revision
  await f.session.getWallet()
  await f.session.getWallet()
  expect(f.session.state.account).toBe(account)
  expect(f.session.state.revision).toBe(revision)
  f.custody.snapshot.mockImplementation(async () => fresh(2, 'b'))
  f.capability.account = fresh(2, 'b').active as PublicAccount
  await f.session.getWallet()
  expect(f.session.state.account).not.toBe(account)
  expect(f.session.state.account?.receipt.context.accountId).toBe('b')
})

test('backupCodex32 splits only the stored account root and never falls back to a derived root', async () => {
  const f = fixture()
  await f.session.initialize()
  const exportAccountRoot = jest.fn()
  Object.assign(f.custody, { exportAccountRoot })

  // An account stored before roots were kept: an honest refusal, no shares.
  exportAccountRoot.mockResolvedValue({ account: f.account, accountRoot: null })
  await expect(f.session.backupCodex32(2, 3)).rejects.toBeInstanceOf(
    AccountBackupUnavailableError,
  )
  expect(f.capability.takeRoots).toHaveBeenCalledTimes(1)

  // Custody answering for another account is a conflict, whatever it holds.
  exportAccountRoot.mockResolvedValue({
    account: { ...f.account, receipt: { context: { accountId: 'other' } } },
    accountRoot: new Uint8Array(32).fill(7),
  })
  await expect(f.session.backupCodex32(2, 3)).rejects.toMatchObject({
    code: 'conflict',
  })

  // The removed derived-root shortcut is gone from the session.
  expect('getActiveWalletRoot' in f.session).toBe(false)
  // The domain roots are not read again for a backup.
  expect(f.capability.takeRoots).toHaveBeenCalledTimes(1)
})

test('getActiveDomainRoot and getChainAddress derive valid addresses for ecash and solana', async () => {
  const f = fixture()
  f.capability.takeRoots = jest.fn(() =>
    DOMAIN_PURPOSES.map((purpose, i) => ({
      registry: DERIVATION_REGISTRY_ID,
      purpose,
      bytes: new Uint8Array(32).fill(i + 1),
    })),
  )
  await f.session.initialize()

  const ecashRoot = await f.session.getActiveDomainRoot('ecash-bch-wallet')
  expect(ecashRoot).toBeInstanceOf(Uint8Array)
  expect(ecashRoot.length).toBe(32)

  const ecashAddr = await f.session.getChainAddress('ecash')
  expect(ecashAddr.startsWith('ectest:')).toBe(true)

  const solanaAddr = await f.session.getChainAddress('solana')
  expect(typeof solanaAddr).toBe('string')
  expect(solanaAddr.length).toBeGreaterThan(30)

  const btcAddr = await f.session.getChainAddress('bitcoin')
  expect(btcAddr.startsWith('tb1q')).toBe(true)

  const bchAddr = await f.session.getChainAddress('bitcoincash')
  expect(bchAddr.startsWith('bchtest:')).toBe(true)

  const dogeAddr = await f.session.getChainAddress('dogecoin')
  expect(dogeAddr.startsWith('n')).toBe(true)

  // Verify caching and synchronous retrieval
  expect(f.session.getCachedChainAddress('ecash')).toBe(ecashAddr)
  expect(f.session.getCachedChainAddress('solana')).toBe(solanaAddr)
  expect(f.session.getCachedChainAddress('bitcoin')).toBe(btcAddr)
  expect(f.session.getCachedChainAddress('bitcoincash')).toBe(bchAddr)
  expect(f.session.getCachedChainAddress('dogecoin')).toBe(dogeAddr)

  const initialTakeRootsCalls = f.capability.takeRoots.mock.calls.length
  const cachedEcash = await f.session.getChainAddress('ecash')
  expect(cachedEcash).toBe(ecashAddr)
  expect(f.capability.takeRoots).toHaveBeenCalledTimes(initialTakeRootsCalls)
})

test.each(['ethereum', 'tempo', 'hyperliquid'])(
  'shows the wallet receive address for %s, not stamp-pool account 0',
  async chain => {
    const f = fixture()
    // Custody hands out a fresh copy each time; the session clears what it was given.
    const roots = () =>
      DOMAIN_PURPOSES.map((purpose, i) => ({
        registry: DERIVATION_REGISTRY_ID,
        purpose,
        bytes: new Uint8Array(32).fill(i + 1),
      }))
    const evmRoot = roots().find(root => root.purpose === 'evm-wallet')!.bytes
    f.capability.takeRoots = jest.fn(roots)
    await f.session.initialize()

    const { HDNodeWallet } = await import('ethers')
    const master = HDNodeWallet.fromSeed(evmRoot)
    const address = await f.session.getChainAddress(chain)
    expect(address).toBe(master.derivePath("m/44'/60'/1'/0/0").address)
    expect(address).not.toBe(master.derivePath("m/44'/60'/0'/0/0").address)
  },
)

test('resolves and isolates testnet vs mainnet addresses by canonical network ID', async () => {
  const f = fixture()
  f.capability.takeRoots = jest.fn(() =>
    DOMAIN_PURPOSES.map((purpose, i) => ({
      registry: DERIVATION_REGISTRY_ID,
      purpose,
      bytes: new Uint8Array(32).fill(i + 1),
    })),
  )
  await f.session.initialize()

  const btcTestnet = await f.session.getChainAddress('btc-testnet')
  const btcMainnet = await f.session.getChainAddress('btc-mainnet')
  expect(btcTestnet.startsWith('tb1q')).toBe(true)
  expect(btcMainnet.startsWith('bc1q')).toBe(true)
  expect(btcTestnet).not.toBe(btcMainnet)

  expect(f.session.getCachedChainAddress('btc-testnet')).toBe(btcTestnet)
  expect(f.session.getCachedChainAddress('btc-mainnet')).toBe(btcMainnet)

  const xecTestnet = await f.session.getChainAddress('xec-testnet')
  const xecMainnet = await f.session.getChainAddress('xec-mainnet')
  expect(xecTestnet.startsWith('ectest:')).toBe(true)
  expect(xecMainnet.startsWith('ecash:')).toBe(true)
  expect(xecTestnet).not.toBe(xecMainnet)
})

test('getCurvePublicKey and getCachedCurvePublicKey derive and cache public keys for secp256k1 and ed25519', async () => {
  const f = fixture()
  f.capability.takeRoots = jest.fn(() =>
    DOMAIN_PURPOSES.map((purpose, i) => ({
      registry: DERIVATION_REGISTRY_ID,
      purpose,
      bytes: new Uint8Array(32).fill(i + 1),
    })),
  )
  await f.session.initialize()

  const secpKey = await f.session.getCurvePublicKey('secp256k1')
  expect(secpKey).toBeInstanceOf(Uint8Array)
  expect(secpKey.length).toBe(33)
  expect(secpKey[0]).toBe(0x02)

  const edKey = await f.session.getCurvePublicKey('ed25519')
  expect(edKey).toBeInstanceOf(Uint8Array)
  expect(edKey.length).toBe(32)

  // Verify caching and synchronous retrieval
  expect(f.session.getCachedCurvePublicKey('secp256k1')).toEqual(secpKey)
  expect(f.session.getCachedCurvePublicKey('ed25519')).toEqual(edKey)

  const initialTakeRootsCalls = f.capability.takeRoots.mock.calls.length
  const cachedEd = await f.session.getCurvePublicKey('ed25519')
  expect(cachedEd).toEqual(edKey)
  expect(f.capability.takeRoots).toHaveBeenCalledTimes(initialTakeRootsCalls)
})

test('reset closes existing wallet and custody, calls deps.reset, and reinitializes session to fresh', async () => {
  const f = fixture()
  await f.session.initialize()
  expect(f.session.state.status).toBe('ready')

  const resetMock = jest.fn(async () => {
    f.set({
      schema: 1,
      revision: 0,
      active: null,
      pending: null,
    })
  })

  const notifyMock = jest.fn()
  // Create session with custom reset dependency
  const session = createAccountSession({
    open: async () => f.custody,
    createWallet: f.createWallet,
    notify: notifyMock,
    reset: resetMock,
  })

  await session.initialize()
  expect(session.state.status).toBe('ready')

  await session.reset()
  expect(resetMock).toHaveBeenCalledTimes(1)
  expect(notifyMock).toHaveBeenCalled()
  expect(session.state.status).toBe('fresh')
  expect(session.state.account).toBeNull()
  expect(session.state.error).toBeNull()
})

test('resetAccountStorage deletes all indexedDB databases matching frank- and level-js', async () => {
  const deleted: string[] = []
  const originalIndexedDb = global.indexedDB

  const mockIndexedDb = {
    databases: jest.fn(async () => [
      { name: 'frank-account-custody-local-account-v1' },
      { name: 'frank-preview-vault-local-account-v1' },
      { name: 'frank-monad-wallet-state-evm-0x123' },
      { name: 'level-js-wallet-manifest' },
      { name: 'unrelated-app-db' },
    ]),
    deleteDatabase: jest.fn((name: string) => {
      deleted.push(name)
      const req: any = {}
      setTimeout(() => req.onsuccess?.({} as any), 0)
      return req
    }),
  }

  try {
    ;(global as any).indexedDB = mockIndexedDb
    await resetAccountStorage('local-account-v1')
    expect(deleted).toContain('frank-account-custody-local-account-v1')
    expect(deleted).toContain('frank-preview-vault-local-account-v1')
    expect(deleted).toContain('frank-monad-wallet-state-evm-0x123')
    expect(deleted).toContain('level-js-wallet-manifest')
    expect(deleted).not.toContain('unrelated-app-db')
  } finally {
    ;(global as any).indexedDB = originalIndexedDb
  }
})

test('yieldCustody sets status to standby, releases wallet and custody, and retry restores ready status', async () => {
  const f = fixture()
  await f.session.initialize()
  expect(f.session.state.status).toBe('ready')
  expect(await f.session.getWallet()).toBe(f.wallet)

  await f.session.yieldCustody()
  expect(f.session.state.status).toBe('standby')
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
  expect(f.custody.close).toHaveBeenCalledTimes(1)

  // In standby, initialize() and invalidate() do not re-open custody
  await f.session.initialize()
  expect(f.session.state.status).toBe('standby')
  f.invalidate()
  expect(f.session.state.status).toBe('standby')

  // retry() explicitly reacquires custody and wallet
  await f.session.retry()
  expect(f.session.state.status).toBe('ready')
  expect(await f.session.getWallet()).toBeDefined()
})

test('setStandby suppresses background revalidate and custody acquisition', async () => {
  const f = fixture()
  f.session.setStandby()
  expect(f.session.state.status).toBe('standby')

  await f.session.initialize()
  expect(f.session.state.status).toBe('standby')
  expect(f.custody.openActive).not.toHaveBeenCalled()
})

test('BIP39 public import rejects a different identity path before any custody effects', async () => {
  const snapshot = jest.spyOn(accountSession, 'snapshot')
  try {
    for (const invoke of [importBip39Wallet, legacyImport])
      await expect(
        invoke(
          'test test test test test test test test test test test junk',
          "m/44'/60'/0'/0/0",
        ),
      ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(snapshot).not.toHaveBeenCalled()
  } finally {
    snapshot.mockRestore()
  }
})

async function replaceAccount(
  f: ReturnType<typeof fixture>,
  invalidate = false,
) {
  const account = {
    ...f.account,
    receipt: { operationId: 'attempt-b', context: { accountId: 'b' } },
  } as PublicAccount
  f.set({ schema: 1, revision: 2, active: account, pending: null })
  f.capability.account = account
  if (invalidate) f.invalidate()
  await f.session.retry()
  expect(f.session.state.account?.receipt.context.accountId).toBe('b')
}

const derivedPaths = [
  'xec-testnet',
  'btc-testnet',
  'bch-testnet',
  'doge-testnet',
  'solana-devnet',
  'ethereum-sepolia',
  'ed25519',
] as const
function derivation(
  f: ReturnType<typeof fixture>,
  path: (typeof derivedPaths)[number],
) {
  return {
    read: () =>
      path === 'ed25519'
        ? f.session.getCurvePublicKey(path)
        : f.session.getChainAddress(path),
    cached: () =>
      path === 'ed25519'
        ? f.session.getCachedCurvePublicKey(path)
        : f.session.getCachedChainAddress(path),
  }
}

describe.each(['refresh replacement', 'invalidation'] as const)(
  '%s',
  transition => {
    test.each(derivedPaths)(
      '%s rejects A without publishing or removing pending B',
      async path => {
        const f = fixture()
        await f.session.initialize()
        const a = deferred<Uint8Array>(),
          b = deferred<Uint8Array>()
        const roots = jest
          .spyOn(f.session, 'getActiveFamilyMaterial')
          .mockImplementationOnce(async purpose => ({
            registry: DERIVATION_REGISTRY_ID,
            purpose,
            bytes: await a.promise,
          }))
          .mockImplementationOnce(async purpose => ({
            registry: DERIVATION_REGISTRY_ID,
            purpose,
            bytes: await b.promise,
          }))
        const read = derivation(f, path)
        let displayed: string | Uint8Array | undefined
        const old = read.read().then(value => {
          displayed = value
        })
        const rejected = expect(old).rejects.toMatchObject({ code: 'closed' })
        await replaceAccount(f, transition === 'invalidation')
        const current = read.read()
        const oldRoot = new Uint8Array(32).fill(19)
        a.resolve(oldRoot)
        await rejected
        expect(displayed).toBeUndefined()
        expect(read.cached()).toBeUndefined()
        expect(oldRoot.every(byte => byte === 0)).toBe(true)
        const duplicate = read.read()
        expect(roots).toHaveBeenCalledTimes(2)
        const newRoot = new Uint8Array(32).fill(23)
        b.resolve(newRoot)
        const result = await current
        expect(await duplicate).toEqual(result)
        expect(read.cached()).toEqual(result)
        expect(newRoot.every(byte => byte === 0)).toBe(true)
        expect(await read.read()).toEqual(result)
        expect(roots).toHaveBeenCalledTimes(2)
      },
    )
  },
)

test.each(derivedPaths)(
  '%s rejects completion after close and preserves current errors and retry',
  async path => {
    const f = fixture()
    await f.session.initialize()
    const a = deferred<Uint8Array>()
    const roots = jest
      .spyOn(f.session, 'getActiveFamilyMaterial')
      .mockImplementationOnce(async purpose => ({
        registry: DERIVATION_REGISTRY_ID,
        purpose,
        bytes: await a.promise,
      }))
    const read = derivation(f, path)
    const failure = new Error('synthetic derivation failure')
    a.reject(failure)
    await expect(read.read()).rejects.toBe(failure)
    const pending = deferred<Uint8Array>()
    roots.mockImplementationOnce(async purpose => ({
      registry: DERIVATION_REGISTRY_ID,
      purpose,
      bytes: await pending.promise,
    }))
    const old = read.read()
    const rejected = expect(old).rejects.toMatchObject({ code: 'closed' })
    await f.session.close()
    const root = new Uint8Array(32).fill(29)
    pending.resolve(root)
    await rejected
    expect(read.cached()).toBeUndefined()
    expect(root.every(byte => byte === 0)).toBe(true)
    expect(roots).toHaveBeenCalledTimes(2)
  },
)

test.each(['close', 'refresh replacement', 'invalidation'] as const)(
  'domain-root acquisition rejects obsolete capabilities after %s',
  async transition => {
    const f = fixture()
    await f.session.initialize()
    const held = deferred<typeof f.capability>(),
      entered = deferred<void>()
    const oldRoots = DOMAIN_PURPOSES.map((purpose, i) => ({
      registry: DERIVATION_REGISTRY_ID,
      purpose,
      bytes: new Uint8Array(32).fill(i + 31),
    }))
    const oldCapability = {
      account: f.account,
      takeRoots: jest.fn(() => oldRoots),
      close: jest.fn(),
    }
    f.custody.openActive.mockImplementationOnce(() => {
      entered.resolve()
      return held.promise
    })
    const old = f.session.getActiveDomainRoot('solana-wallet')
    const rejected = expect(old).rejects.toMatchObject({ code: 'closed' })
    await entered.promise
    if (transition === 'close') await f.session.close()
    else await replaceAccount(f, transition === 'invalidation')
    let currentRoot: Uint8Array | undefined
    if (transition !== 'close') {
      f.capability.takeRoots.mockImplementation(() =>
        DOMAIN_PURPOSES.map(purpose => ({
          registry: DERIVATION_REGISTRY_ID,
          purpose,
          bytes: new Uint8Array(32).fill(37),
        })),
      )
      currentRoot = await f.session.getActiveDomainRoot('solana-wallet')
    }
    held.resolve(oldCapability)
    await rejected
    expect(oldCapability.close).toHaveBeenCalledTimes(1)
    // A revoked capability need not hand root material out at all.
    expect(oldCapability.takeRoots).not.toHaveBeenCalled()
    if (currentRoot) expect(currentRoot).toEqual(new Uint8Array(32).fill(37))
  },
)

test('domain-root reads preserve current errors and reject a different active account', async () => {
  const f = fixture()
  await f.session.initialize()
  const failure = new Error('synthetic custody failure')
  f.custody.openActive.mockRejectedValueOnce(failure)
  await expect(f.session.getActiveDomainRoot('solana-wallet')).rejects.toBe(
    failure,
  )
  const wrong = {
    ...f.capability,
    account: {
      ...f.account,
      receipt: { operationId: 'attempt-b', context: { accountId: 'b' } },
    } as PublicAccount,
    close: jest.fn(),
  }
  f.custody.openActive.mockResolvedValueOnce(wrong)
  await expect(
    f.session.getActiveDomainRoot('solana-wallet'),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(wrong.close).toHaveBeenCalledTimes(1)
})

test.each(['close', 'refresh replacement', 'invalidation'] as const)(
  'Monad receive-address completion cannot escape after %s',
  async transition => {
    const f = fixture()
    await f.session.initialize()
    const a = deferred<string>(),
      entered = deferred<void>()
    Object.assign(f.wallet, {
      getReceiveAddress: jest.fn(() => {
        entered.resolve()
        return a.promise
      }),
    })
    const old = f.session.getChainAddress('monad-testnet')
    const rejected = expect(old).rejects.toMatchObject({ code: 'closed' })
    await entered.promise
    if (transition === 'close') await f.session.close()
    else await replaceAccount(f, transition === 'invalidation')
    a.resolve('obsolete-receive-address')
    await rejected
    expect(f.session.getCachedChainAddress('monad-testnet')).toBeUndefined()
  },
)

test.each(['close', 'refresh replacement', 'invalidation'] as const)(
  'secp256k1 wallet acquisition cannot escape after %s',
  async transition => {
    const f = fixture()
    // Exercise acquisition before a cached identity key exists.
    Object.assign(f.wallet, { identity: {} })
    await f.session.initialize()
    const held = deferred<RuntimeWallet>()
    const acquire = jest
      .spyOn(f.session, 'getWallet')
      .mockReturnValueOnce(held.promise)
    const old = f.session.getCurvePublicKey('secp256k1')
    const rejected = expect(old).rejects.toMatchObject({ code: 'closed' })
    if (transition === 'close') await f.session.close()
    else await replaceAccount(f, transition === 'invalidation')
    held.resolve({
      identity: { compressedPubKey: new Uint8Array(33).fill(2) },
    } as unknown as RuntimeWallet)
    await rejected
    expect(f.session.getCachedCurvePublicKey('secp256k1')).toBeUndefined()
    acquire.mockRestore()
  },
)

test('initial root and secp256k1 requests survive initialization and current wallet errors propagate', async () => {
  const f = fixture()
  const [root, key, duplicate] = await Promise.all([
    f.session.getActiveDomainRoot('evm-wallet'),
    f.session.getCurvePublicKey('secp256k1'),
    f.session.getCurvePublicKey('secp256k1'),
  ])
  expect(root).toHaveLength(32)
  expect(key).toEqual(new Uint8Array(33).fill(0x02))
  expect(duplicate).toEqual(key)
  expect(f.createWallet).toHaveBeenCalledTimes(1)
  const empty = fixture()
  Object.assign(empty.wallet, { identity: {} })
  const failure = new Error('synthetic wallet failure')
  jest.spyOn(empty.session, 'getWallet').mockRejectedValueOnce(failure)
  await expect(empty.session.getCurvePublicKey('secp256k1')).rejects.toBe(
    failure,
  )
})

test('Monad receive-address errors propagate and a current retry publishes its address', async () => {
  const f = fixture()
  const failure = new Error('synthetic receive-address failure')
  const receive = jest
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce('current-receive-address')
  Object.assign(f.wallet, { getReceiveAddress: receive })
  await expect(f.session.getChainAddress('monad-testnet')).rejects.toBe(failure)
  expect(f.session.getCachedChainAddress('monad-testnet')).toBeUndefined()
  await expect(f.session.getChainAddress('monad-testnet')).resolves.toBe(
    'current-receive-address',
  )
  expect(f.session.getCachedChainAddress('monad-testnet')).toBe(
    'current-receive-address',
  )
})

test('network binding failure preserves the active account and retry reopens it without replacement', async () => {
  const f = fixture()
  f.createWallet.mockRejectedValueOnce(new EvmNativeJournalError('binding'))
  await f.session.initialize()
  expect(f.session.state.error).toBe('wallet-chain-mismatch')
  expect(f.session.state.status).toBe('unavailable')
  expect(f.session.state.revision).toBe(1)
  expect(f.session.state.account?.receipt.context.accountId).toBe('a')
  expect(f.session.state.pending).toBeNull()
  await f.session.retry()
  expect(f.session.state.status).toBe('ready')
  expect(f.session.state.error).toBeNull()
  expect(await f.session.getWallet()).toBe(f.wallet)
  expect(f.custody.stage).not.toHaveBeenCalled()
  expect(f.custody.activate).not.toHaveBeenCalled()
  await f.session.close()
})

test.each(['monad-regtest', 'monad-testnet'])(
  'reads the ready %s receive address locally with exact network affinity',
  async chainIdentifier => {
    const f = fixture()
    Object.assign(activeChain, { chainIdentifier })
    Object.assign(f.wallet, {
      chainIdentifier,
      getReceiveAddress: jest.fn(async () => ({
        raw: '0xowned-local-address',
      })),
    })
    await f.session.initialize()
    f.custody.snapshot.mockRejectedValue(
      new Error('runtime refresh unavailable'),
    )
    expect(await f.session.getChainAddress('monad')).toBe(
      '0xowned-local-address',
    )
    expect(await f.session.getChainAddress(chainIdentifier)).toBe(
      '0xowned-local-address',
    )
    expect(f.createWallet).toHaveBeenCalledTimes(1)
    await expect(
      f.session.getChainAddress(
        chainIdentifier === 'monad-regtest' ? 'monad-testnet' : 'monad-regtest',
      ),
    ).rejects.toMatchObject({ code: 'network-mismatch' })
    await f.session.close()
  },
)

test('a delayed local receive address is revoked when custody is invalidated', async () => {
  const f = fixture()
  const address = deferred<{ raw: string }>()
  Object.assign(activeChain, { chainIdentifier: 'monad-regtest' })
  Object.assign(f.wallet, {
    chainIdentifier: 'monad-regtest',
    getReceiveAddress: jest.fn(() => address.promise),
  })
  await f.session.initialize()
  const read = f.session.getChainAddress('monad-regtest')
  const rejected = expect(read).rejects.toMatchObject({ code: 'closed' })
  f.invalidate()
  address.resolve({ raw: '0xold-account' })
  await rejected
  await f.session.close()
})

describe('session-owned UTXO stealth custody', () => {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
  function realIdentityFixture(historical = false) {
    const f = fixture()
    const copies: Uint8Array[] = []
    const freshRoots = () =>
      DOMAIN_PURPOSES.map((purpose, i) => {
        const bytes = new Uint8Array(32).fill(i + 1)
        copies.push(bytes)
        return { registry: DERIVATION_REGISTRY_ID, purpose, bytes }
      })
    f.capability.takeRoots.mockImplementation(freshRoots)
    const seed = new Uint8Array(64).fill(37)
    if (historical) {
      Object.assign(f.account.receipt.context, {
        recoveryFormat: BIP39_RECOVERY_FORMAT,
      })
      Object.assign(f.capability, {
        takeBip39Seed: () => {
          const copy = new Uint8Array(seed)
          copies.push(copy)
          return copy
        },
      })
    }
    const auth = freshRoots().find(
      (r): r is DomainRoot<'identity-authentication'> =>
        r.purpose === 'identity-authentication',
    )!
    const identity = historical
      ? MonadIdentity.fromBip39Seed(seed)
      : MonadIdentity.fromDomainRoot(auth)
    Object.assign(f.wallet.identity, {
      compressedPubKey: identity.compressedPubKey,
    })
    copies.forEach(copy => copy.fill(0))
    return { ...f, copies, identity }
  }
  function relayFixture(
    chainIdentifier: string,
    store = memoryUtxoWalletStore(),
  ) {
    const unspent = new Map<string, IndexedOutput[]>()
    const indexer: UtxoIndexer = {
      listUnspent: async script => unspent.get(hex(script)) ?? [],
      hasHistory: async script => unspent.has(hex(script)),
      hasTransaction: async () => false,
      feeRate: async () => 2n,
      broadcast: async () => {
        throw new Error('test does not broadcast')
      },
    }
    const chain = createUtxoChain({
      chainIdentifier,
      indexer,
      storeFor: () => store,
    })
    let injected: UtxoStealthCustody | undefined
    const signed: {
      digest: Uint8Array
      signature: Uint8Array
      publicKey: Uint8Array
    }[] = []
    const relay: RelayUtxoChain = {
      chain,
      async createWallet(root, options) {
        injected = options?.stealthCustody
        const source = injected
        const stealthCustody = source && {
          identityPublicKey: source.identityPublicKey,
          assertActive: () => source.assertActive(),
          async deriveStealthSigner(derivation: UtxoStealthDerivation) {
            const key = await source.deriveStealthSigner(derivation)
            return {
              publicKey: key.publicKey,
              sign(digest: Uint8Array) {
                const signature = key.sign(digest)
                signed.push({
                  digest: new Uint8Array(digest),
                  signature,
                  publicKey: key.publicKey,
                })
                return signature
              },
            }
          },
        }
        return createUtxoChain({
          chainIdentifier,
          indexer,
          storeFor: () => store,
          stealthCustody,
        }).createWallet(root instanceof Uint8Array ? root : root.seed)
      },
      close: async () => undefined,
    }
    return { relay, indexer, unspent, store, signed, custody: () => injected! }
  }
  test.each(['btc-testnet', 'bch-testnet'])(
    'imports, reopens and signs an actual %s spend using the published identity',
    async chainIdentifier => {
      const f = realIdentityFixture()
      const r = relayFixture(chainIdentifier)
      const network = UTXO_NETWORKS[chainIdentifier]
      const receiver = (await f.session.createUtxoWallet(r.relay)) as UtxoWallet
      expect(hex(r.custody().identityPublicKey)).toBe(
        hex(f.identity.compressedPubKey),
      )
      expect(f.copies.every(copy => copy.every(byte => byte === 0))).toBe(true)
      const destination = deriveUtxoStealthDestination({
        network,
        identityPublicKey: f.identity.compressedPubKey,
        ephemeralSecret: new Uint8Array(32).fill(19),
      })
      const source = await UtxoWallet.create({
        network,
        seed: new Uint8Array(32).fill(71),
        indexer: r.indexer,
        storeFor: () => memoryUtxoWalletStore(),
      })
      const sourceScript = lockingScript(
        parseUtxoAddress(network, source.identity.address.raw)!,
      )
      r.unspent.set(hex(sourceScript), [
        { txid: 'a'.repeat(64), vout: 0, amount: 30_000n, height: 1 },
      ])
      const prepared = await source.prepareNativePayment({
        operationId: 'receipt-source',
        recipient: { raw: destination.address },
        value: 10_000n,
      })
      const receipt = {
        chainIdentifier,
        ephemeralPubKey: hex(destination.derivation.ephemeralPubKey),
        transactions: prepared.transaction.rawTransactions,
        claimedAmount: 10_000n,
        payloadDigest: 'c'.repeat(64),
        timestampMs: 1,
      }
      await receiver.recordStealthPayment(receipt)
      expect(await receiver.getBalance()).toBe(0n)
      const parsed = parseTransaction(
        Uint8Array.from(Buffer.from(receipt.transactions[0], 'hex')),
        network.descriptor,
      )
      if (!parsed.ok) throw new Error('Invalid prepared transaction')
      const vout = parsed.value.outputs.findIndex(
        output => hex(output.scriptPubKey) === hex(destination.scriptPubKey),
      )
      // Only observed indexer funds, never the message claim, become spendable.
      r.unspent.set(hex(destination.scriptPubKey), [
        { txid: prepared.transaction.txHash, vout, amount: 10_000n, height: 1 },
      ])
      const oldSigner = await r
        .custody()
        .deriveStealthSigner(destination.derivation)
      await f.session.close()
      expect(() => oldSigner.sign(new Uint8Array(32))).toThrow()
      const reopenedSession = realIdentityFixture()
      const reopened = (await reopenedSession.session.createUtxoWallet(
        r.relay,
      )) as UtxoWallet
      await reopened.recordStealthPayment(receipt)
      expect(await reopened.getBalance()).toBe(10_000n)
      expect(reopened.coins()).toHaveLength(1)
      const spend = await reopened.prepareNativePayment({
        operationId: 'respend',
        recipient: source.identity.address,
        value: 5_000n,
      })
      expect(spend.transaction.rawTransactions).toHaveLength(1)
      expect(r.signed).toHaveLength(1)
      for (const signed of r.signed) {
        expect(hex(signed.publicKey)).toBe(hex(destination.publicKey))
        expect(
          secp256k1.verify(
            secp256k1.Signature.fromDER(signed.signature),
            signed.digest,
            signed.publicKey,
          ),
        ).toBe(true)
        expect(spend.transaction.rawTransactions[0]).toContain(
          hex(signed.signature),
        )
      }
      await reopenedSession.session.close()
    },
  )
  test.each([false, true])(
    'revokes derived signers when an account is replaced (invalidation %s)',
    async invalidate => {
      const f = realIdentityFixture(),
        r = relayFixture('btc-testnet')
      await f.session.createUtxoWallet(r.relay)
      const destination = deriveUtxoStealthDestination({
        network: UTXO_NETWORKS['btc-testnet'],
        identityPublicKey: f.identity.compressedPubKey,
        ephemeralSecret: new Uint8Array(32).fill(19),
      })
      const signer = await r
        .custody()
        .deriveStealthSigner(destination.derivation)
      await replaceAccount(f, invalidate)
      expect(() => signer.sign(new Uint8Array(32))).toThrow()
      await expect(
        r.custody().deriveStealthSigner(destination.derivation),
      ).rejects.toThrow()
      await f.session.close()
    },
  )
  test('historical seed uses the unchanged published identity owner; wrong identity/chain/point fail closed', async () => {
    const f = realIdentityFixture(true),
      r = relayFixture('bch-testnet')
    await f.session.createUtxoWallet(r.relay)
    const destination = deriveUtxoStealthDestination({
      network: UTXO_NETWORKS['bch-testnet'],
      identityPublicKey: f.identity.compressedPubKey,
      ephemeralSecret: new Uint8Array(32).fill(19),
    })
    const key = await r.custody().deriveStealthSigner(destination.derivation)
    expect(hex(key.publicKey)).toBe(hex(destination.publicKey))
    const digest = new Uint8Array(32).fill(3)
    expect(
      secp256k1.verify(
        secp256k1.Signature.fromDER(key.sign(digest)),
        digest,
        destination.publicKey,
      ),
    ).toBe(true)
    await expect(
      r.custody().deriveStealthSigner({
        ...destination.derivation,
        chainIdentifier: 'btc-testnet',
      }),
    ).rejects.toThrow()
    await expect(
      r.custody().deriveStealthSigner({
        ...destination.derivation,
        identityPublicKey: new Uint8Array(33).fill(2),
      }),
    ).rejects.toThrow()
    await expect(
      r.custody().deriveStealthSigner({
        ...destination.derivation,
        ephemeralPubKey: new Uint8Array(33),
      }),
    ).rejects.toThrow()
    expect(f.copies.every(copy => copy.every(byte => byte === 0))).toBe(true)
    await f.session.close()
  })
  test('rejects a custody identity that differs from the published runtime identity before constructing a wallet', async () => {
    const f = realIdentityFixture(),
      r = relayFixture('btc-testnet')
    Object.assign(f.wallet.identity, {
      compressedPubKey: new Uint8Array(33).fill(2),
    })
    await expect(f.session.createUtxoWallet(r.relay)).rejects.toThrow()
    expect(r.custody()).toBeUndefined()
    expect(f.copies.every(copy => copy.every(byte => byte === 0))).toBe(true)
    await f.session.close()
  })
  test.each(['fee read', 'before selection'])(
    'revokes real HD sender preparation after session invalidation during %s',
    async boundary => {
      const f = realIdentityFixture(),
        r = relayFixture('btc-testnet')
      const sender = (await f.session.createUtxoWallet(r.relay)) as UtxoWallet
      const script = lockingScript(
        parseUtxoAddress(
          UTXO_NETWORKS['btc-testnet'],
          sender.identity.address.raw,
        )!,
      )
      r.unspent.set(hex(script), [
        { txid: 'a'.repeat(64), vout: 0, amount: 30_000n, height: 1 },
      ])
      await sender.getBalance()
      if (boundary === 'fee read') {
        r.indexer.feeRate = async () => {
          f.invalidate()
          return 2n
        }
      } else {
        const seam = sender as unknown as { sync(): Promise<void> }
        const sync = seam.sync.bind(sender)
        jest.spyOn(seam, 'sync').mockImplementationOnce(async () => {
          await sync()
          f.invalidate()
        })
      }
      const before = r.store.load()
      await expect(
        sender.stealthPayments!.prepare({
          operationId: 'closed-sender',
          chainIdentifier: 'btc-testnet',
          asset: { kind: 'native' },
          recipientSpendPublicKey: f.identity.compressedPubKey,
          amountAtomic: 10_000n,
          maxNativeFeeAtomic: 5_000n,
        }),
      ).rejects.toThrow()
      expect(r.store.load()).toBe(before)
      expect(await sender.getNativePayments()).toEqual([])
      await f.session.close()
    },
  )
  test('account invalidation during construction revokes the captured capability and wipes material', async () => {
    const f = realIdentityFixture(),
      r = relayFixture('btc-testnet')
    const original = r.relay.createWallet
    let captured: UtxoStealthCustody | undefined
    r.relay.createWallet = async (root, options) => {
      captured = options?.stealthCustody
      const result = await original(root, options)
      f.invalidate()
      return result
    }
    await expect(f.session.createUtxoWallet(r.relay)).rejects.toThrow()
    expect(f.copies.every(copy => copy.every(byte => byte === 0))).toBe(true)
    await expect(
      captured!.deriveStealthSigner({
        chainIdentifier: 'btc-testnet',
        identityPublicKey: f.identity.compressedPubKey,
        ephemeralPubKey: f.identity.compressedPubKey,
      }),
    ).rejects.toThrow()
    await f.session.close()
  })
  test.each([false, true])(
    'session private eCash factories restore and respend actual SDK stealth coins (historical=%s)',
    async historical => {
      const { Wallet } = jest.requireActual('ecash-wallet')
      const { HdNode, Ecc, Address, Tx, UnsignedTx, ALL_BIP143, sha256d } =
        jest.requireActual('ecash-lib')
      const { EcashWallet, ECASH_TESTNET_CHECKPOINT_HASH } = jest.requireActual(
        '@frank/wallet/ecash-wallet',
      )
      const { EcashSdkBackend } = jest.requireActual(
        '@frank/wallet/ecash-sdk-backend',
      )
      const { InMemoryEcashOperationStore } = jest.requireActual(
        '@frank/wallet/ecash-operation-store',
      )
      const { InMemoryNativeTransactionAttemptStore } = jest.requireActual(
        '@frank/wallet/chain/chain-wallet',
      )
      const { deriveEcashStealthDestination } = jest.requireActual(
        '@frank/wallet/ecash-stealth',
      )
      const { createEcashSeedBackend, createEcashBip39SeedBackend } =
        jest.requireActual('@frank/wallet/ecash-seed-boundary')
      const store = new InMemoryEcashOperationStore()
      const coins: unknown[] = []
      const chronik = {
        proxyInterface: () => ({
          getEndpointArray: () => [{ url: 'http://127.0.0.1:1' }],
        }),
        blockchainInfo: async () => ({ tipHeight: 900000 }),
        batchSummary: async (scripts: unknown[]) =>
          scripts.map(() => ({ numTxs: 0, numUtxos: 0 })),
        batchUtxos: async (scripts: { payload: string }[]) =>
          scripts.map(s => ({
            utxos: { outputScript: '76a914' + s.payload + '88ac', utxos: [] },
          })),
        script: (_type: string, payload: string) => ({
          utxos: async () => ({
            outputScript: '76a914' + payload + '88ac',
            utxos: payload === destinationPkh ? coins : [],
          }),
        }),
        broadcastTx: async () => {
          throw new Error('network forbidden')
        },
      }
      let destinationPkh = ''
      const broadcasts: string[][] = []
      let factoryOptions: Parameters<RelayUtxoChain['createWallet']>[1]
      const relay: RelayUtxoChain = {
        chain: { chainIdentifier: 'xec-testnet' } as RelayUtxoChain['chain'],
        createWallet: async (material, options) => {
          factoryOptions = options
          return EcashWallet.fromDerivationMaterial({
            material:
              material instanceof Uint8Array
                ? {
                    registry: DERIVATION_REGISTRY_ID,
                    purpose: 'ecash-bch-wallet',
                    bytes: material,
                  }
                : material,
            networkId: 'xec-testnet',
            chronik,
            operationStore: store,
            nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
            checkpointClientFactory: () => ({
              block: async () => ({
                blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH },
              }),
            }),
            rebroadcast: async (raws: string[]) => {
              broadcasts.push([...raws])
            },
            walletFactory: options?.ecashWalletFactory,
            bip39WalletFactory: options?.ecashBip39WalletFactory,
          })
        },
        close: async () => undefined,
      }
      const f = realIdentityFixture(historical)
      await f.session.initialize()
      const first = (await f.session.createUtxoWallet(relay)) as InstanceType<
        typeof EcashWallet
      >
      expect(factoryOptions?.ecashWalletFactory).toEqual(expect.any(Function))
      expect(factoryOptions?.ecashBip39WalletFactory).toEqual(
        expect.any(Function),
      )
      expect(factoryOptions?.stealthCustody).toBeUndefined()
      // Baseline SDK factory uses the unchanged family HD root/seed, independently of Frank identity.
      const baseline = historical
        ? await createEcashBip39SeedBackend(
            {
              derivation: 'frank-bip39-bip32-v1',
              seed: new Uint8Array(64).fill(37),
            },
            chronik,
            'ectest',
          )
        : await createEcashSeedBackend({
            domainRoot: {
              registry: DERIVATION_REGISTRY_ID,
              purpose: 'ecash-bch-wallet',
              bytes: new Uint8Array(32).fill(
                DOMAIN_PURPOSES.indexOf('ecash-bch-wallet') + 1,
              ),
            },
            chronik,
            addressPrefix: 'ectest',
          })
      expect(first.identity.address.raw).toBe(baseline.getReceiveAddress(0))
      const destination = deriveEcashStealthDestination({
        chainIdentifier: 'xec-testnet',
        addressPrefix: 'ectest',
        identityPublicKey: hex(f.identity.compressedPubKey),
        ephemeralSecret: new Uint8Array(32).fill(17),
      })
      const destinationScript = Address.fromCashAddress(
        destination.address,
      ).toScript()
      destinationPkh = destinationScript.toHex().slice(6, 46)
      const hd = HdNode.fromSeed(new Uint8Array(32).fill(88)).derivePath(
        "m/44'/1899'/0'",
      )
      const sdk = new Wallet(hd.seckey(), chronik, hd, 0, 'ectest')
      sdk.utxos = [
        {
          outpoint: { txid: '58'.repeat(32), outIdx: 0 },
          sats: 100000n,
          blockHeight: 800000,
          isCoinbase: false,
          isFinal: true,
          address: sdk.getReceiveAddress(0),
        },
      ]
      const tx = new EcashSdkBackend(
        sdk,
        chronik,
        'ectest',
      ).buildNativeConstruction({
        recipient: destination.address,
        value: 7000n,
        excludedInputs: [],
      }).transactions[0]
      await first.recordStealthPayment({
        chainIdentifier: 'xec-testnet',
        ephemeralPubKey: destination.ephemeralPubKey,
        claimedAmount: 7000n,
        transactions: [tx.rawTransaction],
        payloadDigest: 'ab'.repeat(32),
        timestamp: 100,
      })
      expect(await first.getBalance()).toBe(0n)
      const retainedFactory = factoryOptions!.ecashWalletFactory!
      await f.session.yieldCustody()
      await expect(first.getBalance()).rejects.toThrow()
      expect(f.copies.every(copy => copy.every(byte => byte === 0))).toBe(true)
      const next = realIdentityFixture(historical)
      await next.session.initialize()
      coins.push({
        outpoint: { txid: tx.txid, outIdx: 0 },
        sats: 7000n,
        blockHeight: 800000,
        isCoinbase: false,
        isFinal: true,
      })
      const reopened = (await next.session.createUtxoWallet(
        relay,
      )) as InstanceType<typeof EcashWallet>
      expect(reopened.identity).toEqual(first.identity)
      expect(broadcasts).toEqual([])
      expect(await reopened.getBalance()).toBe(7000n)
      const operation = await reopened.prepareNativeOperation({
        operationId: 'session-respend',
        recipient: {
          raw: Address.p2pkh(new Uint8Array(20).fill(31), 'ectest').toString(),
        },
        value: 1000n,
        maxFee: 1000n,
      })
      expect(operation.inputs).toEqual([
        { txid: tx.txid, vout: 0, satoshis: '7000' },
      ])
      const signed = Tx.fromHex(operation.transactions[0].rawTransaction)
      signed.inputs[0].signData = {
        sats: 7000n,
        outputScript: destinationScript,
      }
      const signature = signed.inputs[0].script.bytecode.slice(1, 65)
      const digest = sha256d(
        UnsignedTx.fromTx(signed).inputAt(0).sigHashPreimage(ALL_BIP143).bytes,
      )
      new Ecc().schnorrVerify(
        signature,
        digest,
        Buffer.from(destination.publicKey, 'hex'),
      )
      expect(
        typeof (reopened as unknown as Record<string, unknown>)
          .withDerivedStealthSecret,
      ).toBe('undefined')
      expect(JSON.stringify(next.session.state)).not.toMatch(
        /"(?:private|bytes|seed|secret)":/,
      )
      expect(retainedFactory).not.toBe(factoryOptions!.ecashWalletFactory)
      await next.session.close()
      await expect(reopened.getBalance()).rejects.toThrow()
      await f.session.close()
    },
  )
  test.each(['yield', 'invalidate', 'close'] as const)(
    'private eCash callback binds identity/chain, wipes temporary secrets and revokes on %s',
    async lifecycle => {
      const f = realIdentityFixture()
      await f.session.initialize()
      let captured: EcashStealthCustody | undefined
      const original = ecashSeedBoundary.createEcashStealthSeedBackend
      const spy = jest
        .spyOn(ecashSeedBoundary, 'createEcashStealthSeedBackend')
        .mockImplementation(custody => {
          captured = custody
          return original(custody)
        })
      try {
        await f.session.createUtxoWallet({
          chain: { chainIdentifier: 'xec-testnet' } as RelayUtxoChain['chain'],
          createWallet: async () => f.wallet,
          close: async () => undefined,
        })
      } finally {
        spy.mockRestore()
      }
      const derivation = {
        chainIdentifier: 'xec-testnet',
        identityPublicKey: hex(f.identity.compressedPubKey),
        ephemeralPubKey: hex(
          secp256k1.getPublicKey(new Uint8Array(32).fill(17), true),
        ),
      }
      for (const bad of [
        { ...derivation, chainIdentifier: 'xec-mainnet' },
        { ...derivation, identityPublicKey: derivation.ephemeralPubKey },
        { ...derivation, ephemeralPubKey: '00'.repeat(33) },
      ]) {
        const callback = jest.fn()
        await expect(
          captured!.withDerivedStealthSecret(bad, callback),
        ).rejects.toThrow()
        expect(callback).not.toHaveBeenCalled()
      }
      let temporary: Uint8Array | undefined
      await captured!.withDerivedStealthSecret(derivation, secret => {
        temporary = secret
        expect(secret.some(byte => byte !== 0)).toBe(true)
      })
      expect(temporary!.every(byte => byte === 0)).toBe(true)
      await expect(
        captured!.withDerivedStealthSecret(derivation, secret => {
          temporary = secret
          throw new Error('import interrupted')
        }),
      ).rejects.toThrow('import interrupted')
      expect(temporary!.every(byte => byte === 0)).toBe(true)
      if (lifecycle === 'invalidate') {
        await expect(
          captured!.withDerivedStealthSecret(derivation, secret => {
            temporary = secret
            f.invalidate()
          }),
        ).rejects.toThrow()
        expect(temporary!.every(byte => byte === 0)).toBe(true)
      }
      if (lifecycle === 'yield') await f.session.yieldCustody()
      else if (lifecycle === 'invalidate') f.invalidate()
      else await f.session.close()
      const callback = jest.fn()
      expect(() => captured!.assertActive()).toThrow()
      await expect(
        captured!.withDerivedStealthSecret(derivation, callback),
      ).rejects.toThrow()
      expect(callback).not.toHaveBeenCalled()
      expect(f.copies.every(copy => copy.every(byte => byte === 0))).toBe(true)
      await f.session.close()
    },
  )
  test.each([false, true])(
    'public Chronik close synchronously revokes session-ready custody and actual SDK signing (historical=%s)',
    async historical => {
      const { openRelayUtxoChain } = jest.requireActual(
        '@frank/wallet/chain/utxo-family',
      )
      const { createRequire } = jest.requireActual('node:module')
      const walletRequire = createRequire(
        require.resolve('@frank/wallet/chain/utxo-family'),
      )
      const { ChronikClient } = jest.requireActual(
        walletRequire.resolve('chronik-client'),
      )
      const { Address, Ecc, Tx } = jest.requireActual('ecash-lib')
      const { ECASH_TESTNET_CHECKPOINT_HASH } = jest.requireActual(
        '@frank/wallet/ecash-wallet',
      )
      const { InMemoryNativeTransactionAttemptStore } = jest.requireActual(
        '@frank/wallet/chain/chain-wallet',
      )
      let captured: EcashStealthCustody | undefined
      let backend:
        | import('@frank/wallet/ecash-sdk-backend').EcashSdkBackend
        | undefined
      let pkh = ''
      const proto = ChronikClient.prototype
      const networkSpies = [
        jest
          .spyOn(proto, 'script')
          .mockImplementation((_type: string, payload: string) => ({
            utxos: async () => ({
              outputScript: '76a914' + payload + '88ac',
              utxos: [],
            }),
          })),
        jest.spyOn(proto, 'block').mockImplementation(async () => ({
          blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH },
        })),
        jest
          .spyOn(proto, 'blockchainInfo')
          .mockImplementation(async () => ({ tipHeight: 900000 })),
        jest
          .spyOn(proto, 'batchSummary')
          .mockImplementation(async (scripts: { payload: string }[]) =>
            scripts.map(script => ({
              numTxs: script.payload === pkh ? 1 : 0,
              numUtxos: script.payload === pkh ? 1 : 0,
            })),
          ),
        jest
          .spyOn(proto, 'batchUtxos')
          .mockImplementation(async (scripts: { payload: string }[]) =>
            scripts.map(script => ({
              utxos: {
                outputScript: '76a914' + script.payload + '88ac',
                utxos:
                  script.payload === pkh
                    ? [
                        {
                          outpoint: { txid: '71'.repeat(32), outIdx: 0 },
                          sats: 10000n,
                          blockHeight: 800000,
                          isCoinbase: false,
                          isFinal: true,
                        },
                      ]
                    : [],
              },
            })),
          ),
      ]
      let constructionParams:
        | Parameters<import('@frank/wallet/ecash-wallet').EcashWalletFactory>[0]
        | Parameters<
            import('@frank/wallet/ecash-wallet').EcashBip39WalletFactory
          >[0]
        | undefined
      const remember = (
        result: import('@frank/wallet/ecash-sdk-backend').EcashSdkBackend,
      ) => {
        backend = result
        pkh = Address.fromCashAddress(result.getReceiveAddress(0))
          .toScript()
          .toHex()
          .slice(6, 46)
        return result
      }
      const domainFactory = ecashSeedBoundary.createEcashStealthSeedBackend
      const historicalFactory =
        ecashSeedBoundary.createEcashStealthBip39SeedBackend
      const factorySpy = historical
        ? jest
            .spyOn(ecashSeedBoundary, 'createEcashStealthBip39SeedBackend')
            .mockImplementation(custody => {
              captured = custody
              const factory = historicalFactory(custody)
              return async params => {
                constructionParams = params
                return remember(await factory(params))
              }
            })
        : jest
            .spyOn(ecashSeedBoundary, 'createEcashStealthSeedBackend')
            .mockImplementation(custody => {
              captured = custody
              const factory = domainFactory(custody)
              return async params => {
                constructionParams = params
                return remember(await factory(params))
              }
            })
      const f = realIdentityFixture(historical)
      const relay: RelayUtxoChain = openRelayUtxoChain({
        chainIdentifier: 'xec-testnet',
        relayBaseUrl: 'http://127.0.0.1:1',
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      })
      let retainedOptions: Parameters<RelayUtxoChain['createWallet']>[1]
      const create = relay.createWallet.bind(relay)
      relay.createWallet = (material, options) => {
        retainedOptions = options
        return create(material, options)
      }
      let signingSpy: jest.SpyInstance | undefined
      try {
        await f.session.initialize()
        const wallet = (await f.session.createUtxoWallet(
          relay,
        )) as import('@frank/wallet/ecash-wallet').EcashWallet
        expect(await wallet.getBalance()).toBe(10000n)
        const descriptor = {
          chainIdentifier: 'xec-testnet',
          identityPublicKey: hex(f.identity.compressedPubKey),
          ephemeralPubKey: hex(
            secp256k1.getPublicKey(new Uint8Array(32).fill(17), true),
          ),
        }
        const destination = await backend!.describeStealthDerivation(descriptor)
        const recipient = Address.p2pkh(
          new Uint8Array(20).fill(31),
          'ectest',
        ).toString()
        const construction = backend!.buildNativeConstruction({
          recipient,
          value: 1000n,
          excludedInputs: [],
        })
        expect(
          Tx.fromHex(construction.transactions[0].rawTransaction).inputs[0]
            .script.bytecode.length,
        ).toBeGreaterThan(64)
        signingSpy = jest.spyOn(Ecc.prototype, 'schnorrSign')
        const closing = relay.close()
        expect(f.session.state.status).toBe('ready')
        const blocked: Record<string, boolean> = {}
        try {
          captured!.assertActive()
          blocked.assertActive = false
        } catch {
          blocked.assertActive = true
        }
        const callback = jest.fn()
        await captured!.withDerivedStealthSecret(descriptor, callback).then(
          () => {
            blocked.derive = false
          },
          () => {
            blocked.derive = true
          },
        )
        await backend!.importStealthDerivation(descriptor, destination).then(
          () => {
            blocked.import = false
          },
          () => {
            blocked.import = true
          },
        )
        try {
          backend!.buildNativeConstruction({
            recipient,
            value: 1000n,
            excludedInputs: [],
          })
          blocked.sign = false
        } catch {
          blocked.sign = true
        }
        await wallet
          .prepareNativeOperation({
            operationId: 'after-relay-close',
            recipient: { raw: recipient },
            value: 1000n,
          })
          .then(
            () => {
              blocked.prepare = false
            },
            () => {
              blocked.prepare = true
            },
          )
        await f.session.createUtxoWallet(relay).then(
          () => {
            blocked.create = false
          },
          () => {
            blocked.create = true
          },
        )
        const retainedFactory = historical
          ? retainedOptions!.ecashBip39WalletFactory!
          : retainedOptions!.ecashWalletFactory!
        await retainedFactory(constructionParams as never).then(
          () => {
            blocked.factory = false
          },
          () => {
            blocked.factory = true
          },
        )
        expect(blocked).toEqual({
          assertActive: true,
          derive: true,
          import: true,
          sign: true,
          prepare: true,
          create: true,
          factory: true,
        })
        expect(callback).not.toHaveBeenCalled()
        expect(signingSpy).not.toHaveBeenCalled()
        await closing
      } finally {
        signingSpy?.mockRestore()
        factorySpy.mockRestore()
        networkSpies.forEach(spy => spy.mockRestore())
        await relay.close()
        await f.session.close()
      }
    },
  )
})

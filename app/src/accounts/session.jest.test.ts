import {
  AccountBackupUnavailableError,
  accountSession,
  createAccountSession,
  importBip39Wallet,
  Bip39ImportUnavailableError,
  resetAccountStorage,
  type RuntimeWallet,
} from './session'
import { toRaw, watch } from 'vue'
import { importBip39Wallet as legacyImport } from './legacy'
import { activeChain } from '@frank/wallet/chain'
import {
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type PublicAccount,
} from './custody'
import { DOMAIN_PURPOSES, DERIVATION_REGISTRY_ID } from '@frank/domain-roots'

jest.mock('@frank/wallet/chain', () => {
  const actual = jest.requireActual('@frank/wallet/chain')
  return {
    ...actual,
    activeChain: { createWallet: jest.fn(), isTestnet: true },
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
    stage: jest.fn(),
    activate: jest.fn(),
    cancel: jest.fn(),
    close: jest.fn(),
  } as unknown as jest.Mocked<AccountCustody>
  const wallet = {
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
  expect(f.createWallet).not.toHaveBeenCalled()
  expect(f.custody.activate).not.toHaveBeenCalled()
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

describe('BIP39 public capability containment', () => {
  const phrase = 'test test test test test test test test test test test junk'
  const path = "m/44'/60'/1'/0/0"
  test.each(['fresh', 'ready', 'locked', 'unavailable', 'pending'] as const)(
    'refuses both public entry points without effects in %s state',
    async status => {
      const raw = toRaw(accountSession.state)
      const original = { ...raw }
      const records = new Map([
        ['custody', 'EXISTING CUSTODY BYTES'],
        ['pending', 'EXISTING PENDING BYTES'],
        ['journal', 'EXISTING JOURNAL BYTES'],
      ])
      const before = new Map(records)
      const account = {
        displayName: 'Existing',
        descriptor: 'PUBLIC',
        receipt: {
          operationId: 'existing',
          context: { accountId: 'existing' },
        },
      } as PublicAccount
      const pending =
        status === 'pending' || status === 'locked'
          ? ({
              status: 'staging',
              account,
              expectedActive: { revision: 7, accountId: 'existing' },
            } as const)
          : null
      const snapshot = {
        schema: 1,
        revision: 7,
        active: account,
        pending,
      } as CustodySnapshot
      Object.assign(raw, {
        status,
        revision: 7,
        account: status === 'fresh' ? null : account,
        pending,
      })
      const stateBefore = JSON.stringify(raw)
      const spies = [
        jest.spyOn(accountSession, 'initialize').mockResolvedValue(undefined),
        jest.spyOn(accountSession, 'snapshot').mockResolvedValue(snapshot),
        jest.spyOn(accountSession, 'reset').mockImplementation(async () => {
          records.clear()
        }),
        jest.spyOn(accountSession, 'stage').mockImplementation(async () => {
          records.set('pending', 'REPLACED')
        }),
        jest
          .spyOn(accountSession, 'activatePending')
          .mockImplementation(async () => {
            records.set('custody', 'REPLACED')
          }),
        jest
          .spyOn(accountSession, 'getWallet')
          .mockResolvedValue({} as RuntimeWallet),
      ]
      const databaseDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        'indexedDB',
      )
      const deleteDatabase = jest.fn()
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: { deleteDatabase },
      })
      jest.mocked(activeChain.createWallet).mockClear()
      try {
        for (const invoke of [importBip39Wallet, legacyImport]) {
          const failure = await invoke(phrase, path).then(
            () => undefined,
            error => error,
          )
          expect(failure).toMatchObject({ code: 'bip39-import-unavailable' })
          expect(failure).toBeInstanceOf(Bip39ImportUnavailableError)
        }
        for (const spy of spies) expect(spy).not.toHaveBeenCalled()
        expect(activeChain.createWallet).not.toHaveBeenCalled()
        expect(deleteDatabase).not.toHaveBeenCalled()
        expect(records).toEqual(before)
        expect(raw.status).toBe(status)
        expect(raw.revision).toBe(7)
        expect(JSON.stringify(raw)).toBe(stateBefore)
      } finally {
        Object.assign(raw, original)
        spies.forEach(spy => spy.mockRestore())
        if (databaseDescriptor)
          Object.defineProperty(globalThis, 'indexedDB', databaseDescriptor)
        else Reflect.deleteProperty(globalThis, 'indexedDB')
      }
    },
  )
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
          .spyOn(f.session, 'getActiveDomainRoot')
          .mockReturnValueOnce(a.promise)
          .mockReturnValueOnce(b.promise)
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
      .spyOn(f.session, 'getActiveDomainRoot')
      .mockReturnValueOnce(a.promise)
    const read = derivation(f, path)
    const failure = new Error('synthetic derivation failure')
    a.reject(failure)
    await expect(read.read()).rejects.toBe(failure)
    const pending = deferred<Uint8Array>()
    roots.mockReturnValueOnce(pending.promise)
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

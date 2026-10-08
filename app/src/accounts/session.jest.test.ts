import {
  accountSession,
  createAccountSession,
  importBip39Wallet,
  resetAccountStorage,
  type RuntimeWallet,
} from './session'
import { toRaw, watch } from 'vue'
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
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
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

test('getActiveWalletRoot and backupCodex32 split active wallet root into 2-of-3 shares', async () => {
  const f = fixture()
  await f.session.initialize()
  const root = await f.session.getActiveWalletRoot()
  expect(root).toBeInstanceOf(Uint8Array)
  expect(root.length).toBe(32)

  const shares = await f.session.backupCodex32(2, 3)
  expect(shares).toHaveLength(3)
  for (const share of shares) {
    expect(share.startsWith('ms12frnk')).toBe(true)
    expect(share.length).toBe(127)
  }
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

test('importBip39Wallet recovers and successfully imports when initial custody throws locked error', async () => {
  const phrase = 'test test test test test test test test test test test junk'
  const resetSpy = jest
    .spyOn(accountSession, 'reset')
    .mockImplementation(async () => undefined)
  const snapshotSpy = jest
    .spyOn(accountSession, 'snapshot')
    .mockRejectedValueOnce(new CustodyError('locked'))
    .mockResolvedValue({
      schema: 1,
      revision: 0,
      active: null,
      pending: null,
    })
  const stageSpy = jest
    .spyOn(accountSession, 'stage')
    .mockImplementation(async () => undefined)
  const activateSpy = jest
    .spyOn(accountSession, 'activatePending')
    .mockImplementation(async () => undefined)
  const getWalletSpy = jest
    .spyOn(accountSession, 'getWallet')
    .mockResolvedValue({
      identity: {
        address: { raw: '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650' },
      },
    } as unknown as RuntimeWallet)

  try {
    const result = await importBip39Wallet(phrase)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(snapshotSpy).toHaveBeenCalledTimes(2)
    expect(stageSpy).toHaveBeenCalledTimes(1)
    expect(activateSpy).toHaveBeenCalledTimes(1)
    expect(result.address).toBe('0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650')
  } finally {
    resetSpy.mockRestore()
    snapshotSpy.mockRestore()
    stageSpy.mockRestore()
    activateSpy.mockRestore()
    getWalletSpy.mockRestore()
  }
})

test('importBip39Wallet recovers and successfully imports when initial status is locked or unavailable', async () => {
  const phrase = 'test test test test test test test test test test test junk'
  const rawState = toRaw(accountSession.state) as { status: string }
  const origStatus = rawState.status
  rawState.status = 'locked'

  const resetSpy = jest
    .spyOn(accountSession, 'reset')
    .mockImplementation(async () => {
      rawState.status = 'fresh'
    })
  const snapshotSpy = jest.spyOn(accountSession, 'snapshot').mockResolvedValue({
    schema: 1,
    revision: 0,
    active: null,
    pending: null,
  })
  const stageSpy = jest
    .spyOn(accountSession, 'stage')
    .mockImplementation(async () => undefined)
  const activateSpy = jest
    .spyOn(accountSession, 'activatePending')
    .mockImplementation(async () => undefined)
  const getWalletSpy = jest
    .spyOn(accountSession, 'getWallet')
    .mockResolvedValue({
      identity: {
        address: { raw: '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650' },
      },
    } as unknown as RuntimeWallet)

  try {
    const result = await importBip39Wallet(phrase)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(snapshotSpy).toHaveBeenCalledTimes(1)
    expect(stageSpy).toHaveBeenCalledTimes(1)
    expect(activateSpy).toHaveBeenCalledTimes(1)
    expect(result.address).toBe('0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650')
  } finally {
    rawState.status = origStatus
    resetSpy.mockRestore()
    snapshotSpy.mockRestore()
    stageSpy.mockRestore()
    activateSpy.mockRestore()
    getWalletSpy.mockRestore()
  }
})

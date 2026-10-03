import { createAccountSession, type RuntimeWallet } from './session'
import {
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type PublicAccount,
} from './custody'
import { DOMAIN_PURPOSES, DERIVATION_REGISTRY_ID } from '@frank/domain-roots'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: { createWallet: jest.fn() },
}))

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
  } as unknown as RuntimeWallet
  const createWallet = jest.fn(async () => wallet)
  const session = createAccountSession({
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
    set: (next: CustodySnapshot) => {
      snapshot = next
    },
    account,
  }
}
test('opens the active capability once, maps the typed roots, wipes owned copies and shares a stable wallet promise', async () => {
  const f = fixture()
  await Promise.all([f.session.initialize(), f.session.initialize()])
  expect(f.capability.takeRoots).toHaveBeenCalledTimes(1)
  expect(f.createWallet.mock.calls[0][0]).toMatchObject({
    evm: { purpose: 'evm-wallet' },
    authentication: { purpose: 'identity-authentication' },
    messaging: { purpose: 'messaging-encryption' },
  })
  expect(f.owned.every(root => root.bytes.every(byte => byte === 0))).toBe(true)
  expect(f.session.getWallet()).toBe(f.session.getWallet())
  expect(await f.session.getWallet()).toBe(f.wallet)
  expect(JSON.stringify(f.session.state)).not.toMatch(
    /bytes|roots|private|mnemonic/,
  )
  await f.session.close()
  expect(f.wallet.close).toHaveBeenCalledTimes(1)
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
  expect(f.session.state.status).toBe('locked')
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
  expect(() => f.session.getWallet()).toThrow()
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
  expect(() => f.session.getWallet()).toThrow()
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
  expect(() => f.session.getWallet()).toThrow()
})

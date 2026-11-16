/** Synthetic public factory boundaries; no custody, filesystem, RPC or relay is opened. */
const mockDirectoryClose = jest.fn()
const mockWalletClose = jest.fn()
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs')
  return { ...actual,
    existsSync: (path: import('fs').PathLike) => String(path).startsWith('/inert/') || actual.existsSync(path),
    mkdirSync: (path: import('fs').PathLike, options: import('fs').MakeDirectoryOptions) => String(path).startsWith('/inert/') ? undefined : actual.mkdirSync(path, options),
    readFileSync: (path: import('fs').PathLike, options: BufferEncoding) => String(path).startsWith('/inert/') ? '11'.repeat(32) : actual.readFileSync(path, options),
  }
})
jest.mock('@frank/wallet/chain/evm-host', () => ({ createRelayPricedEvmChain: () => ({
  createWallet: async () => ({ identity: { address: { raw: 'identity' } }, getReceiveAddress: async () => ({ raw: 'main' }), close: () => mockWalletClose() }),
}) }))
jest.mock('@frank/wallet/chain/evm-chain', () => ({ loadMonadChainConfigFromEnv: () => ({}), installCanonicalDirectory: jest.fn() }))
jest.mock('@frank/wallet/chain/canonical-dm', () => ({ installMessageItemRegistry: jest.fn() }))
jest.mock('@frank/bot-framework/directory-manager', () => ({ DirectoryManager: { create: () => ({
  rawDirectory: {}, publishWithRetry: async () => undefined, close: () => mockDirectoryClose(),
}) } }))
jest.mock('@frank/bot-framework/relay-profile-manager', () => ({ RelayProfileManager: { registerProfile: async () => undefined } }))

import { openRealWallet } from './real-stack'

beforeEach(() => jest.resetAllMocks())

it('awaits wallet closure even after synchronous directory failure, retaining both causes', async () => {
  const directoryFailure = new Error('directory failed')
  const walletFailure = new Error('wallet failed')
  mockDirectoryClose.mockImplementation(() => { throw directoryFailure })
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  mockWalletClose.mockImplementation(() => new Promise<void>((_resolve, reject) => {
    entered()
    release = () => reject(walletFailure)
  }))
  const wallet = await openRealWallet({ label: 'inert', stateDir: '/inert', relayUrl: 'http://inert',
    network: { rpcChain: 'monad-regtest', networkTag: 'MONR' } })
  let finished = false
  const outcome = wallet.close().catch(error => { finished = true; return error as AggregateError })
  await waiting
  expect(finished).toBe(false)
  release()
  const error = await outcome
  if (!(error instanceof AggregateError)) throw new Error('Expected observable close failure')
  expect(error.errors).toEqual([directoryFailure, walletFailure])
  expect(mockDirectoryClose).toHaveBeenCalledTimes(1)
  expect(mockWalletClose).toHaveBeenCalledTimes(1)
})

it('preserves successful directory and wallet closure', async () => {
  mockDirectoryClose.mockResolvedValue(undefined)
  mockWalletClose.mockResolvedValue(undefined)
  const wallet = await openRealWallet({ label: 'inert', stateDir: '/inert', relayUrl: 'http://inert',
    network: { rpcChain: 'monad-regtest', networkTag: 'MONR' } })
  await expect(wallet.close()).resolves.toBeUndefined()
  expect(mockDirectoryClose).toHaveBeenCalledTimes(1)
  expect(mockWalletClose).toHaveBeenCalledTimes(1)
})

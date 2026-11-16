/** Public startRealStack/stop boundary with inert factories: no .env, custody, RPC or process launch. */
const mockProviderDestroy = jest.fn()
const mockRelayStop = jest.fn()
const mockSupervisorStart = jest.fn()
const mockCreateWallet = jest.fn()
const mockFinancial = jest.fn()
const mockRawWallet = jest.fn((..._args: unknown[]) => { throw new Error('Unexpected raw financial signer') })

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs')
  const inert = (path: import('fs').PathLike) => String(path).startsWith('/inert-real-stack/')
  return { ...actual,
    existsSync: (path: import('fs').PathLike) => inert(path) || actual.existsSync(path),
    mkdirSync: (path: import('fs').PathLike, options: import('fs').MakeDirectoryOptions) => inert(path) ? undefined : actual.mkdirSync(path, options),
    readFileSync: (path: import('fs').PathLike, options: BufferEncoding) => inert(path)
      ? String(path).endsWith('account-root.hex') ? '11'.repeat(32) : Buffer.alloc(0)
      : actual.readFileSync(path, options),
    statSync: (path: import('fs').PathLike) => inert(path) ? { size: 0 } : actual.statSync(path),
  }
})
jest.mock('ethers', () => ({ ...jest.requireActual('ethers'),
  JsonRpcProvider: class {
    destroy() { return mockProviderDestroy() }
    getBalance(...args: unknown[]) { return mockFinancial(...args) }
    send(...args: unknown[]) { return mockFinancial(...args) }
  },
  Wallet: class { constructor(...args: unknown[]) { mockRawWallet(...args) } },
}))
jest.mock('./chain-rpc', () => ({ chainId: async () => 10143n, rpcUrlList: () => ['http://rpc.invalid'] }))
jest.mock('./env-file', () => ({ readEnvFile: () => { throw new Error('Unexpected environment file read') } }))
jest.mock('./supervisor', () => ({ Supervisor: class {
  start(...args: unknown[]) { return mockSupervisorStart(...args) }
  stopAll() { return mockRelayStop() }
} }))
jest.mock('@frank/wallet/chain/evm-host', () => ({ createRelayPricedEvmChain: () => ({
  createWallet: (...args: unknown[]) => mockCreateWallet(...args),
}) }))
jest.mock('@frank/wallet/chain/evm-chain', () => ({ loadMonadChainConfigFromEnv: () => ({}), installCanonicalDirectory: jest.fn() }))
jest.mock('@frank/wallet/chain/canonical-dm', () => ({ installMessageItemRegistry: jest.fn() }))
jest.mock('@frank/bot-framework/directory-manager', () => ({ DirectoryManager: { create: () => ({
  rawDirectory: {}, publishWithRetry: async () => undefined, close: async () => undefined,
}) } }))
jest.mock('@frank/bot-framework/relay-profile-manager', () => ({ RelayProfileManager: { registerProfile: async () => undefined } }))

import { startRealStack } from './real-stack'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  jest.resetAllMocks()
  mockProviderDestroy.mockReturnValue(undefined)
  mockRelayStop.mockResolvedValue(undefined)
  mockSupervisorStart.mockReturnValue({ hasExited: () => false })
  mockCreateWallet.mockImplementation(async () => ({
    identity: { address: { raw: 'synthetic-identity' } }, getReceiveAddress: async () => ({ raw: 'synthetic-main' }),
    close: async () => undefined, sendLegacy: mockFinancial,
  }))
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
  // Capture ownership without adding or removing real process listeners.
  jest.spyOn(process, 'on').mockImplementation(() => process)
  jest.spyOn(process, 'off').mockImplementation(() => process)
})
afterEach(() => jest.restoreAllMocks())

const open = (externalRelay = false) => startRealStack({
  env: { MONAD_TESTNET_HTTP_RPC_URL: 'http://rpc.invalid' }, stateDir: '/inert-real-stack',
  ...(externalRelay ? { relayUrl: 'http://relay.invalid' } : {}),
})

it('attempts every teardown after synchronous failure, waits for wallets, and caches all original failures', async () => {
  const stack = await open()
  const first = await stack.openWallet('first')
  const second = await stack.openWallet('second')
  const firstFailure = new Error('first wallet synchronous failure')
  const secondFailure = new Error('second wallet delayed failure')
  const providerFailure = new Error('provider destroy failure')
  const relayFailure = new Error('relay stop failure')
  const signalFailure = new Error('signal removal failure')
  const entered = deferred()
  const gate = deferred()
  const firstClose = jest.spyOn(first, 'close').mockImplementation(() => { throw firstFailure })
  const secondClose = jest.spyOn(second, 'close').mockImplementation(async () => {
    entered.resolve()
    await gate.promise
    throw secondFailure
  })
  mockProviderDestroy.mockImplementation(() => { throw providerFailure })
  mockRelayStop.mockRejectedValue(relayFailure)
  const off = jest.mocked(process.off).mockImplementation(signal => {
    if (signal === 'SIGINT') throw signalFailure
    return process
  })
  const financial = [jest.spyOn(stack, 'fund'), jest.spyOn(stack, 'sweep'), jest.spyOn(stack, 'finish')]
  let completed = false
  const stopping = stack.stop()
  const outcome = stopping.then(() => { completed = true }, error => { completed = true; return error as AggregateError })
  try {
    expect(stack.stop()).toBe(stopping)
    // If teardown aborts before the second wallet, fail immediately rather than await a dead barrier.
    await Promise.race([entered.promise, outcome])
    expect(secondClose).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
    expect(mockProviderDestroy).not.toHaveBeenCalled()
    expect(mockRelayStop).not.toHaveBeenCalled()
    expect(off).not.toHaveBeenCalled()
    gate.resolve()
    const error = await outcome
    if (!(error instanceof AggregateError)) throw new Error('Expected observable complete teardown failure')
    expect(error.errors).toEqual([firstFailure, secondFailure, providerFailure, relayFailure, signalFailure])
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(secondClose).toHaveBeenCalledTimes(1)
    expect(mockProviderDestroy).toHaveBeenCalledTimes(1)
    expect(mockRelayStop).toHaveBeenCalledTimes(1)
    expect(off.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
    expect(stack.stop()).toBe(stopping)
    await expect(stack.stop()).rejects.toBe(error)
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(mockProviderDestroy).toHaveBeenCalledTimes(1)
    for (const call of financial) expect(call).not.toHaveBeenCalled()
    expect(mockRawWallet).not.toHaveBeenCalled()
    expect(mockFinancial).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
    await stopping.catch(() => undefined)
  }
})

it('does not turn an asynchronous wallet-close failure into successful stop', async () => {
  const stack = await open()
  const first = await stack.openWallet('first')
  const second = await stack.openWallet('second')
  const failure = new Error('wallet close rejected')
  const firstClose = jest.spyOn(first, 'close').mockRejectedValue(failure)
  const secondClose = jest.spyOn(second, 'close').mockResolvedValue(undefined)
  const result = await stack.stop().catch(error => error as AggregateError)
  if (!(result instanceof AggregateError)) throw new Error('Wallet failure must remain observable')
  expect(result.errors).toEqual([failure])
  expect(firstClose).toHaveBeenCalledTimes(1)
  expect(secondClose).toHaveBeenCalledTimes(1)
  expect(mockProviderDestroy).toHaveBeenCalledTimes(1)
  expect(mockRelayStop).toHaveBeenCalledTimes(1)
})

it.each([false, true])('preserves successful stop and relay ownership (external relay=%s)', async externalRelay => {
  const stack = await open(externalRelay)
  const wallet = await stack.openWallet('only')
  const close = jest.spyOn(wallet, 'close')
  const stopping = stack.stop()
  await expect(stopping).resolves.toBeUndefined()
  expect(stack.stop()).toBe(stopping)
  await expect(stack.stop()).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledTimes(1)
  expect(mockProviderDestroy).toHaveBeenCalledTimes(1)
  expect(mockRelayStop).toHaveBeenCalledTimes(externalRelay ? 0 : 1)
  expect(mockSupervisorStart).toHaveBeenCalledTimes(externalRelay ? 0 : 1)
  expect(process.off).toHaveBeenCalledTimes(3)
  expect(mockRawWallet).not.toHaveBeenCalled()
  expect(mockFinancial).not.toHaveBeenCalled()
})

const mockEnsure = jest.fn()
const mockStart = jest.fn()
const mockFund = jest.fn()
const mockReturn = jest.fn()
const mockClose = jest.fn(async () => undefined)
const mockDestroy = jest.fn()
const mockStop = jest.fn(async () => undefined)
const mockGateClose = jest.fn((done: () => void) => done())
const mockOpen = jest.fn(async (label: string) => ({ label, close: mockClose }))
const mockMonad = { faucetAddress: '0x' + '22'.repeat(20), faucet: { connect: () => ({ fixture: 'public-dev-faucet' }) } }
jest.mock('ethers', () => ({
  FetchRequest: Object.assign(jest.fn(), { createGetUrlFunc: () => jest.fn() }),
  JsonRpcProvider: jest.fn(() => ({ destroy: mockDestroy })),
}))
jest.mock('net', () => ({ createServer: () => ({ once: jest.fn(), listen: (_p: number, _h: string, done: () => void) => done(), close: mockGateClose }) }))
jest.mock('./regtest-chain', () => ({ freePort: async () => 49999 }))
jest.mock('./monad-regtest', () => ({
  MONAD_REGTEST_CHAIN: 'monad-regtest', MONAD_REGTEST_CHAIN_ID: 20143n, MONAD_REGTEST_NETWORK_TAG: 'MONR',
  ensureSolonet: (...args: unknown[]) => mockEnsure(...args), payAtFreshNonce: (...args: unknown[]) => mockFund(...args),
}))
jest.mock('./regtest-stack', () => ({ startRegtestStack: (...args: unknown[]) => mockStart(...args) }))
jest.mock('./monad-wallets', () => ({ monadOf: () => mockMonad, openMonadWallet: (_s: unknown, label: string) => mockOpen(label), returnToFaucet: (...args: unknown[]) => mockReturn(...args) }))
jest.mock('../real-stack', () => ({ openRealWallet: (options: {label: string}) => mockOpen(options.label), fundsLine: () => 'public return accounting' }))
import { startCheckStack } from './monad-parallel-send-stack'
const original = process.env.FRANK_SOLONET_RPC_URL
beforeEach(() => {
  jest.clearAllMocks()
  process.env.FRANK_SOLONET_RPC_URL = 'http://127.0.0.1:48090'
  mockEnsure.mockImplementation(async (env: NodeJS.ProcessEnv) => ({ rpcUrl: env.FRANK_SOLONET_RPC_URL ?? 'http://127.0.0.1:48080' }))
  mockStart.mockResolvedValue({ relayUrl: 'http://127.0.0.1:49001', stateDir: '/synthetic-owned/original-state', stop: mockStop })
  mockFund.mockResolvedValue('0x' + '33'.repeat(32))
  mockReturn.mockResolvedValue({ returnedWei: 9n, leftWei: 1n, unswept: 0, left: [{ wallet: 'original-state', account: 'change', address: '0x' + '44'.repeat(20), balanceWei: 1n, reason: 'below economical return fee' }] })
})
afterEach(() => { if (original === undefined) delete process.env.FRANK_SOLONET_RPC_URL; else process.env.FRANK_SOLONET_RPC_URL = original; delete process.env.PSEND_STATE_DIR })
it.each([true, false])('preserves explicit external selection and ordinary managed selection (external=%s)', async external => {
  if (!external) delete process.env.FRANK_SOLONET_RPC_URL
  const stack = await startCheckStack()
  expect(mockEnsure.mock.calls[0][0].FRANK_SOLONET_RPC_URL).toBe(external ? 'http://127.0.0.1:48090' : undefined)
  expect(stack.rpcUrl).toBe(external ? 'http://127.0.0.1:48090' : 'http://127.0.0.1:48080')
  expect(mockStart.mock.calls[0][0].env).toMatchObject({ FRANK_REGTEST_KEEP: '1', FRANK_SOLONET_RPC_URL: 'http://127.0.0.1:49999' })
  await stack.stop()
})
it('never retries external failure as managed or starts a stack after it', async () => {
  mockEnsure.mockRejectedValueOnce(new Error('external unavailable'))
  await expect(startCheckStack()).rejects.toThrow('external unavailable')
  expect(mockEnsure).toHaveBeenCalledTimes(1)
  expect(mockStart).not.toHaveBeenCalled()
})
it('attaches a killed child to original state without a second stack or funding authority', async () => {
  process.env.PSEND_STATE_DIR = '/synthetic-owned/original-state'
  const stack = await startCheckStack({ relayUrl: 'http://127.0.0.1:49001' })
  await expect(stack.fund('recipient', 1n)).rejects.toThrow('does not fund')
  expect(mockStart).not.toHaveBeenCalled()
  expect(stack.stateDir).toBe(process.env.PSEND_STATE_DIR)
  await stack.stop()
})
it('reuses existing funding helper once per obligation and returns through original state once', async () => {
  const stack = await startCheckStack()
  await stack.openWallet('alice')
  await stack.fund('recipient', 5n)
  expect(mockFund).toHaveBeenCalledTimes(1)
  expect(mockFund.mock.calls[0][1]).toEqual({ to: 'recipient', value: 5n, gasLimit: 21000n })
  mockReturn.mockImplementation(async source => {
    expect(mockClose).toHaveBeenCalledTimes(1)
    expect(mockDestroy).not.toHaveBeenCalled()
    expect(source.stateDir).toBe('/synthetic-owned/original-state')
    return { returnedWei: 9n, leftWei: 1n, unswept: 0, left: [{ wallet: 'original-state', account: 'change', address: 'public-address', balanceWei: 1n, reason: 'economic residual' }] }
  })
  const result = await stack.sweep()
  expect(result).toMatchObject({ returnedWei: 9n, floatWei: 0n, left: [{ balanceWei: 1n, reason: 'economic residual' }] })
  await stack.finish(); await stack.finish()
  expect(mockReturn).toHaveBeenCalledTimes(1)
  expect(mockStop).toHaveBeenCalledTimes(1)
})
it('blocks subsequent funding after an unknown original and fails return acceptance after cleanup', async () => {
  const stack = await startCheckStack()
  mockFund.mockRejectedValueOnce(new Error('unknown acknowledgement'))
  await expect(stack.fund('recipient', 5n)).rejects.toThrow('unknown acknowledgement')
  await expect(stack.fund('other', 5n)).rejects.toThrow('unresolved')
  expect(mockFund).toHaveBeenCalledTimes(1)
  await expect(stack.finish()).rejects.toThrow('unresolved')
  expect(mockStop).toHaveBeenCalledTimes(1)
  expect(mockDestroy).toHaveBeenCalledTimes(1)
})
it.each(['reject', 'unswept'])('propagates %s return failure after owned cleanup', async mode => {
  const stack = await startCheckStack()
  if (mode === 'reject') mockReturn.mockRejectedValueOnce(new Error('original state unreadable'))
  else mockReturn.mockResolvedValueOnce({ returnedWei: 0n, leftWei: 1n, unswept: 1, left: [] })
  await expect(stack.finish()).rejects.toThrow(mode === 'reject' ? 'unreadable' : 'unresolved')
  expect(mockStop).toHaveBeenCalledTimes(1)
  expect(mockGateClose).toHaveBeenCalledTimes(1)
})

it('closes only its owned gate/provider when native relay startup fails', async () => {
  mockStart.mockRejectedValueOnce(new Error('relay startup failed'))
  await expect(startCheckStack()).rejects.toThrow('relay startup failed')
  expect(mockGateClose).toHaveBeenCalledTimes(1)
  expect(mockDestroy).toHaveBeenCalledTimes(1)
  expect(mockFund).not.toHaveBeenCalled()
})
